const fs = require('fs');
const path = require('path');
const os = require('os');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const AUDIO_MIME_TYPES = new Set([
  'audio/webm',
  'video/webm',
  'audio/ogg',
  'video/ogg',
  'audio/wav',
  'audio/x-wav',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/x-m4a',
]);

const requiredEnv = () => ({
  accountId: process.env.R2_ACCOUNT_ID,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  bucket: process.env.R2_BUCKET_NAME,
  endpoint: process.env.R2_ENDPOINT || (process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : ''),
});

function isR2Configured() {
  const cfg = requiredEnv();
  return Boolean(cfg.accessKeyId && cfg.secretAccessKey && cfg.bucket && cfg.endpoint);
}

function isR2Enabled() {
  return String(process.env.AUDIO_STORAGE_DRIVER || '').toLowerCase() === 'r2' && isR2Configured();
}

function isR2MirrorEnabled() {
  return isR2Configured() && String(process.env.R2_MIRROR_LOCAL_UPLOADS || 'false').toLowerCase() === 'true';
}

let cachedClient = null;
function getR2Client({ allowMirror = false } = {}) {
  if (!isR2Enabled() && !(allowMirror && isR2Configured())) return null;
  if (cachedClient) return cachedClient;
  const cfg = requiredEnv();
  cachedClient = new S3Client({
    region: 'auto',
    endpoint: cfg.endpoint,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
    forcePathStyle: String(process.env.R2_FORCE_PATH_STYLE || 'false').toLowerCase() === 'true',
  });
  return cachedClient;
}

function sanitizePathPart(value = '') {
  return String(value || '')
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 128) || 'unknown';
}

function extensionForMime(mimeType = '') {
  const type = String(mimeType || '').toLowerCase();
  if (type.includes('ogg')) return 'ogg';
  if (type.includes('wav')) return 'wav';
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
  if (type.includes('mp4') || type.includes('m4a')) return 'm4a';
  return 'webm';
}

function validateAudioUpload({ mimeType, sizeBytes }) {
  const normalizedMime = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (!AUDIO_MIME_TYPES.has(normalizedMime)) {
    const err = new Error(`Unsupported audio MIME type: ${mimeType}`);
    err.status = 415;
    throw err;
  }
  const max = Number(process.env.MAX_FILE_SIZE || 25 * 1024 * 1024);
  if (Number(sizeBytes || 0) > max) {
    const err = new Error(`Audio chunk exceeds max size ${max} bytes`);
    err.status = 413;
    throw err;
  }
  return normalizedMime;
}

function buildR2Key({ userId, meetingId, chunkIndex, mimeType }) {
  const padded = String(Number(chunkIndex || 0)).padStart(6, '0');
  const timestamp = Date.now();
  return `voice/${sanitizePathPart(userId || 'local')}/${sanitizePathPart(meetingId)}/chunks/chunk_${padded}_${timestamp}.${extensionForMime(mimeType)}`;
}

async function createPresignedPutUrl({ userId, meetingId, chunkIndex, mimeType, sizeBytes, checksum }) {
  if (!isR2Enabled()) {
    const err = new Error('R2 storage is not enabled');
    err.status = 503;
    throw err;
  }
  const contentType = validateAudioUpload({ mimeType, sizeBytes });
  const client = getR2Client();
  const bucket = process.env.R2_BUCKET_NAME;
  const r2Key = buildR2Key({ userId, meetingId, chunkIndex, mimeType: contentType });
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: r2Key,
    ContentType: contentType,
    Metadata: checksum ? { checksum: String(checksum) } : undefined,
  });
  const expiresIn = Number(process.env.R2_PRESIGN_EXPIRES_SEC || 900);
  const uploadUrl = await getSignedUrl(client, command, { expiresIn });
  return {
    uploadUrl,
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    r2Key,
    bucket,
    expiresIn,
  };
}


async function uploadLocalFileToR2({ filePath, userId, meetingId, chunkIndex, mimeType, checksum }) {
  if (!isR2MirrorEnabled()) {
    const err = new Error('R2 mirror is not enabled');
    err.status = 503;
    throw err;
  }
  const stat = await fs.promises.stat(filePath);
  const contentType = validateAudioUpload({ mimeType, sizeBytes: stat.size });
  const client = getR2Client({ allowMirror: true });
  const bucket = process.env.R2_BUCKET_NAME;
  const r2Key = buildR2Key({ userId, meetingId, chunkIndex, mimeType: contentType });
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: r2Key,
    Body: fs.createReadStream(filePath),
    ContentLength: stat.size,
    ContentType: contentType,
    Metadata: checksum ? { checksum: String(checksum) } : undefined,
  });
  const result = await client.send(command);
  return {
    bucket,
    r2Key,
    eTag: result.ETag || '',
    sizeBytes: stat.size,
    contentType,
    r2Url: process.env.R2_PUBLIC_BASE_URL
      ? `${String(process.env.R2_PUBLIC_BASE_URL).replace(/\/$/, '')}/${r2Key}`
      : '',
  };
}

async function headR2Object(r2Key) {
  const client = getR2Client();
  if (!client) throw new Error('R2 storage is not enabled');
  const result = await client.send(new HeadObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: r2Key }));
  return {
    contentLength: Number(result.ContentLength || 0),
    contentType: result.ContentType || '',
    eTag: result.ETag || '',
    lastModified: result.LastModified || null,
    metadata: result.Metadata || {},
  };
}

async function downloadR2ObjectToTempFile(r2Key, preferredExt = 'webm') {
  const client = getR2Client();
  if (!client) throw new Error('R2 storage is not enabled');
  const safeExt = String(preferredExt || 'webm').replace(/[^a-z0-9]/gi, '') || 'webm';
  const tmpDir = path.join(os.tmpdir(), 'voicemind-r2');
  await fs.promises.mkdir(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, `${Date.now()}_${Math.random().toString(36).slice(2)}.${safeExt}`);
  const result = await client.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: r2Key }));
  const body = result.Body instanceof Readable ? result.Body : Readable.from(result.Body);
  await pipeline(body, fs.createWriteStream(tmpPath));
  return tmpPath;
}

module.exports = {
  isR2Enabled,
  isR2Configured,
  isR2MirrorEnabled,
  getR2Client,
  validateAudioUpload,
  createPresignedPutUrl,
  headR2Object,
  downloadR2ObjectToTempFile,
  uploadLocalFileToR2,
  extensionForMime,
};
