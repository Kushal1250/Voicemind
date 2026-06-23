//backend/src/routes/meetings.routes.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const mongoose = require('mongoose');
const Meeting = require('../models/Meeting');
const Transcript = require('../models/Transcript');
const Device = require('../models/Device');
const AudioChunk = require('../models/AudioChunk');
const { auth } = require('../middleware/auth');
const eventBus = require('../services/eventBus');
const {
  normalizeMeetingLanguage,
  resolveAudioLanguageFolder,
  getMeetingAudioDirectory,
  getLegacyMeetingDirectory,
  buildMeetingStorageMetadata,
  sanitizeMeetingId,
} = require('../utils/languageSupport');
const { transcribeAudioFile } = require('../services/transcribe.service');
const {
  isR2Enabled,
  isR2MirrorEnabled,
  uploadLocalFileToR2,
  createPresignedPutUrl,
  headR2Object,
  downloadR2ObjectToTempFile,
  extensionForMime,
} = require('../services/r2.service');
const {
  chooseBestTranscriptText,
  isUsableTranscript,
  hasKnownBadPlaceholder,
  selectValidatedFinalText,
  isSuspiciousShrinkage,
  assessTranscriptCandidate,
} = require('../utils/transcriptText');

const router = express.Router();
const DEFAULT_MAX_FILE_SIZE = 25 * 1024 * 1024;

const MIME_EXTENSION_MAP = {
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
  'audio/webm': '.webm',
  'video/webm': '.webm',
  'audio/ogg': '.ogg',
  'video/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'application/octet-stream': '.bin',
};

const SUPPORTED_AUDIO_MIME_TYPES = new Set(Object.keys(MIME_EXTENSION_MAP));

const isEsp32Request = (req) =>
  req.body?.source === 'esp32' ||
  !!req.headers['x-device-id'] ||
  req.query.source === 'esp32';

const requireAuthUnlessEsp32 = async (req, res, next) =>
  (isEsp32Request(req) ? next() : auth(req, res, next));

const isDeviceDrivenRequest = (req) => !!req.headers['x-device-id'];

const isFreshDevice = (device) => {
  if (!device || !device.lastSeenAt) return false;
  return Date.now() - new Date(device.lastSeenAt).getTime() <= 45000;
};

const normalizeWebConfig = (payload = {}) => ({
  audioMode: payload.audioMode === 'mic_system' ? 'mic_system' : 'mic',
  noiseReduction: payload.noiseReduction !== false && payload.noiseReduction !== 'false',
  sampleRate: [16000, 32000, 44100, 48000].includes(Number(payload.sampleRate))
    ? Number(payload.sampleRate)
    : 48000,
});

const getFileExtension = (file) => {
  const originalExt = path.extname(file?.originalname || '').toLowerCase();
  if (originalExt) return originalExt;
  return MIME_EXTENSION_MAP[file?.mimetype] || '.wav';
};

const getRawBodyExtension = (contentType = '', rawBody = null) => {
  const normalizedType = String(contentType || '').toLowerCase();

  if (normalizedType.includes('audio/wav') || normalizedType.includes('audio/x-wav')) return '.wav';
  if (normalizedType.includes('audio/webm') || normalizedType.includes('video/webm')) return '.webm';
  if (normalizedType.includes('audio/ogg')) return '.ogg';
  if (normalizedType.includes('audio/mpeg')) return '.mp3';
  if (normalizedType.includes('audio/mp4')) return '.m4a';

  if (normalizedType.includes('application/octet-stream')) {
    if (Buffer.isBuffer(rawBody) && rawBody.length >= 12) {
      const ascii = rawBody.subarray(0, 16).toString('ascii');
      if (ascii.startsWith('RIFF') && rawBody.subarray(8, 12).toString('ascii') === 'WAVE') return '.wav';
      if (ascii.startsWith('OggS')) return '.ogg';
      if (
        rawBody[0] === 0x1a &&
        rawBody[1] === 0x45 &&
        rawBody[2] === 0xdf &&
        rawBody[3] === 0xa3
      ) return '.webm';
    }
    return '.wav';
  }

  return MIME_EXTENSION_MAP[normalizedType] || '.wav';
};

function normalizeTranscriptText(text = '') {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function tokenizeUnicode(text = '') {
  return normalizeTranscriptText(text).split(/\s+/u).map((token) => token.trim()).filter(Boolean);
}

function removeRepeatedPhrases(text = '') {
  const tokens = normalizeTranscriptText(text).toLowerCase().match(/[a-z0-9']+/g) || [];
  if (!tokens.length) return '';

  const out = [];
  let i = 0;
  while (i < tokens.length) {
    let collapsed = false;
    const maxN = Math.min(12, Math.floor((tokens.length - i) / 2));
    for (let size = maxN; size >= 1; size -= 1) {
      const phrase = tokens.slice(i, i + size).join(' ');
      let repeats = 1;
      while (i + (repeats + 1) * size <= tokens.length) {
        const nextPhrase = tokens.slice(i + repeats * size, i + (repeats + 1) * size).join(' ');
        if (nextPhrase !== phrase) break;
        repeats += 1;
      }
      if ((repeats >= 2 && size >= 4) || repeats >= 3) {
        out.push(...tokens.slice(i, i + size));
        i += repeats * size;
        collapsed = true;
        break;
      }
    }
    if (!collapsed) {
      out.push(tokens[i]);
      i += 1;
    }
  }

  return normalizeTranscriptText(out.join(' '));
}

function removeInternalDuplicatePassages(text = '') {
  const tokens = normalizeTranscriptText(text).split(/\s+/).filter(Boolean);
  if (tokens.length < 12) return normalizeTranscriptText(text);

  for (let anchorSize = Math.min(8, Math.max(4, Math.floor(tokens.length / 3))); anchorSize >= 4; anchorSize -= 1) {
    const prefix = tokens.slice(0, anchorSize).map((token) => token.toLowerCase());
    for (let idx = anchorSize + 4; idx <= tokens.length - anchorSize; idx += 1) {
      const candidate = tokens.slice(idx, idx + anchorSize).map((token) => token.toLowerCase());
      if (candidate.join(' ') !== prefix.join(' ')) continue;

      const left = tokens.slice(0, idx);
      const right = tokens.slice(idx);
      const leftUniqueRatio = new Set(left.map((token) => token.toLowerCase())).size / Math.max(1, left.length);
      const rightUniqueRatio = new Set(right.map((token) => token.toLowerCase())).size / Math.max(1, right.length);
      const repeatedIntro = idx <= Math.max(16, anchorSize * 3);
      const repetitiveTail = rightUniqueRatio < 0.72 || leftUniqueRatio < 0.72;

      if (repeatedIntro && repetitiveTail) {
        return normalizeTranscriptText(left.join(' '));
      }
    }
  }

  return normalizeTranscriptText(tokens.join(' '));
}

function removeNoiseTokens(text = '') {
  const normalized = normalizeTranscriptText(text);
  if (!normalized) return '';

  const keepRanges = [];
  const protectedPatterns = [
    /\broom number\s+\d+\b/giu,
    /\b\d+\s+crore\b/giu,
    /\b(?:october|november|december|january|february|march|april|may|june|july|august|september)\s+\d+\b/giu,
  ];
  for (const pattern of protectedPatterns) {
    for (const match of normalized.matchAll(pattern)) {
      keepRanges.push([match.index, match.index + match[0].length]);
    }
  }

  const isProtected = (start, end) => keepRanges.some(([a, b]) => start < b && end > a);
  let cleaned = normalized.replace(/\b(?:\d+\s+){2,}\d+\b/gu, (match, offset) => (
    isProtected(offset, offset + match.length) ? match : ' '
  ));
  cleaned = cleaned.replace(/\b\d{1,2}\b/gu, (match, offset) => (
    isProtected(offset, offset + match.length) ? match : ' '
  ));
  return normalizeTranscriptText(cleaned);
}

function cleanTranscriptText(text = '', options = {}) {
  const preserveRepeats = Boolean(options.preserveRepeats);
  const preserveNumbers = options.preserveNumbers !== false;
  let normalized = normalizeTranscriptText(text);
  if (!normalized) return '';
  if (hasKnownBadPlaceholder(normalized)) return '';
  if (!preserveRepeats) {
    normalized = removeRepeatedPhrases(normalized);
  }
  normalized = removeInternalDuplicatePassages(normalized);
  normalized = preserveNumbers ? normalized : removeNoiseTokens(normalized);
  normalized = normalizeTranscriptText(normalized);
  if (isHallucinatedRepetition(normalized)) {
    return preserveRepeats ? normalizeTranscriptText(removeRepeatedPhrases(normalized)) : '';
  }
  return normalized;
}

function _hasNativeIndianScriptLocal(text = '') {
  return /[\u0900-\u097F\u0A80-\u0AFF]/.test(String(text || ''));
}

function isHallucinatedRepetition(text = '') {
  const normalized = normalizeTranscriptText(text);
  if (!normalized) return false;
  // v14: Never reject text that contains Devanagari (Hindi) or Gujarati script
  // These are always real speech — Whisper doesn't hallucinate native scripts
  if (_hasNativeIndianScriptLocal(normalized)) return false;
  if (/([A-Za-z])\1{7,}/u.test(normalized)) return true;
  const tokens = normalized.toLowerCase().match(/[\p{L}\p{N}%:._'-]+/gu) || [];
  if (tokens.length < 12) return false;

  const uniqueRatio = new Set(tokens).size / Math.max(1, tokens.length);
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
  const maxCount = Math.max(...counts.values());

  // v14: more lenient — real Hindi/Gujarati often has low unique ratio
  return uniqueRatio < 0.10 || maxCount >= Math.max(10, Math.floor(tokens.length * 0.7));
}

function findTokenOverlap(previousText = '', currentText = '') {
  const prev = tokenizeUnicode(previousText).map((token) => token.toLocaleLowerCase());
  const curr = tokenizeUnicode(currentText).map((token) => token.toLocaleLowerCase());
  const maxOverlap = Math.min(prev.length, curr.length, 25);

  for (let size = maxOverlap; size >= 4; size -= 1) {
    const prevTail = prev.slice(prev.length - size).join(' ');
    const currHead = curr.slice(0, size).join(' ');
    if (prevTail && prevTail === currHead) {
      return size;
    }
  }

  return 0;
}

function removeLeadingOverlap(previousText = '', currentText = '') {
  const currentTokens = normalizeTranscriptText(currentText).split(/\s+/).filter(Boolean);
  const overlap = findTokenOverlap(previousText, currentText);
  if (overlap <= 0) return normalizeTranscriptText(currentText);
  return normalizeTranscriptText(currentTokens.slice(overlap).join(' '));
}

const computeTimelineDurationSec = (meeting, fallbackValue = 0) => {
  if (meeting?.startTime) {
    const endMs = meeting.endTime
      ? new Date(meeting.endTime).getTime()
      : Date.now();
    const startMs = new Date(meeting.startTime).getTime();

    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
      return Math.max(0, Math.floor((endMs - startMs) / 1000));
    }
  }

  return Math.max(0, Number(fallbackValue || 0));
};

function toFiniteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundTimelineSeconds(value) {
  const number = toFiniteNumber(value, null);
  if (number == null) return null;
  return Math.max(0, Math.round(number * 1000) / 1000);
}

function inferChunkTimeline({ chunkIndex, durationMs, explicitStartSec, explicitEndSec }) {
  const safeDurationMs = Math.max(0, Number(durationMs || 0));
  const explicitStart = roundTimelineSeconds(explicitStartSec);
  const explicitEnd = roundTimelineSeconds(explicitEndSec);

  if (explicitStart != null && explicitEnd != null && explicitEnd >= explicitStart) {
    return { startSec: explicitStart, endSec: explicitEnd };
  }

  if (explicitStart != null) {
    return {
      startSec: explicitStart,
      endSec: roundTimelineSeconds(explicitStart + safeDurationMs / 1000) ?? explicitStart,
    };
  }

  if (explicitEnd != null) {
    const derivedStart = Math.max(0, explicitEnd - safeDurationMs / 1000);
    return {
      startSec: roundTimelineSeconds(derivedStart) ?? 0,
      endSec: explicitEnd,
    };
  }

  // Web recorder chunks are 60s. If a client ever omits explicit timestamps,
  // chunk_1 must start at 60s, not 30s.
  const fallbackStart = Math.max(0, Number(chunkIndex || 0) * 60);
  const fallbackEnd = fallbackStart + safeDurationMs / 1000;
  return {
    startSec: roundTimelineSeconds(fallbackStart) ?? 0,
    endSec: roundTimelineSeconds(fallbackEnd) ?? fallbackStart,
  };
}

function normalizeSegmentToMeetingTimeline(segment = {}, chunk = {}) {
  const offsetSec = Math.max(0, Number(chunk.chunkStartSec || 0));
  const localStartSec = Math.max(0, Number(segment.start ?? 0));
  const localEndSec = Math.max(localStartSec, Number(segment.end ?? localStartSec));
  const globalStartSec = roundTimelineSeconds(offsetSec + localStartSec) ?? offsetSec;
  const globalEndSec = roundTimelineSeconds(offsetSec + localEndSec) ?? globalStartSec;
  const globalStartMs = Math.max(0, Math.round(globalStartSec * 1000));
  const globalEndMs = Math.max(globalStartMs, Math.round(globalEndSec * 1000));

  const sourceText = cleanTranscriptText(String(
    segment.sourceText || segment.normalizedSourceText || segment.rawSourceText || ''
  ), { preserveRepeats: true, preserveNumbers: true });
  const englishText = cleanTranscriptText(String(
    segment.englishText || segment.translatedText || ''
  ), { preserveRepeats: true, preserveNumbers: true });
  const finalValidatedText = selectValidatedFinalText({
    finalValidatedText: segment.finalValidatedText,
    translatedEnglish: englishText,
    sourceFullText: sourceText,
    rawFullText: sourceText,
    displayText: segment.displayText,
    fullText: segment.text,
  }, '');

  return {
    ...segment,
    id: Number.isFinite(Number(segment.id)) ? Number(segment.id) : 0,
    start: globalStartSec,
    end: globalEndSec,
    startMs: globalStartMs,
    endMs: globalEndMs,
    speaker: String(segment.speaker || 'Speaker 1').trim() || 'Speaker 1',
    text: finalValidatedText,
    displayText: finalValidatedText,
    finalValidatedText,
    sourceText,
    rawSourceText: cleanTranscriptText(String(segment.rawSourceText || sourceText || ''), { preserveRepeats: true, preserveNumbers: true }),
    normalizedSourceText: cleanTranscriptText(String(segment.normalizedSourceText || sourceText || ''), { preserveRepeats: true, preserveNumbers: true }),
    englishText,
    translatedText: englishText,
    sourceLanguage: String(segment.sourceLanguage || segment.language || '').trim(),
    language: String(segment.language || segment.sourceLanguage || '').trim(),
    translationWarnings: Array.isArray(segment.translationWarnings) ? segment.translationWarnings : [],
    chunkIndex: Number(chunk.chunkIndex || 0),
    confidence: typeof segment.confidence === 'number' ? segment.confidence : null,
    confidenceLabel: segment.confidenceLabel || 'unknown',
    needsReview: Boolean(segment.needsReview),
    uncertainTerms: Array.isArray(segment.uncertainTerms) ? segment.uncertainTerms : [],
    words: Array.isArray(segment.words) ? segment.words : [],
  };
}

function buildChunkSsePayload(meeting, chunk) {
  return {
    meetingId: meeting.meetingId,
    deviceId: meeting.deviceId || null,
    chunkIndex: Number(chunk?.chunkIndex || 0),
    chunkStartSec: Number(chunk?.chunkStartSec || 0),
    chunkEndSec: Number(chunk?.chunkEndSec || 0),
    durationSec: Number(chunk?.durationMs || 0) / 1000,
    durationSecTotal: Number(meeting.stats?.durationSec || 0),
    chunksUploaded: Number(meeting.stats?.chunksUploaded || 0),
    chunksCompleted30s: Number(meeting.stats?.chunksCompleted30s || 0),
    hasFinalPartialChunk: Boolean(meeting.stats?.hasFinalPartialChunk),
    chunksFailed: Number(meeting.stats?.chunksFailed || 0),
    chunksTotal: Number(meeting.stats?.chunksTotal || 0),
    transcriptSegments: Number(meeting.stats?.transcriptSegments || 0),
  };
}

async function queueDeviceCommand(deviceId, command, meeting) {
  return Device.findOneAndUpdate(
    { deviceId },
    {
      $set: {
        currentMeetingId: meeting?.meetingId || null,
        status: 'online',
        lastSeenAt: new Date(),
        'control.pendingCommand': command,
        'control.meetingId': meeting?.meetingId || null,
        'control.title': meeting?.title || null,
        'control.language': normalizeMeetingLanguage(meeting?.language),
        'control.requestedAt': new Date(),
        'control.acknowledgedAt': null,
        'control.lastResult': {
          status: null,
          message: null,
          at: null,
        },
      },
    },
    { new: true }
  );
}

const findMeetingByAnyId = async (id) => {
  if (mongoose.Types.ObjectId.isValid(id)) {
    return Meeting.findOne({ $or: [{ _id: id }, { meetingId: id }] });
  }
  return Meeting.findOne({ meetingId: id });
};

const getMeetingStorageContext = (meeting, requestLanguage = undefined) => {
  const safeMeetingId = sanitizeMeetingId(meeting?.meetingId || meeting?._id || '');

  const hasLockedFolder = typeof meeting?.storageFolder === 'string' && meeting.storageFolder.trim();
  const resolvedLanguage = normalizeMeetingLanguage(
    meeting?.normalizedLanguage || meeting?.selectedLanguage || requestLanguage || meeting?.language || 'auto'
  );
  const resolvedFolder = hasLockedFolder ? meeting.storageFolder.trim() : resolveAudioLanguageFolder(resolvedLanguage);
  const storagePath = hasLockedFolder && meeting?.storagePath
    ? path.resolve(meeting.storagePath)
    : getMeetingAudioDirectory(resolvedLanguage, safeMeetingId);

  return {
    meetingId: safeMeetingId,
    selectedLanguage: normalizeMeetingLanguage(meeting?.selectedLanguage || requestLanguage || meeting?.language || 'auto'),
    normalizedLanguage: resolvedLanguage,
    storageFolder: resolvedFolder,
    storagePath,
  };
};

const ensureMeetingStorageDirectory = async (meeting, requestLanguage = undefined) => {
  const context = getMeetingStorageContext(meeting, requestLanguage);
  await fs.promises.mkdir(context.storagePath, { recursive: true });
  return context;
};

const getLegacyMeetingDirIfExists = async (meetingId) => {
  try {
    const legacyDir = getLegacyMeetingDirectory(meetingId);
    const stat = await fs.promises.stat(legacyDir).catch(() => null);
    return stat?.isDirectory() ? legacyDir : null;
  } catch (_error) {
    return null;
  }
};

const resolveReadableMeetingDirectories = async (meeting) => {
  const directories = [];
  const seen = new Set();

  if (meeting?.meetingId) {
    try {
      const context = getMeetingStorageContext(meeting);
      if (!seen.has(context.storagePath)) {
        directories.push(context.storagePath);
        seen.add(context.storagePath);
      }
    } catch (_error) {
      // ignore and continue with legacy fallback
    }

    const legacyDir = await getLegacyMeetingDirIfExists(meeting.meetingId);
    if (legacyDir && !seen.has(legacyDir)) {
      directories.push(legacyDir);
      seen.add(legacyDir);
    }
  }

  return directories;
};

const ensureMeetingDir = async (meetingOrId, requestLanguage = undefined) => {
  const meeting = typeof meetingOrId === 'object' && meetingOrId ? meetingOrId : await findMeetingByAnyId(meetingOrId);

  if (!meeting) {
    const fallbackMeetingId = sanitizeMeetingId(meetingOrId);
    return getMeetingAudioDirectory(requestLanguage || 'auto', fallbackMeetingId);
  }

  const legacyDir = (!meeting.storageFolder && !meeting.storagePath)
    ? await getLegacyMeetingDirIfExists(meeting.meetingId)
    : null;

  if (legacyDir) {
    await fs.promises.mkdir(legacyDir, { recursive: true });
    return legacyDir;
  }

  const context = await ensureMeetingStorageDirectory(meeting, requestLanguage);
  return context.storagePath;
};

const getChunkBaseName = (chunkIndex) =>
  `chunk_${Number.isFinite(chunkIndex) ? chunkIndex : 0}`;

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const meeting = await findMeetingByAnyId(req.params.id);
      // v17 FIX: Frontend sends 'selectedLanguage' in multipart form, not 'language'
      const requestedLanguage = typeof req.body === 'object' && !Buffer.isBuffer(req.body)
        ? (req.body.selectedLanguage || req.body.language)
        : undefined;
      const meetingDir = await ensureMeetingDir(meeting || { meetingId: meeting?.meetingId || req.params.id, language: requestedLanguage }, requestedLanguage);
      cb(null, meetingDir);
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    const body = typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {};
    const inferredChunkIndex = Number.isFinite(Number(body.chunkIndex))
      ? Number(body.chunkIndex)
      : Number.isFinite(parseChunkIndexFromName(file?.originalname))
        ? Number(parseChunkIndexFromName(file?.originalname))
        : 0;
    cb(null, `${getChunkBaseName(inferredChunkIndex)}_${Date.now()}${getFileExtension(file)}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE, 10) || DEFAULT_MAX_FILE_SIZE,
  },
  fileFilter: (req, file, cb) => {
    if (
      SUPPORTED_AUDIO_MIME_TYPES.has(file.mimetype) ||
      /\.(wav|webm|ogg|mp3|m4a)$/i.test(file.originalname || '')
    ) {
      cb(null, true);
    } else {
      cb(new Error('Only audio chunks are allowed'), false);
    }
  },
});


const flattenUploadedFiles = (files) => {
  if (!files) return [];
  if (Array.isArray(files)) return files.filter(Boolean);
  if (typeof files === 'object') {
    const orderedKeys = ['audio', 'chunk', 'file', 'upload'];
    const out = [];
    for (const key of orderedKeys) {
      const value = files[key];
      if (Array.isArray(value)) out.push(...value.filter(Boolean));
      else if (value) out.push(value);
    }
    for (const value of Object.values(files)) {
      if (Array.isArray(value)) out.push(...value.filter(Boolean));
      else if (value) out.push(value);
    }
    return out;
  }
  return [];
};

const pickUploadedFile = (req) => {
  const candidates = [];
  if (req.file) candidates.push(req.file);
  candidates.push(...flattenUploadedFiles(req.files));

  const seen = new Set();
  const unique = candidates.filter((file) => {
    if (!file) return false;
    const key = file.path || `${file.fieldname || ''}:${file.originalname || ''}:${file.size || 0}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const preferred = ['audio', 'chunk', 'file', 'upload'];
  unique.sort((a, b) => {
    const ai = preferred.indexOf(a.fieldname || '');
    const bi = preferred.indexOf(b.fieldname || '');
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  return unique.find((file) => Number(file.size || 0) > 0) || null;
};

const cleanupUnselectedUploadedFiles = async (req, selectedFile) => {
  const allFiles = flattenUploadedFiles(req.files);
  if (req.file) allFiles.push(req.file);
  const selectedPath = selectedFile?.path ? path.resolve(selectedFile.path) : null;
  const seen = new Set();
  for (const file of allFiles) {
    if (!file?.path) continue;
    const absolute = path.resolve(file.path);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    if (selectedPath && absolute === selectedPath) continue;
    await fs.promises.unlink(absolute).catch(() => {});
  }
};

const getReceivedFileFields = (req) => {
  if (Array.isArray(req.files)) return req.files.map((file) => file.fieldname).filter(Boolean);
  if (req.files && typeof req.files === 'object') return Object.keys(req.files);
  return req.file?.fieldname ? [req.file.fieldname] : [];
};

const rawChunkParser = express.raw({
  type: ['audio/wav', 'audio/x-wav', 'audio/webm', 'video/webm', 'application/octet-stream'],
  limit: `${parseInt(process.env.MAX_FILE_SIZE, 10) || DEFAULT_MAX_FILE_SIZE}b`,
});

const handleRawBody = (req, res, next) => {
  const contentType = req.headers['content-type'] || '';
  if (
    !contentType.includes('audio/wav') &&
    !contentType.includes('audio/x-wav') &&
    !contentType.includes('audio/webm') &&
    !contentType.includes('video/webm') &&
    !contentType.includes('application/octet-stream')
  ) {
    return next();
  }

  rawChunkParser(req, res, (err) => {
    if (err) {
      if (err.type === 'entity.too.large') {
        return res.status(413).json({
          success: false,
          error: { code: 'PAYLOAD_TOO_LARGE', message: 'Chunk too large' },
        });
      }
      return next(err);
    }

    if (Buffer.isBuffer(req.body)) return next();
    req.body = Buffer.alloc(0);
    return next();
  });
};

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}


function parseChunkIndexFromName(value = '') {
  const match = String(value || '').match(/chunk_(\d+)/i);
  return match ? Number(match[1]) : null;
}

function safeLogJson(value) {
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value || '');
  }
}

async function probeAudioDurationAndContainer(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (!filePath || !fs.existsSync(filePath)) {
    return { containerDurationSec: null, decodedDurationSec: null, ffprobe: 'file_not_found' };
  }

  // FIX (Bug 1): Browser MediaRecorder produces fragmented WebM — duration is NOT stored
  // in the container-level format.duration header (always 0 or absent). It IS available
  // in stream-level metadata. We run up to 3 passes to find a valid duration.
  const ffprobeBin = process.env.FFPROBE_BIN || 'ffprobe';

  const spawnFfprobe = (bin, args) => new Promise((resolve) => {
    const { spawn } = require('child_process');
    const child = spawn(bin, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ stdout, stderr, status: code }));
    child.on('error', (error) => resolve({ stdout: '', stderr: error.message, status: -1 }));
  });

  try {
    // Pass 1: container-level duration + streams JSON (works for MP4, WAV, OGG; NOT fragmented WebM)
    const { stdout: out1, stderr: stderr1, status: s1 } = await spawnFfprobe(ffprobeBin, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-show_streams',
      '-of', 'json',
      filePath,
    ]);

    let containerDurationSec = null;
    let durationSource = null;

    if (s1 === 0 && out1) {
      let parsed = {};
      try { parsed = JSON.parse(out1); } catch (_) { /* ignore parse errors */ }

      // Try container-level duration first
      const rawDuration = Number(parsed?.format?.duration || 0);
      if (Number.isFinite(rawDuration) && rawDuration > 0.05) {
        containerDurationSec = Number(rawDuration.toFixed(3));
        durationSource = 'container';
      }

      // Pass 2: stream-level duration — fragmented WebM DOES contain this per-stream
      if (!containerDurationSec) {
        const streams = parsed?.streams || [];
        const audioStream = streams.find((s) => s.codec_type === 'audio');
        const streamDur = Number(audioStream?.duration || 0);
        if (Number.isFinite(streamDur) && streamDur > 0.05) {
          containerDurationSec = Number(streamDur.toFixed(3));
          durationSource = 'stream_level';
          console.log('[FFPROBE] stream-level fallback', { filePath, containerDurationSec });
        }
      }
    }

    // Pass 3: targeted stream-only probe if both passes above failed
    if (!containerDurationSec) {
      const { stdout: out2, status: s2 } = await spawnFfprobe(ffprobeBin, [
        '-v', 'error',
        '-select_streams', 'a:0',
        '-show_entries', 'stream=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        filePath,
      ]);
      if (s2 === 0 && out2.trim()) {
        const val = parseFloat(out2.trim());
        if (Number.isFinite(val) && val > 0.05) {
          containerDurationSec = Number(val.toFixed(3));
          durationSource = 'targeted_stream';
          console.log('[FFPROBE] targeted-stream fallback', { filePath, containerDurationSec });
        }
      }
    }

    console.log('[FFPROBE] result', { filePath, containerDurationSec, durationSource: durationSource || 'none' });

    const decodedDurationSec = ext === '.wav' ? await getWavDurationSec(filePath) : null;
    return {
      containerDurationSec,
      decodedDurationSec,
      durationSource,
      ffprobe: s1 === 0 ? '' : String(stderr1 || 'ffprobe_failed').slice(0, 2000),
    };
  } catch (error) {
    return {
      containerDurationSec: null,
      decodedDurationSec: ext === '.wav' ? await getWavDurationSec(filePath) : null,
      durationSource: null,
      ffprobe: error.message,
    };
  }
}

async function getWavDurationSec(filePath) {
  const fd = await fs.promises.open(filePath, 'r');
  try {
    const header = Buffer.alloc(44);
    const { bytesRead } = await fd.read(header, 0, 44, 0);
    if (bytesRead < 44) return 0;
    const sampleRate = header.readUInt32LE(24);
    const byteRate = header.readUInt32LE(28);
    const dataSize = header.readUInt32LE(40);
    if (byteRate > 0) return Math.max(1, Math.round(dataSize / byteRate));
    if (sampleRate > 0) {
      const channels = header.readUInt16LE(22) || 1;
      const bitsPerSample = header.readUInt16LE(34) || 16;
      const bytesPerSample = Math.max(1, (channels * bitsPerSample) / 8);
      return Math.max(1, Math.round(dataSize / (sampleRate * bytesPerSample)));
    }
    return 0;
  } catch (error) {
    return 0;
  } finally {
    await fd.close();
  }
}

async function listChunkFiles(meetingId) {
  const meeting = await findMeetingByAnyId(meetingId);
  const directories = await resolveReadableMeetingDirectories(meeting || { meetingId });
  const detailed = [];
  const seen = new Set();

  for (const meetingDir of directories) {
    const files = await fs.promises.readdir(meetingDir).catch(() => []);

    for (const file of files) {
      if (!/^chunk_\d+.*\.(wav|webm|ogg|mp3|m4a)$/i.test(file)) continue;

      const filePath = path.join(meetingDir, file);
      if (seen.has(filePath)) continue;
      seen.add(filePath);

      const chunkMatch = file.match(/^chunk_(\d+)/i);
      const chunkIndex = chunkMatch ? Number(chunkMatch[1]) : 0;
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (!stat) continue;

      detailed.push({
        file,
        filePath,
        chunkIndex,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
    }
  }

  return detailed
    .filter(Boolean)
    .sort((a, b) => a.chunkIndex - b.chunkIndex || a.mtimeMs - b.mtimeMs);
}

async function getStoredChunks(meetingId) {
  const docs = await AudioChunk.find({ meetingId })
    .sort({ chunkIndex: 1, createdAt: 1 })
    .lean();
  return docs.filter(
    (doc) => typeof doc.chunkIndex === 'number' && Number.isFinite(doc.chunkIndex)
  );
}

async function rebuildMeetingStats(meeting) {
  const chunkDocs = await getStoredChunks(meeting.meetingId);

  // FIX v8.0: Include 'failed' in uploaded count. A chunk that failed transcription
  // still represents audio that physically arrived. Without this, one failed chunk
  // causes chunksUploaded=0, which makes markTranscriptFailure set meeting.status='failed'.
  const uploaded = chunkDocs.filter((chunk) => ['uploaded', 'transcribing', 'transcribed', 'skipped', 'failed'].includes(chunk.status));
  const transcribing = chunkDocs.filter((chunk) => chunk.status === 'transcribing');
  const transcribed = chunkDocs.filter((chunk) => chunk.status === 'transcribed');
  const failed = chunkDocs.filter((chunk) => chunk.status === 'failed');

  const maxChunkEnd = uploaded.reduce((maxValue, chunk) => {
    const chunkEnd = toFiniteNumber(chunk.chunkEndSec, null);
    if (chunkEnd != null) return Math.max(maxValue, chunkEnd);
    return Math.max(maxValue, Number(chunk.durationMs || 0) / 1000);
  }, 0);

  const totalBytes = uploaded.reduce((sum, chunk) => sum + Number(chunk.sizeBytes || 0), 0);
  const uniqueByIndex = new Map();
  for (const chunk of chunkDocs) {
    if (!uniqueByIndex.has(chunk.chunkIndex)) {
      uniqueByIndex.set(chunk.chunkIndex, chunk);
    }
  }

  meeting.stats.chunksUploaded = uploaded.length;
  meeting.stats.chunksProcessing = transcribing.length;
  meeting.stats.chunksTranscribed = transcribed.length;
  meeting.stats.chunksFailed = failed.length;
  meeting.stats.chunksTotal = uniqueByIndex.size;
  meeting.stats.chunkCount = uniqueByIndex.size;
  meeting.stats.chunksCompleted30s = uploaded.filter((chunk) => Number(chunk.durationMs || 0) >= 55000 && !chunk.isFinalPartialChunk).length; // 55s threshold for 60s chunks
  meeting.stats.chunksCompleted60s = meeting.stats.chunksCompleted30s; // UI uses chunksCompleted60s alias
  meeting.stats.hasFinalPartialChunk = uploaded.some((chunk) => Boolean(chunk.isFinalPartialChunk));
  meeting.stats.lastChunkIndex = uploaded.reduce((maxValue, chunk) => Math.max(maxValue, Number(chunk.chunkIndex || -1)), -1);
  meeting.stats.totalAudioBytes = totalBytes;
  meeting.stats.fileSizeBytes = totalBytes;
  meeting.stats.lastClientDurationSec = Math.round(maxChunkEnd);

  if (meeting.source === 'web') {
    meeting.stats.durationSec = Math.max(Math.round(maxChunkEnd), computeTimelineDurationSec(meeting, maxChunkEnd));
  } else {
    meeting.stats.durationSec = Math.round(maxChunkEnd || uploaded.reduce((sum, chunk) => sum + Math.max(0, Math.round(Number(chunk.durationMs || 0) / 1000)), 0));
  }

  const effectiveDurationSec = Math.max(0, Number(meeting.stats.durationSec || maxChunkEnd || 0));
  meeting.stats.fullChunks = Math.floor(effectiveDurationSec / 60);
  meeting.stats.partialChunks = effectiveDurationSec >= 20 && effectiveDurationSec % 60 > 0 ? 1 : 0;
  meeting.stats.totalChunks = effectiveDurationSec >= 20 ? Math.ceil(effectiveDurationSec / 60) : 0;
  meeting.stats.uploadedChunks = meeting.stats.chunksUploaded;
  meeting.stats.rejectedChunks = chunkDocs.filter((chunk) => ['skipped', 'failed'].includes(chunk.status)).length;

  const transcript = await Transcript.findOne({ meetingId: meeting.meetingId }).lean().catch(() => null);
  meeting.stats.transcriptLength = String(transcript?.fullText || transcript?.cleanEnglish || transcript?.rawFullText || '').trim().length;
  meeting.stats.transcriptSegments = Number(transcript?.segments?.length || 0);
  meeting.stats.speakerCount = Number(transcript?.speakerCount || 0);
  meeting.lastTranscriptAt = transcript?.updatedAt || meeting.lastTranscriptAt || null;

  return meeting;
}

async function getOrCreateTranscript(meeting) {
  let transcript = await Transcript.findOne({ meetingId: meeting.meetingId });
  if (!transcript) {
    transcript = await Transcript.create({
      meetingId: meeting.meetingId,
      language: normalizeMeetingLanguage(meeting.language),
      fullText: '',
      rawFullText: '',
      cleanEnglish: '',
      rawTranscriptNormalized: '',
      uncertainTerms: [],
      confidenceNotes: '',
      segments: [],
      processingStatus: 'pending',
    });
  }
  return transcript;
}

function pickBestChunkText(chunk = {}) {
  const clean = chooseBestTranscriptText(
    chunk.translatedEnglishTranscript,
    chunk.cleanEnglishTranscript,
    chunk.displayTranscriptText,
    chunk.transcriptText,
  );
  const raw = chooseBestTranscriptText(
    chunk.sourceTranscriptText,
    chunk.normalizedSourceTranscript,
    chunk.rawTranscriptText,
    chunk.rawTranscriptNormalized,
    chunk.transcriptText,
  );
  const transcript = chooseBestTranscriptText(
    chunk.displayTranscriptText,
    chunk.transcriptText,
    clean,
    raw,
  );

  return {
    clean,
    raw: raw || transcript || clean,
    best: transcript || clean || raw || '',
  };
}


async function persistTranscriptAtomic(meetingId, transcript) {
  const payload = transcript.toObject ? transcript.toObject() : { ...transcript };
  delete payload._id;
  delete payload.__v;
  payload.updatedAt = new Date();
  await Transcript.findOneAndUpdate({ meetingId }, { $set: payload }, { upsert: true, new: true, setDefaultsOnInsert: true });
}

function chunkHasUsableTranscript(chunk = {}) {
  if (String(chunk?.transcriptAcceptance?.accepted || '').toLowerCase() === 'true' || chunk?.transcriptAcceptance?.accepted === true) {
    return true;
  }
  if (chunk?.transcriptAcceptance?.accepted === false) {
    return false;
  }
  const picked = pickBestChunkText(chunk);
  const assessed = assessTranscriptCandidate(picked.best || picked.clean || picked.raw || '', { minWords: 1 });
  return Boolean(
    assessed.accepted ||
    (Array.isArray(chunk.transcriptSegments) && chunk.transcriptSegments.length > 0)
  );
}

async function rebuildTranscriptFromChunks(meeting) {
  const transcript = await getOrCreateTranscript(meeting);
  transcript.processingStatus = 'processing';
  await persistTranscriptAtomic(meeting.meetingId, transcript);

  const chunkDocs = (await getStoredChunks(meeting.meetingId))
    .filter((chunk) => ['uploaded', 'transcribing', 'transcribed', 'skipped', 'failed'].includes(chunk.status))
    .sort((a, b) => Number(a.chunkIndex || 0) - Number(b.chunkIndex || 0) || Number(a.chunkStartSec || 0) - Number(b.chunkStartSec || 0) || new Date(a.createdAt || 0) - new Date(b.createdAt || 0));

  const rawFullTextParts = [];
  const cleanEnglishParts = [];
  const conversationTextParts = [];
  const uncertainTerms = new Set();
  const confidenceNotes = [];
  const allSegments = [];
  let lastChunkIndex = -1;
  let previousChunkText = '';
  let previousChunkEndSec = 0;

  for (const chunk of chunkDocs) {
    const picked = pickBestChunkText(chunk);
    const acceptance = chunk.transcriptAcceptance || {};
    const acceptedChunkText = acceptance.accepted
      ? String(acceptance.acceptedText || picked.clean || picked.best || '').trim()
      : '';
    const acceptedSourceText = acceptance.accepted
      ? String(acceptance.acceptedSourceText || picked.raw || picked.best || '').trim()
      : '';
    let chunkText = acceptedChunkText;
    let rawChunkText = acceptedSourceText;
    let chunkConversationText = String(chunk.conversationText || '').trim();
    const chunkStartSec = Number(chunk.chunkStartSec || 0);
    const chunkEndSec = Number(chunk.chunkEndSec || chunkStartSec + Number(chunk.durationMs || 0) / 1000);
    const chunkOverlapSec = Math.max(0, previousChunkEndSec - chunkStartSec);
    const shouldTextDedupe = chunkOverlapSec >= 0.75;

    if (
      isHallucinatedRepetition(chunkText) ||
      hasKnownBadPlaceholder(chunkText) ||
      !isUsableTranscript(chunkText, { minWords: 1 })
    ) {
      chunkText = '';
    }
    if (
      isHallucinatedRepetition(rawChunkText) ||
      hasKnownBadPlaceholder(rawChunkText)
    ) {
      rawChunkText = '';
    }

    if (shouldTextDedupe) {
      rawChunkText = removeLeadingOverlap(previousChunkText, rawChunkText);
      chunkText = removeLeadingOverlap(previousChunkText, chunkText);
      chunkConversationText = removeLeadingOverlap(previousChunkText, chunkConversationText);
    }

    if (rawChunkText) rawFullTextParts.push(rawChunkText);
    if (chunkConversationText) conversationTextParts.push(chunkConversationText);
    if (chunkText) cleanEnglishParts.push(chunkText);

    for (const term of Array.isArray(chunk.uncertainTerms) ? chunk.uncertainTerms : []) {
      const normalizedTerm = String(term || '').trim();
      if (normalizedTerm) uncertainTerms.add(normalizedTerm);
    }

    if (chunk.confidenceNotes) {
      confidenceNotes.push(String(chunk.confidenceNotes).trim());
    }

    const segments = acceptance.accepted && Array.isArray(chunk.transcriptSegments) ? chunk.transcriptSegments : [];
    if (segments.length > 0) {
      for (const seg of segments) {
        const normalized = normalizeSegmentToMeetingTimeline(seg, chunk);
        if (
          !normalized.text ||
          isHallucinatedRepetition(normalized.text) ||
          hasKnownBadPlaceholder(normalized.text)
        ) {
          continue;
        }
        allSegments.push(normalized);
      }
    } else if (chunkText || rawChunkText) {
      const fallbackText = chunkText || rawChunkText;
      allSegments.push({
        id: allSegments.length,
        start: chunkStartSec,
        end: Math.max(chunkStartSec, chunkEndSec),
        startMs: Math.round(chunkStartSec * 1000),
        endMs: Math.round(Math.max(chunkStartSec, chunkEndSec) * 1000),
        speaker: 'Speaker 1',
        text: fallbackText,
        chunkIndex: Number(chunk.chunkIndex || 0),
        confidence: null,
        confidenceLabel: 'unknown',
        needsReview: false,
        uncertainTerms: Array.isArray(chunk.uncertainTerms) ? chunk.uncertainTerms : [],
        words: [],
      });
    }

    previousChunkText = rawChunkText || chunkText || previousChunkText;
    previousChunkEndSec = Math.max(previousChunkEndSec, chunkEndSec);
    lastChunkIndex = Math.max(lastChunkIndex, Number(chunk.chunkIndex || -1));
  }

  allSegments.sort((a, b) => Number(a.startMs || 0) - Number(b.startMs || 0) || Number(a.endMs || 0) - Number(b.endMs || 0) || Number(a.chunkIndex || 0) - Number(b.chunkIndex || 0));
  transcript.rawFullText = rawFullTextParts.map((item) => cleanTranscriptText(item, { preserveRepeats: true, preserveNumbers: true })).filter(Boolean).join('\n').trim();
  transcript.conversation_text = conversationTextParts.map((item) => cleanTranscriptText(item, { preserveRepeats: true, preserveNumbers: true })).filter(Boolean).join('\n').trim();
  transcript.sourceFullText = transcript.rawFullText;
  transcript.normalizedSourceFullText = transcript.rawFullText;
  transcript.cleanEnglish = cleanEnglishParts.map((item) => cleanTranscriptText(item, { preserveRepeats: true, preserveNumbers: true })).filter(Boolean).join('\n').trim();
  if (transcript.cleanEnglish && transcript.rawFullText && isSuspiciousShrinkage(transcript.rawFullText, transcript.cleanEnglish)) {
    transcript.cleanEnglish = '';
  }
  transcript.translatedEnglish = transcript.cleanEnglish;
  transcript.rawTranscriptNormalized = transcript.rawFullText || cleanTranscriptText(allSegments.map((segment) => segment.sourceText || segment.text).join(' '), { preserveRepeats: true, preserveNumbers: true });
  transcript.rawTranscript = transcript.rawFullText;
  transcript.normalizedTranscript = transcript.rawTranscriptNormalized;
  // PRESERVE_ORIGINAL: source text is always primary — English only if source is empty
  transcript.finalValidatedText = selectValidatedFinalText({
    conversation_text: transcript.conversation_text,
    validatedSourceText: transcript.conversation_text || transcript.rawTranscriptNormalized,
    sourceFullText: transcript.conversation_text || transcript.rawTranscriptNormalized,
    rawFullText: transcript.conversation_text || transcript.rawFullText,
    fullText: transcript.conversation_text || transcript.fullText,
    displayText: transcript.conversation_text || transcript.displayText,
    translatedEnglish: transcript.cleanEnglish,  // English last
  }, '');
  transcript.fullText = transcript.finalValidatedText;
  transcript.displayText = transcript.finalValidatedText;
  transcript.uncertainTerms = Array.from(uncertainTerms);
  transcript.confidenceNotes = confidenceNotes.filter(Boolean).join(' | ').slice(0, 4000);
  transcript.segments = allSegments;
  const { buildSpeakerTurns } = require('../utils/transcriptGrouping');
  transcript.groupedSpeakerTurns = buildSpeakerTurns(transcript.segments);
  transcript.speakerCount = new Set(transcript.groupedSpeakerTurns.map((turn) => turn.speaker)).size;
  transcript.lastChunkIndex = lastChunkIndex;
  transcript.chunkCountMerged = chunkDocs.length;
  transcript.quality = {
    ...(transcript.quality || {}),
    sourceWordCount: tokenizeUnicode(transcript.rawFullText || '').length,
    englishWordCount: tokenizeUnicode(transcript.cleanEnglish || '').length,
    translationWordRatio: tokenizeUnicode(transcript.rawFullText || '').length > 0
      ? Number((tokenizeUnicode(transcript.cleanEnglish || '').length / Math.max(1, tokenizeUnicode(transcript.rawFullText || '').length)).toFixed(3))
      : null,
    coverageRatio: transcript.finalValidatedText
      ? Number((normalizeTranscriptText((transcript.groupedSpeakerTurns || []).map((turn) => turn.text || '').join(' ')).length / Math.max(1, normalizeTranscriptText(transcript.finalValidatedText).length)).toFixed(3))
      : 1,
    suspiciousTranslationShrinkage: Boolean(
      transcript.rawFullText && transcript.cleanEnglish && isSuspiciousShrinkage(transcript.rawFullText, transcript.cleanEnglish)
    ),
    displayWarning: false,
    fallbackReason: transcript.cleanEnglish ? 'none' : (transcript.rawFullText ? 'source_preserving_fallback_recommended' : 'none'),
  };
  transcript.fallbackReason = transcript.quality.fallbackReason || 'none';

  const chunkDiarizationStates = chunkDocs
    .map((chunk) => chunk?.diagnostics?.diarization)
    .filter((item) => item && typeof item === 'object');
  const latestDiarization = chunkDiarizationStates.length ? chunkDiarizationStates[chunkDiarizationStates.length - 1] : null;
  const maxSpeakerSegments = chunkDiarizationStates.reduce((max, item) => Math.max(max, Number(item?.speakerSegments || item?.segments || 0)), 0);
  const maxSpeakersBeforeGrouping = chunkDiarizationStates.reduce((max, item) => Math.max(max, Number(item?.speakersBeforeGrouping || 0)), 0);
  const maxSpeakersAfterGrouping = chunkDiarizationStates.reduce((max, item) => Math.max(max, Number(item?.speakersAfterGrouping || 0)), 0);

  transcript.diarization = latestDiarization
    ? {
        ...transcript.diarization,
        ...latestDiarization,
        speakerSegments: maxSpeakerSegments,
        speakersBeforeGrouping: Math.max(maxSpeakersBeforeGrouping, Number(latestDiarization?.speakersBeforeGrouping || 0)),
        segmentSpeakersAfterMerge: Math.max(Number(latestDiarization?.segmentSpeakersAfterMerge || 0), transcript.speakerCount || 0),
        speakersAfterGrouping: Math.max(maxSpeakersAfterGrouping, transcript.speakerCount || 0),
        warnings: Array.from(new Set(Array.isArray(latestDiarization?.warnings) ? latestDiarization.warnings : [])),
      }
    : {
        ...(transcript.diarization || {}),
        requested: true,
        eligible: false,
        skipped: true,
        applied: false,
        reason: 'missing_chunk_diarization_debug',
        speakerSegments: 0,
        speakersBeforeGrouping: 0,
        segmentSpeakersAfterMerge: transcript.speakerCount || 0,
        speakersAfterGrouping: transcript.speakerCount || 0,
        warnings: ['No per-chunk diarization diagnostics were available during transcript merge.'],
      };

  transcript.diagnostics = {
    ...(transcript.diagnostics || {}),
    diarizationChunks: chunkDiarizationStates.length,
    diarizationAppliedChunks: chunkDiarizationStates.filter((item) => Boolean(item?.applied)).length,
    diarizationSkippedChunks: chunkDiarizationStates.filter((item) => Boolean(item?.skipped)).length,
  };

  meeting.diarization = {
    ...(meeting.diarization || {}),
    ...(transcript.diarization || {}),
    speakerCount: transcript.speakerCount || 0,
    segments: Number(transcript?.diarization?.speakerSegments || 0),
  };

  const hasUsableText = Boolean(transcript.finalValidatedText || transcript.rawFullText || transcript.cleanEnglish || transcript.segments.length > 0);
  const hasPendingChunks = chunkDocs.some((chunk) => ['uploaded', 'transcribing'].includes(chunk.status));
  const rejectedChunks = chunkDocs.filter((chunk) => ['skipped', 'failed'].includes(chunk.status));
  if (hasUsableText) {
    transcript.processingStatus = hasPendingChunks || !meeting.endTime ? 'partial' : 'completed';
  } else if (hasPendingChunks) {
    transcript.processingStatus = 'processing';
  } else if (rejectedChunks.length > 0) {
    transcript.processingStatus = 'completed';
    transcript.confidenceNotes = transcript.confidenceNotes || 'No transcript text was accepted. Chunks were rejected because no valid speech was detected, the selected language did not match the speech, or ASR hallucination was detected.';
    transcript.lastError = {
      code: 'NO_ACCEPTED_TRANSCRIPT',
      message: transcript.confidenceNotes,
      at: new Date(),
    };
  } else {
    transcript.processingStatus = 'pending';
  }

  transcript.updatedAt = new Date();
  // FIX v8.0: Removed || req.params.meetingId — req is not in scope for this standalone function.
  await persistTranscriptAtomic(meeting.meetingId, transcript);

  await AudioChunk.updateMany(
    { meetingId: meeting.meetingId, status: 'transcribed' },
    { $set: { transcriptMergeStatus: 'merged', transcriptMergedAt: new Date() } }
  );

  meeting.stats.transcriptUpdatedAt = transcript.updatedAt;
  meeting.lastTranscriptAt = transcript.updatedAt;
  if (hasUsableText) meeting.lastError = undefined;
  await rebuildMeetingStats(meeting);
  await meeting.save();

  eventBus.emit('transcript_updated', {
    meetingId: meeting.meetingId,
    deviceId: meeting.deviceId || null,
    chunkIndex: lastChunkIndex,
    durationSecTotal: Number(meeting.stats?.durationSec || 0),
    chunksUploaded: Number(meeting.stats?.chunksUploaded || 0),
    chunksCompleted30s: Number(meeting.stats?.chunksCompleted30s || 0),
    hasFinalPartialChunk: Boolean(meeting.stats?.hasFinalPartialChunk),
    textLength: transcript.fullText.length,
    segmentsCount: transcript.segments.length,
    fullText: transcript.conversation_text || transcript.fullText,
    rawFullText: transcript.conversation_text || transcript.rawFullText,
    cleanEnglish: transcript.cleanEnglish,
    uncertainTerms: transcript.uncertainTerms,
    confidenceNotes: transcript.confidenceNotes,
    segments: transcript.segments,
    groupedSpeakerTurns: transcript.groupedSpeakerTurns,
    processingStatus: transcript.processingStatus,
  });

  return transcript;
}

async function markTranscriptFailure(meeting, chunkIndex, error) {
  const transcript = await getOrCreateTranscript(meeting);
  transcript.processingStatus = 'failed';
  transcript.lastChunkIndex = Math.max(transcript.lastChunkIndex || -1, chunkIndex);
  transcript.lastError = {
    message: error.message,
    at: new Date(),
  };
  transcript.updatedAt = new Date();
  await persistTranscriptAtomic(meeting.meetingId, transcript);

  meeting.lastError = {
    code: 'TRANSCRIBE_FAILED',
    message: error.message,
    at: new Date(),
  };

  // FIX v8.0: Do NOT mark meeting as failed just because chunksUploaded=0.
  // A transcription error (Python 500, timeout, etc.) marks the chunk 'failed',
  // which is intentionally excluded from chunksUploaded count for stats purposes.
  // But that should NOT propagate to the meeting status — audio WAS uploaded.
  // Only set status=failed if there are truly zero physical chunks in the database.
  const _totalPhysical = Number(meeting.stats?.chunksTotal || meeting.stats?.chunkCount || 0);
  if (_totalPhysical === 0 && (meeting.stats?.chunksUploaded || 0) === 0) {
    meeting.status = 'failed';
  } else {
    meeting.status = meeting.endTime ? 'processing' : 'recording';
  }

  await meeting.save();

  eventBus.emit('meeting_status_changed', {
    meetingId: meeting.meetingId,
    status: meeting.status,
    reason: 'transcribe_failed',
  });
}

// ── Debounced transcript rebuild ───────────────────────────────────────────
// rebuildTranscriptFromChunks is O(n) in chunks. Calling it after EVERY chunk
// causes O(n²) total DB work on long meetings (10 chunks = 10 rebuilds of
// increasingly large arrays). We debounce it so it fires once after the last
// chunk finishes transcribing, with a short window to catch near-simultaneous
// completions.
const REBUILD_DEBOUNCE_MS = Number(process.env.TRANSCRIPT_REBUILD_DEBOUNCE_MS || 1500);
const _rebuildTimers = new Map(); // meetingId → setTimeout handle

function scheduleRebuild(meetingId) {
  if (_rebuildTimers.has(meetingId)) {
    clearTimeout(_rebuildTimers.get(meetingId));
  }
  const handle = setTimeout(async () => {
    _rebuildTimers.delete(meetingId);
    try {
      const freshMeeting = await Meeting.findOne({ meetingId });
      if (freshMeeting) {
        await rebuildTranscriptFromChunks(freshMeeting);
        await rebuildMeetingStats(freshMeeting);
        await freshMeeting.save();
        if (freshMeeting.endTime) {
          await finalizeMeetingStatus(meetingId);
        }
      }
    } catch (err) {
      console.error('[rebuild:debounced:error]', meetingId, err.message);
    }
  }, REBUILD_DEBOUNCE_MS);
  _rebuildTimers.set(meetingId, handle);
}

async function processChunkTranscription(meetingId, chunkDocId, chunkIndex) {
  const meeting = await Meeting.findOne({ meetingId });
  const chunkDoc = await AudioChunk.findById(chunkDocId);
  if (!meeting || !chunkDoc) return;

  let tempDownloadedPath = '';
  try {
    if (chunkDoc.storageProvider === 'r2' && chunkDoc.r2Key) {
      tempDownloadedPath = await downloadR2ObjectToTempFile(
        chunkDoc.r2Key,
        extensionForMime(chunkDoc.mimeType || 'audio/webm')
      );
      chunkDoc.filePath = tempDownloadedPath;
    }

    console.log('[chunk:transcribe:start]', {
      meetingId,
      chunkIndex,
      filePath: chunkDoc.filePath,
      storageProvider: chunkDoc.storageProvider || 'local',
      r2Key: chunkDoc.r2Key || '',
    });
    eventBus.emit('chunk_processing_started', {
      meetingId,
      deviceId: meeting.deviceId || null,
      chunkIndex,
      message: `Processing chunk ${chunkIndex}`,
    });

    // ✅ FIX BUG 9: Minimum duration guard — skip chunks that are too short.
    // Very short chunks (< 1.0s) cause Whisper to hallucinate or produce garbage.
    // ffprobe the file before sending to Python ASR to catch this on the backend side.
    //
    // FIX (ffprobe error): Previously used execSync with bare string 'ffprobe'
    // which fails on Windows when ffprobe is not in PATH.
    // Now uses spawn() with the absolute path from process.env.FFPROBE_BIN
    // (set in backend/.env as C:\ffmpeg\bin\ffprobe.exe).
    // dotenv loads .env at server startup so FFPROBE_BIN is always available.
    // FIX (Bug 1b): processChunkTranscription ffprobe — 3-pass stream-level fallback.
    // Old code: (a) skipped entirely if FFPROBE_BIN not set, (b) only read format.duration
    // which is always 0/absent for fragmented WebM from MediaRecorder.
    // New: default to 'ffprobe' on PATH, use stream-level fallback same as probeAudioDurationAndContainer.
    let probedDuration = null;
    try {
      const ffprobeBin = process.env.FFPROBE_BIN || 'ffprobe'; // never skip — ffprobe is on PATH by default
      const { spawn } = require('child_process');

      const spawnProbe = (args) => new Promise((resolve) => {
        const child = spawn(ffprobeBin, args);
        let stdout = ''; let stderr = '';
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('close', (code) => resolve({ stdout: stdout.trim(), stderr, code }));
        child.on('error', (err) => resolve({ stdout: '', stderr: err.message, code: -1 }));
      });

      // Pass 1+2: get JSON with both format and streams
      const { stdout: out1, code: c1 } = await spawnProbe([
        '-v', 'error', '-show_entries', 'format=duration', '-show_streams', '-of', 'json', chunkDoc.filePath,
      ]);
      if (c1 === 0 && out1) {
        let parsed = {};
        try { parsed = JSON.parse(out1); } catch (_) {}
        const containerDur = Number(parsed?.format?.duration || 0);
        if (Number.isFinite(containerDur) && containerDur > 0.05) {
          probedDuration = containerDur;
        }
        if (!probedDuration) {
          const audioStream = (parsed?.streams || []).find((s) => s.codec_type === 'audio');
          const streamDur = Number(audioStream?.duration || 0);
          if (Number.isFinite(streamDur) && streamDur > 0.05) {
            probedDuration = streamDur;
            console.log('[chunk:ffprobe:stream-fallback]', { meetingId, chunkIndex, probedDuration });
          }
        }
      }
      // Pass 3: targeted stream probe
      if (!probedDuration) {
        const { stdout: out2, code: c2 } = await spawnProbe([
          '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=duration',
          '-of', 'default=noprint_wrappers=1:nokey=1', chunkDoc.filePath,
        ]);
        if (c2 === 0 && out2) {
          const val = parseFloat(out2);
          if (Number.isFinite(val) && val > 0.05) {
            probedDuration = val;
            console.log('[chunk:ffprobe:targeted-fallback]', { meetingId, chunkIndex, probedDuration });
          }
        }
      }
      if (probedDuration) {
        console.log('[FFPROBE] processChunkTranscription', { meetingId, chunkIndex, probedDuration });
      }
    } catch (_probeErr) {
      console.warn('[chunk:ffprobe:exception]', { meetingId, chunkIndex, error: _probeErr.message });
    }

    const MIN_CHUNK_DURATION_SEC = parseFloat(process.env.MIN_CHUNK_DURATION_SEC || '0.5');

    // v8.0 FIX: Detect webm duration mismatch (large file + near-zero duration)
    // This is the "chunk_1 has 415KB but 0.001s" problem.
    // Log it clearly so it's visible in terminal — Python will attempt remux.
    if (probedDuration !== null && probedDuration < 0.1) {
      const fileBytes = fs.existsSync(chunkDoc.filePath) ? fs.statSync(chunkDoc.filePath).size : 0;
      if (fileBytes > 50000) {
        console.warn('[chunk:duration-mismatch]', {
          meetingId,
          chunkIndex,
          reason: 'invalid_webm_chunk_duration_mismatch',
          probedDuration,
          fileSizeBytes: fileBytes,
          note: 'Large file but near-zero duration — Python will attempt ffmpeg remux to repair container',
        });
        // Do NOT skip — let Python's validate_and_repair_chunk() handle it
      }
    }

    if (probedDuration !== null && probedDuration > 0 && probedDuration < MIN_CHUNK_DURATION_SEC) {
      console.warn('[chunk:skipped]', {
        meetingId,
        chunkIndex,
        reason: 'too_short',
        probedDuration,
        minRequired: MIN_CHUNK_DURATION_SEC,
      });
      await AudioChunk.updateOne(
        { _id: chunkDoc._id },
        { $set: { status: 'skipped', transcriptText: '', lastError: { message: `chunk_too_short: ${probedDuration}s < ${MIN_CHUNK_DURATION_SEC}s`, at: new Date() } } }
      );
      scheduleRebuild(meetingId);
      return;
    }

    const result = await transcribeAudioFile({
      filePath: chunkDoc.filePath,
      meetingId,
      language: (() => {
        const chosen = normalizeMeetingLanguage(
          meeting.selectedLanguage || meeting.normalizedLanguage || meeting.language || 'auto'
        );
        return chosen !== 'auto' ? chosen : 'auto';
      })(),
      mimeType: chunkDoc.mimeType,
      filename: chunkDoc.originalName || chunkDoc.fileName,
      originalName: chunkDoc.originalName || chunkDoc.fileName,
      meetingContext: [meeting.title, meeting.meetingContext, meeting.description, meeting.projectName].filter(Boolean).join(' | '),
      chunkDiagnostics: chunkDoc.diagnostics || {},
      diarization: String(process.env.TRANSCRIBE_ENABLE_DIARIZATION || 'false').trim().toLowerCase() === 'true',
      // FIX: Pass timeoutMs explicitly so the service uses the env value (600000ms)
      // instead of its internal 180000ms default. Missing this caused all timeout errors.
      timeoutMs: Number(process.env.TRANSCRIBE_TIMEOUT_MS || 600000),
    });

    // ✅ FIX v8.0: Check raw Python response for usable content.
    // buildSafeResponse() may zero out text fields if its hallucination gate fires.
    // We must check what Python ACTUALLY returned — not what the gate let through —
    // to decide whether to skip. If Python returned real text, we must not skip.
    const _raw = result._rawPythonData || {};
    const pyHasUsableContent = (
      (_raw.conversation_text && String(_raw.conversation_text).trim().length > 2) ||
      (_raw.normalized_text && String(_raw.normalized_text).trim().length > 2) ||
      (_raw.raw_text && String(_raw.raw_text).trim().length > 2) ||
      (_raw.text && String(_raw.text).trim().length > 2) ||
      (Array.isArray(_raw.segments) && _raw.segments.length > 0) ||
      (Array.isArray(_raw.turns) && _raw.turns.length > 0) ||
      // Also check the safe result in case the gate DID pass
      (result.conversation_text && String(result.conversation_text).trim().length > 2) ||
      (result.text && String(result.text).trim().length > 2) ||
      (Array.isArray(result.segments) && result.segments.length > 0) ||
      (Array.isArray(result.groupedSpeakerTurns) && result.groupedSpeakerTurns.length > 0)
    );

    // FIX v8.0: Only skip if Python explicitly rejected (success=false from Python, not from
    // buildSafeResponse gate) AND there's genuinely no raw usable content from Python.
    const pythonExplicitlyRejected = _raw.success === false;
    if ((pythonExplicitlyRejected && !pyHasUsableContent) || (!pyHasUsableContent && !pythonExplicitlyRejected && result.success === false)) {
      console.warn('[chunk:skipped]', {
        meetingId,
        chunkIndex,
        reason: result.transcript_status || result.fallbackReason || 'python_rejected_all_attempts',
        warnings: result.warnings,
      });
      const rejectReason = result.status || result.transcript_status || result.fallbackReason || result.rejection_reason || result?.diarization?.reason || 'python_asr_all_attempts_rejected';
      await AudioChunk.updateOne(
        { _id: chunkDoc._id },
        { $set: { status: 'skipped', transcriptStatus: result.transcript_status || 'error', rejectionReason: rejectReason, transcriptText: '', conversationText: '', lastError: { message: rejectReason, at: new Date() } } }
      );
      eventBus.emit('chunk_rejected', {
        meetingId,
        chunkIndex,
        reason: rejectReason,
        transcriptStatus: result.transcript_status || 'error',
      });
      eventBus.emit('transcript_rejected', { meetingId, chunkIndex, reason: rejectReason });
      scheduleRebuild(meetingId);
      return;
    }

    const pyNeedsReview = Boolean(result.needs_review || result.needsReview);

    // ============================================================
    // PATCH APPLIED HERE: FIX for Python snake_case fields
    // FIX v8.0: Also fall back to _rawPythonData when buildSafeResponse gate
    // zeroed out text fields. This ensures accepted raw Python text is used.
    // ============================================================
    const normalizedSourceChunkText = cleanTranscriptText(
      String(
        result.conversation_text       ||
        result.sourceFullText          ||
        result.rawFullText             ||
        result.rawTranscriptNormalized ||
        result.rawTranscript           ||
        result.validatedSourceText     ||
        result.normalized_text         ||   // ← Python field (may be zeroed by gate)
        result.raw_text                ||   // ← Python field (may be zeroed by gate)
        result.text                    ||   // ← Python field (may be zeroed by gate)
        result.displayText             ||
        result.fullText                ||
        // FIX v8.0: Fall back to raw Python data if gate zeroed out safe response
        _raw.conversation_text         ||
        _raw.normalized_text           ||
        _raw.raw_text                  ||
        _raw.text                      ||
        ''
      ).trim(),
      { preserveRepeats: true, preserveNumbers: true }
    );

    let normalizedEnglishChunkText = cleanTranscriptText(
      String(
        result.validatedEnglishText ||
        result.translatedEnglish ||
        result.cleanEnglish ||
        ''
      ).trim(),
      { preserveRepeats: true, preserveNumbers: true }
    );
    if (normalizedEnglishChunkText && normalizedSourceChunkText && isSuspiciousShrinkage(normalizedSourceChunkText, normalizedEnglishChunkText)) {
      normalizedEnglishChunkText = '';
    }
    // PRESERVE_ORIGINAL: source chunk text must win — English is secondary
    const normalizedChunkText = selectValidatedFinalText({
      validatedSourceText: normalizedSourceChunkText,
      sourceFullText: normalizedSourceChunkText,
      rawFullText: normalizedSourceChunkText,
      finalValidatedText: result.finalValidatedText  ||
                           result.finalBestTranscript ||
                           result.displayText         ||
                           result.fullText            ||
                           result.conversation_text   ||  // ← Python field
                           result.normalized_text     ||  // ← Python field
                           result.text,                   // ← Python field
      // English only as absolute fallback
      translatedEnglish: normalizedEnglishChunkText,
    }, '');
    // ============================================================
    // END OF PATCH
    // ============================================================

    const sourceAssessment = assessTranscriptCandidate(normalizedSourceChunkText, { preserveRepeats: true, preserveNumbers: true, minWords: 1 });
    const englishAssessment = assessTranscriptCandidate(normalizedEnglishChunkText, { preserveRepeats: true, preserveNumbers: true, minWords: 1 });
    const finalAssessment = assessTranscriptCandidate(normalizedChunkText || normalizedEnglishChunkText || normalizedSourceChunkText, { preserveRepeats: true, preserveNumbers: true, minWords: 1 });
    // PRESERVE_ORIGINAL: source text is the display text.
    // English assessment only used if source is completely empty.
    const acceptedText = sourceAssessment.accepted
      ? sourceAssessment.text
      : (finalAssessment.accepted ? finalAssessment.text : (englishAssessment.accepted ? englishAssessment.text : ''));
    const acceptedSourceText = sourceAssessment.accepted ? sourceAssessment.text : '';
    const rejectionReason = acceptedText ? null : (finalAssessment.reason || englishAssessment.reason || sourceAssessment.reason || 'garbage_noise_output');

    const finalGroupedTurns = Array.isArray(result.groupedSpeakerTurns) && result.groupedSpeakerTurns.length > 0
      ? result.groupedSpeakerTurns
      : (Array.isArray(result.turns) && result.turns.length > 0
        ? result.turns
        : (acceptedText ? [{ speaker: 'Speaker 1', speaker_id: 'SPEAKER_1', text: acceptedText, start: 0, end: 0, segment_count: 1 }] : []));

    console.log('[chunk:transcribed]', {
      meetingId,
      chunkIndex,
      textLength: normalizedChunkText.length,
      rawTextLength: normalizedSourceChunkText.length,
      detectedLanguage: result.languageDetected || result.language || 'auto',
      segmentCount: Array.isArray(result.segments) ? result.segments.length : 0,
      groupedTurnCount: finalGroupedTurns.length,
      displayWarning: Boolean(result.displayWarning),
      coverageRatio: result.coverageRatio,
      needsReview: Boolean(pyNeedsReview || result.needs_review),
    });

    await AudioChunk.updateOne(
      { _id: chunkDoc._id },
      {
        $set: {
          status: 'transcribed',
          transcriptText: acceptedText || '',
          conversationText: String(result.conversation_text || acceptedText || '').trim(),
          rawText: String(result.raw_text || '').trim(),
          normalizedText: String(result.normalized_text || '').trim(),
          modelUsed: String(result.model_used || result.usedModel || '').trim(),
          fallbackUsed: Boolean(result.fallback_used || result.usedFallback),
          displayTranscriptText: acceptedText || '',
          finalValidatedText: acceptedText || '',
          rawTranscriptText: acceptedSourceText || '',
          cleanEnglishTranscript: englishAssessment.accepted ? englishAssessment.text : '',
          translatedEnglishTranscript: englishAssessment.accepted ? englishAssessment.text : '',
          sourceTranscriptText: acceptedSourceText || '',
          normalizedSourceTranscript: acceptedSourceText || '',
          rawTranscriptNormalized: acceptedSourceText || '',
          transcriptAcceptance: {
            accepted: Boolean(acceptedText),
            rejectionReason: rejectionReason || null,
            acceptedText: acceptedText || '',
            acceptedSourceText: acceptedSourceText || '',
          },
          transcriptWarnings: Array.isArray(result.warnings) ? result.warnings : [],
          translationWarnings: Array.isArray(result.translationWarnings) ? result.translationWarnings : [],
          uncertainTerms: Array.isArray(result.uncertainTerms) ? result.uncertainTerms : [],
          confidenceNotes: Array.isArray(result.confidenceNotes)
            ? result.confidenceNotes.filter(Boolean).join(' | ')
            : String(result.confidenceNotes || '').trim(),
          transcriptLanguage: String(
            normalizeMeetingLanguage(result.language || result.languageDetected || meeting.language)
          ).trim(),
          transcriptSourceLanguage: String(
            normalizeMeetingLanguage(result.languageDetected || result.language || meeting.language)
          ).trim(),
          transcriptLanguages: Array.isArray(result.languages) ? result.languages : [],
          groupedSpeakerTurns: finalGroupedTurns,
          transcriptQuality: {
            coverageRatio: typeof result.coverageRatio === 'number' ? result.coverageRatio : null,
            sourceWordCount: Number(result?.quality?.sourceWordCount || 0),
            englishWordCount: Number(result?.quality?.englishWordCount || 0),
            translationWordRatio: typeof result?.quality?.translationWordRatio === 'number' ? result.quality.translationWordRatio : null,
            suspiciousTranslationShrinkage: Boolean(result?.quality?.suspiciousTranslationShrinkage),
            displayWarning: Boolean(result.displayWarning || result?.quality?.displayWarning),
            needsReview: Boolean(pyNeedsReview || result.needs_review),
          },
          transcriptSegments: acceptedText && Array.isArray(result.segments)
            ? result.segments.map((segment, index) => ({ ...segment, id: Number.isFinite(Number(segment?.id)) ? Number(segment.id) : index, chunkIndex }))
            : [],
          transcriptMergeStatus: 'pending',
          transcriptMergedAt: null,
          diagnostics: {
            ...(chunkDoc.diagnostics || {}),
            detectedLanguage: String(result.languageDetected || result.language || '').trim(),
            segmentCount: Array.isArray(result.segments) ? result.segments.length : 0,
            groupedTurnCount: finalGroupedTurns.length,
            displayWarning: Boolean(result.displayWarning || result?.quality?.displayWarning),
            coverageRatio: typeof result.coverageRatio === 'number' ? result.coverageRatio : null,
            translationWordRatio: typeof result?.quality?.translationWordRatio === 'number' ? result.quality.translationWordRatio : null,
            suspiciousTranslationShrinkage: Boolean(result?.quality?.suspiciousTranslationShrinkage),
            ffmpeg: String(result?.diagnostics?.ffmpeg || chunkDoc?.diagnostics?.ffmpeg || ''),
            rms: typeof result?.diagnostics?.wavStats?.rms === 'number' ? result.diagnostics.wavStats.rms : (chunkDoc?.diagnostics?.rms ?? null),
            inputContainer: String(result?.diagnostics?.inputContainer || chunkDoc?.diagnostics?.inputContainer || ''),
            outputFormat: String(result?.diagnostics?.outputFormat || chunkDoc?.diagnostics?.outputFormat || ''),
            sampleRate: typeof result?.diagnostics?.wavStats?.rate === 'number' ? result.diagnostics.wavStats.rate : (chunkDoc?.diagnostics?.sampleRate ?? null),
            channels: typeof result?.diagnostics?.wavStats?.channels === 'number' ? result.diagnostics.wavStats.channels : (chunkDoc?.diagnostics?.channels ?? null),
            diarization: result?.diarization || null,
          },
          lastError: { message: null, at: null },
        },
      }
    );

    if (!acceptedText) {
      eventBus.emit('transcript_rejected', {
        meetingId,
        deviceId: meeting.deviceId || null,
        chunkIndex,
        rejectionReason,
        message: `Rejected chunk ${chunkIndex} transcript: ${rejectionReason}`,
      });
    } else {
      eventBus.emit('chunk_transcribed', {
        meetingId,
        deviceId: meeting.deviceId || null,
        chunkIndex,
        text: acceptedText,
        conversation_text: String(result.conversation_text || acceptedText || '').trim(),
        transcriptDelta: acceptedText,
        language: result.language || result.languageDetected || meeting.language || 'auto',
        model_used: result.model_used || result.usedModel || '',
        fallback_used: Boolean(result.fallback_used || result.usedFallback),
        confidence: result.confidence || '',
        message: `Accepted chunk ${chunkIndex} transcript`,
      });
      eventBus.emit('transcript_delta', {
        meetingId,
        deviceId: meeting.deviceId || null,
        chunkIndex,
        transcriptDelta: acceptedText,
        // v17 FIX: Include full conversation_text so frontend renders correctly
        conversation_text: String(result.conversation_text || acceptedText || '').trim(),
        language: result.language || result.languageDetected || meeting.selectedLanguage || 'auto',
        confidence: result.confidence || '',
        turns: Array.isArray(result.turns) ? result.turns : [],
        segments: Array.isArray(result.segments) ? result.segments.slice(0, 20) : [],
        message: String(result.conversation_text || acceptedText || '').trim(),
      });
    }

    // Schedule debounced rebuild — avoids O(n²) DB work on long meetings.
    // The rebuild fires REBUILD_DEBOUNCE_MS after the last chunk completes.
    scheduleRebuild(meetingId);
  } catch (transcribeErr) {
    const errMsg = String(transcribeErr?.message || transcribeErr || '');
    const isTimeout = /timeout|ECONNABORTED|ETIMEDOUT|180000|600000/i.test(errMsg);
    const isConnRefused = /ECONNREFUSED|ECONNRESET/i.test(errMsg);

    if (isTimeout) {
      // FIX: Timeout errors must NOT re-throw — they crash the SSE stream and
      // show "Network error. Please check your connection." on the frontend.
      // The chunk is simply marked failed and the meeting continues.
      console.warn(`[chunk:transcribe:timeout] meetingId=${meetingId} chunkIndex=${chunkIndex} — chunk skipped (timeout)`);
    } else if (isConnRefused) {
      console.warn(`[chunk:transcribe:conn_error] meetingId=${meetingId} chunkIndex=${chunkIndex} — Python service unreachable`);
    } else {
      console.error(`[chunk:transcribe:error] meetingId=${meetingId} chunkIndex=${chunkIndex}:`, errMsg.slice(0, 200));
    }

    // Always update chunk status to failed — never re-throw to caller
    try {
      await AudioChunk.updateOne(
        { _id: chunkDoc._id },
        {
          $set: {
            status: 'failed',
            transcriptText: '',
            rawTranscriptText: '',
            cleanEnglishTranscript: '',
            rawTranscriptNormalized: '',
            uncertainTerms: [],
            confidenceNotes: '',
            transcriptSegments: [],
            transcriptMergeStatus: 'failed',
            transcriptMergedAt: null,
            lastError: { message: errMsg.slice(0, 500), at: new Date() },
          },
          $inc: { retries: 1 },
        }
      );
      const freshMeeting = await Meeting.findOne({ meetingId });
      if (freshMeeting) {
        await rebuildMeetingStats(freshMeeting);
        await freshMeeting.save();
        await markTranscriptFailure(freshMeeting, chunkIndex, transcribeErr);
      }
    } catch (cleanupErr) {
      console.error('[chunk:transcribe:cleanup_error]', cleanupErr.message);
    }

    // Only emit system_error for non-timeout issues (timeout is expected on slow hardware)
    if (!isTimeout) {
      eventBus.emit('system_error', {
        code: 'transcription-service-error',
        title: 'Transcription service error',
        message: isConnRefused
          ? 'Python transcription service is not running. Start it with: python main.py'
          : (transcribeErr.message || 'Chunk transcription failed.'),
        meetingId,
        deviceId: meeting.deviceId || null,
        dedupeKey: `transcription-service-error:${meetingId}:${chunkIndex}`,
      });
    }
    // FIX: No re-throw. Returning here prevents the error from reaching the SSE handler.
  }
}

async function finalizeMeetingStatus(meetingId) {
  const meeting = await Meeting.findOne({ meetingId });
  if (!meeting) return null;

  await rebuildMeetingStats(meeting);

  const [transcript, chunkDocs] = await Promise.all([
    Transcript.findOne({ meetingId }),
    getStoredChunks(meetingId),
  ]);
  const transcriptText = String(
    transcript?.fullText || transcript?.cleanEnglish || transcript?.rawFullText || ''
  ).trim();
  const hasTranscript = transcriptText.length > 0 || Number(transcript?.segments?.length || 0) > 0;
  const hasPendingChunks = chunkDocs.some((chunk) => ['uploaded', 'transcribing'].includes(chunk.status));
  const hasFailedChunks = chunkDocs.some((chunk) => chunk.status === 'failed');
  const hasTranscriptionError =
    meeting.lastError?.code === 'TRANSCRIBE_FAILED' ||
    transcript?.processingStatus === 'failed' ||
    hasFailedChunks;

  if (hasPendingChunks) {
    meeting.status = 'processing';
  } else if (hasTranscriptionError && !hasTranscript && Number(meeting.stats?.chunksUploaded || 0) === 0) {
    meeting.status = 'failed';
  } else if (hasTranscript) {
    // Only mark completed if we actually have transcript text
    meeting.status = 'completed';
  } else if (Number(meeting.stats?.chunksUploaded || 0) > 0 && !hasTranscript) {
    // Chunks uploaded but no transcript yet — still processing
    meeting.status = 'processing';
  } else {
    meeting.status = 'processing';
  }

  if (meeting.source === 'web') {
    meeting.stats.durationSec = computeTimelineDurationSec(
      meeting,
      meeting.stats.lastClientDurationSec
    );
  }

  await meeting.save();

  eventBus.emit('meeting_status_changed', {
    meetingId: meeting.meetingId,
    status: meeting.status,
    reason: 'meeting_finalized',
  });

  return meeting;
}

async function cleanupStaleDeviceMeeting(deviceId) {
  if (!deviceId) return;
  const device = await Device.findOne({ deviceId });
  if (!device || !device.currentMeetingId) return;

  const staleMeeting = await Meeting.findOne({ meetingId: device.currentMeetingId });
  if (!staleMeeting) {
    device.currentMeetingId = null;
    await device.save();
    return;
  }

  if (staleMeeting.status === 'recording') {
    staleMeeting.status =
      Number(staleMeeting.stats?.chunksUploaded || 0) > 0 ? 'completed' : 'failed';
    staleMeeting.endTime = staleMeeting.endTime || new Date();
    await rebuildMeetingStats(staleMeeting);

    if (staleMeeting.status === 'failed' && !staleMeeting.lastError?.code) {
      staleMeeting.lastError = {
        code: 'STALE_REPLACED',
        message: 'Previous stale ESP32 recording was replaced by a new one',
        at: new Date(),
      };
    }

    await staleMeeting.save();
    eventBus.emit('meeting_status_changed', {
      meetingId: staleMeeting.meetingId,
      status: staleMeeting.status,
      reason: 'stale_replaced',
    });
  }

  device.currentMeetingId = null;
  device.status = 'online';
  device.lastSeenAt = new Date();
  await device.save();
}

const startMeetingHandler = async (req, res, next) => {
  try {
    const {
      source,
      deviceId,
      language,
      title,
      audioMode,
      noiseReduction,
      sampleRate,
    } = req.body;

    const normalizedSource = source || 'web';
    const deviceDriven = isDeviceDrivenRequest(req);
    const webConfig = normalizeWebConfig({ audioMode, noiseReduction, sampleRate });

    if (normalizedSource === 'esp32' && deviceId && !deviceDriven) {
      const device = await Device.findOne({ deviceId });
      if (!device) {
        return res.status(404).json({
          success: false,
          error: { code: 'DEVICE_NOT_FOUND', message: 'Device not found' },
        });
      }
      if (!isFreshDevice(device)) {
        return res.status(409).json({
          success: false,
          error: {
            code: 'DEVICE_OFFLINE',
            message: 'ESP32 device is offline or heartbeat is stale',
          },
        });
      }

      await cleanupStaleDeviceMeeting(deviceId);

      const provisionalMeetingId = `mtg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const initialStorage = buildMeetingStorageMetadata(language, provisionalMeetingId);
      const meeting = await Meeting.create({
        meetingId: provisionalMeetingId,
        title: title || `ESP32 Recording ${new Date().toLocaleString()}`,
        language: normalizeMeetingLanguage(language),
        selectedLanguage: initialStorage.selectedLanguage,
        normalizedLanguage: initialStorage.normalizedLanguage,
        storageFolder: initialStorage.storageFolder,
        storagePath: initialStorage.storagePath,
        deviceId,
        source: 'esp32',
        status: 'idle',
        visible: false,
        visibilityReason: 'pending_min_duration',
        startTime: null,
        createdBy: req.user?._id || null,
      });

      await ensureMeetingStorageDirectory(meeting);
      console.log('[audio-storage:start]', {
        meetingId: meeting.meetingId,
        selectedLanguage: meeting.selectedLanguage,
        normalizedLanguage: meeting.normalizedLanguage,
        storageFolder: meeting.storageFolder,
        storagePath: meeting.storagePath,
      });

      await Transcript.create({
        meetingId: meeting.meetingId,
        fullText: '',
        segments: [],
        language: meeting.language,
        processingStatus: 'pending',
      });
      await queueDeviceCommand(deviceId, 'start', meeting);
      eventBus.emit('meeting_status_changed', {
        meetingId: meeting.meetingId,
        status: 'idle',
        reason: 'awaiting_esp32_start',
      });

      return res.status(202).json({
        success: true,
        data: {
          ...meeting.toObject(),
          commandQueued: true,
          deviceStatus: 'start_requested',
        },
      });
    }

    if (deviceId && normalizedSource === 'esp32') {
      await cleanupStaleDeviceMeeting(deviceId);
      await Device.findOneAndUpdate(
        { deviceId },
        {
          $set: {
            name: deviceId,
            status: 'online',
            lastSeenAt: new Date(),
            currentMeetingId: null,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    } else if (deviceId) {
      const device = await Device.findOne({ deviceId });
      if (!device) {
        return res.status(404).json({
          success: false,
          error: { code: 'DEVICE_NOT_FOUND', message: 'Device not found' },
        });
      }
    }

    const provisionalMeetingId = `mtg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const initialStorage = buildMeetingStorageMetadata(language, provisionalMeetingId);

    const meeting = await Meeting.create({
      meetingId: provisionalMeetingId,
      title: title || `Meeting ${new Date().toLocaleString()}`,
      language: normalizeMeetingLanguage(language),
      selectedLanguage: initialStorage.selectedLanguage,
      normalizedLanguage: initialStorage.normalizedLanguage,
      storageFolder: initialStorage.storageFolder,
      storagePath: initialStorage.storagePath,
      deviceId: deviceId || null,
      source: normalizedSource,
      sourceConfig: normalizedSource === 'web' ? webConfig : undefined,
      status: 'recording',
      visible: false,
      visibilityReason: 'pending_min_duration',
      startTime: new Date(),
      createdBy: req.user?._id || null,
    });

    await ensureMeetingStorageDirectory(meeting);
    console.log('[audio-storage:start]', {
      meetingId: meeting.meetingId,
      selectedLanguage: meeting.selectedLanguage,
      normalizedLanguage: meeting.normalizedLanguage,
      storageFolder: meeting.storageFolder,
      storagePath: meeting.storagePath,
    });

    if (deviceId) {
      await Device.findOneAndUpdate(
        { deviceId },
        {
          currentMeetingId: meeting.meetingId,
          status: 'online',
          lastSeenAt: new Date(),
          'control.pendingCommand': 'none',
          'control.meetingId': meeting.meetingId,
        }
      );
    }

    await Transcript.create({
      meetingId: meeting.meetingId,
      fullText: '',
      segments: [],
      language: meeting.language,
      processingStatus: 'pending',
    });

    eventBus.emit('recording_started', {
      meetingId: meeting.meetingId,
      deviceId: meeting.deviceId,
      startTime: meeting.startTime,
      source: meeting.source,
      webConfig: meeting.sourceConfig || null,
    });

    res.status(201).json({ success: true, data: meeting });
  } catch (error) {
    next(error);
  }
};

router.post('/start', requireAuthUnlessEsp32, startMeetingHandler);
router.post('/', requireAuthUnlessEsp32, startMeetingHandler);

const endMeetingHandler = async (req, res, next) => {
  try {
    const meeting = await findMeetingByAnyId(req.params.id);
    if (!meeting) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Meeting not found' },
      });
    }

    const deviceDriven = isDeviceDrivenRequest(req);
    if (meeting.source === 'esp32' && meeting.deviceId && !deviceDriven) {
      const device = await Device.findOne({ deviceId: meeting.deviceId });
      if (device && isFreshDevice(device)) {
        await queueDeviceCommand(meeting.deviceId, 'stop', meeting);
        return res.json({
          success: true,
          data: {
            meetingId: meeting.meetingId,
            status: 'stop_requested',
            message: 'Stop command sent to ESP32 device',
          },
        });
      }
    }

    meeting.status = 'processing';
    meeting.endTime = new Date();
    await rebuildMeetingStats(meeting);
    meeting.stats.durationSec = computeTimelineDurationSec(
      meeting,
      meeting.stats.lastClientDurationSec
    );

    if (meeting.source === 'web' && Number(meeting.stats.durationSec || 0) < 20) {
      await AudioChunk.deleteMany({ meetingId: meeting.meetingId });
      await Transcript.deleteMany({ meetingId: meeting.meetingId });
      meeting.status = 'cancelled_short';
      meeting.visible = false;
      meeting.visibilityReason = 'duration_less_than_20_seconds';
      meeting.lastError = {
        code: 'MEETING_TOO_SHORT',
        message: 'Meeting is not created because recording time is less than 20 seconds.',
        at: new Date(),
      };
      await meeting.save();
      eventBus.emit('meeting_finalized', {
        meetingId: meeting.meetingId,
        status: 'cancelled_short',
        visible: false,
        message: 'Meeting is not created because recording time is less than 20 seconds.',
      });
      return res.json({
        success: true,
        data: {
          meetingId: meeting.meetingId,
          status: 'cancelled_short',
          visible: false,
          message: 'Meeting is not created because recording time is less than 20 seconds.',
        },
      });
    }

    meeting.visible = true;
    meeting.visibilityReason = 'duration_at_least_20_seconds';
    await meeting.save();

    if (meeting.deviceId) {
      await Device.findOneAndUpdate(
        { deviceId: meeting.deviceId },
        {
          currentMeetingId: null,
          status: 'online',
          lastSeenAt: new Date(),
          'control.pendingCommand': 'none',
          'control.meetingId': null,
        }
      );
    }

    eventBus.emit('recording_stopped', {
      meetingId: meeting.meetingId,
      deviceId: meeting.deviceId,
      endTime: meeting.endTime,
      duration: Number(meeting.stats.durationSec || 0),
      chunksUploaded: Number(meeting.stats?.chunksUploaded || 0),
      chunksCompleted30s: Number(meeting.stats?.chunksCompleted30s || 0),
      hasFinalPartialChunk: Boolean(meeting.stats?.hasFinalPartialChunk),
    });

    setTimeout(async () => {
      try {
        await finalizeMeetingStatus(meeting.meetingId);
      } catch (err) {
        console.error('Async meeting finalization failed:', err.message);
      }
    }, 2000);

    res.json({ success: true, data: meeting });
  } catch (error) {
    next(error);
  }
};

router.post('/:id/end', requireAuthUnlessEsp32, endMeetingHandler);
router.post('/:id/stop', requireAuthUnlessEsp32, endMeetingHandler);

router.get('/', auth, async (req, res, next) => {
  try {
    const {
      status,
      deviceId,
      language,
      from,
      to,
      q,
      page = 1,
      limit = 20,
      sort = '-createdAt',
    } = req.query;

    const query = {};
    if (req.query.includeHidden !== 'true') {
      query.visible = { $ne: false };
      query.status = { $nin: ['aborted', 'cancelled_short'] };
    }
    if (status) query.status = status;
    if (deviceId) query.deviceId = deviceId;
    if (language) query.language = normalizeMeetingLanguage(language);
    if (from || to) {
      query.createdAt = {};
      if (from) query.createdAt.$gte = new Date(from);
      if (to) query.createdAt.$lte = new Date(to);
    }
    if (q) {
      query.$or = [
        { title: { $regex: q, $options: 'i' } },
        { meetingId: { $regex: q, $options: 'i' } },
      ];
    }

    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;
    const [meetings, total] = await Promise.all([
      Meeting.find(query).sort(sort).skip(skip).limit(limitNum).lean(),
      Meeting.countDocuments(query),
    ]);

    res.json({
      success: true,
      data: {
        items: meetings,
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', auth, async (req, res, next) => {
  try {
    const meeting = await findMeetingByAnyId(req.params.id);
    if (!meeting) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Meeting not found' },
      });
    }
    res.json({ success: true, data: meeting });
  } catch (error) {
    next(error);
  }
});


router.post('/:id/chunks/presign', requireAuthUnlessEsp32, express.json({ limit: '1mb' }), async (req, res, next) => {
  try {
    const meeting = await findMeetingByAnyId(req.params.id);
    if (!meeting) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Meeting not found' } });
    }
    if (!isR2Enabled()) {
      return res.status(503).json({
        success: false,
        error: { code: 'R2_DISABLED', message: 'R2 is not configured; use local /chunks upload fallback.' },
      });
    }

    const chunkIndex = Number(req.body?.chunkIndex ?? 0);
    const mimeType = String(req.body?.mimeType || 'audio/webm').split(';')[0];
    const sizeBytes = Number(req.body?.sizeBytes || 0);
    const presign = await createPresignedPutUrl({
      userId: req.user?._id || req.user?.id || 'local',
      meetingId: meeting.meetingId,
      chunkIndex,
      mimeType,
      sizeBytes,
      checksum: req.body?.checksum || '',
    });

    return res.json({ success: true, data: presign });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/chunks/complete', requireAuthUnlessEsp32, express.json({ limit: '2mb' }), async (req, res, next) => {
  try {
    const meeting = await findMeetingByAnyId(req.params.id);
    if (!meeting) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Meeting not found' } });
    }
    if (!isR2Enabled()) {
      return res.status(503).json({ success: false, error: { code: 'R2_DISABLED', message: 'R2 is not configured' } });
    }

    const chunkIndex = Number(req.body?.chunkIndex ?? 0);
    const r2Key = String(req.body?.r2Key || '').trim();
    if (!Number.isFinite(chunkIndex) || chunkIndex < 0 || !r2Key) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_CHUNK_COMPLETE', message: 'chunkIndex and r2Key are required' } });
    }

    const objectHead = await headR2Object(r2Key);
    const durationSec = Math.max(0, Number(req.body?.durationSec || 0));
    const chunkStartSec = roundTimelineSeconds(req.body?.chunkStartSec) ?? Math.max(0, chunkIndex * 60);
    const chunkEndSec = roundTimelineSeconds(req.body?.chunkEndSec) ?? Number((chunkStartSec + durationSec).toFixed(3));
    const durationMs = Math.max(0, Math.round((chunkEndSec - chunkStartSec) * 1000));
    const mimeType = String(objectHead.contentType || req.body?.mimeType || 'audio/webm').split(';')[0];
    const isFinalPartialChunk = Boolean(req.body?.isFinalPartialChunk) || (durationMs > 0 && durationMs < 58000);
    const storedFilename = path.basename(r2Key);

    const chunkDoc = await AudioChunk.findOneAndUpdate(
      { meetingId: meeting.meetingId, chunkIndex },
      {
        $set: {
          chunkNumber: chunkIndex,
          source: meeting.source,
          storageProvider: 'r2',
          r2Bucket: process.env.R2_BUCKET_NAME || '',
          r2Key,
          r2ETag: objectHead.eTag || '',
          r2Url: process.env.R2_PUBLIC_BASE_URL ? `${String(process.env.R2_PUBLIC_BASE_URL).replace(/\/$/, '')}/${r2Key}` : '',
          uploadCompletedAt: new Date(),
          mimeType,
          originalName: storedFilename,
          fileName: storedFilename,
          filePath: r2Key,
          sizeBytes: Number(req.body?.sizeBytes || objectHead.contentLength || 0),
          durationMs,
          durationSource: 'client',
          checksum: String(req.body?.checksum || objectHead.metadata?.checksum || ''),
          uploadToken: String(req.body?.uploadToken || ''),
          chunkTimestamp: new Date(),
          chunkStartSec,
          chunkEndSec,
          startedAtMs: Math.round(chunkStartSec * 1000),
          endedAtMs: Math.round(chunkEndSec * 1000),
          sequenceStartMs: Math.round(chunkStartSec * 1000),
          sequenceEndMs: Math.round(chunkEndSec * 1000),
          clientCapturedAt: req.body?.clientCapturedAt ? new Date(req.body.clientCapturedAt) : new Date(),
          finalChunk: Boolean(req.body?.isFinalPartialChunk || meeting.endTime),
          partialChunk: durationMs > 0 && durationMs < 58000,
          isFinalPartialChunk,
          status: 'transcribing',
          transcriptStatus: 'queued',
          transcriptMergeStatus: 'pending',
          transcriptMergedAt: null,
          rejectionReason: '',
          lastError: { message: null, at: null },
          diagnostics: {
            containerDurationSec: null,
            decodedDurationSec: null,
            durationDeltaSec: null,
            blobSizeBytes: Number(req.body?.sizeBytes || objectHead.contentLength || 0),
            mimeType,
            uploadedAt: new Date(),
          },
        },
        $setOnInsert: { retries: 0 },
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );

    await rebuildMeetingStats(meeting);
    meeting.status = meeting.endTime ? 'processing' : 'recording';
    meeting.visible = Number(meeting.stats?.durationSec || chunkEndSec || 0) >= 20 || Number(meeting.stats?.chunksUploaded || 0) > 0;
    meeting.visibilityReason = meeting.visible ? 'valid_duration_or_chunk' : 'pending_min_duration';
    await meeting.save();

    eventBus.emit('chunk_uploaded', {
      ...buildChunkSsePayload(meeting, chunkDoc),
      fileSizeBytes: chunkDoc.sizeBytes,
      totalUploaded: meeting.stats.chunksUploaded,
      storageProvider: 'r2',
      transcriptionStatus: 'queued',
    });

    res.json({
      success: true,
      data: {
        meetingId: meeting.meetingId,
        chunkIndex,
        r2Key,
        storageProvider: 'r2',
        storedSize: chunkDoc.sizeBytes,
        durationSec,
        chunkStartSec,
        chunkEndSec,
        isFinalPartialChunk,
        chunksUploaded: meeting.stats.chunksUploaded,
        fullChunks: Math.floor(Number(meeting.stats.durationSec || 0) / 60),
        partialChunks: Number(meeting.stats.durationSec || 0) % 60 > 0 ? 1 : 0,
        totalChunks: Number(meeting.stats.durationSec || 0) >= 20 ? Math.ceil(Number(meeting.stats.durationSec || 0) / 60) : 0,
        transcriptionStatus: 'queued',
      },
    });

    setImmediate(async () => {
      try { await processChunkTranscription(meeting.meetingId, chunkDoc._id, chunkIndex); }
      catch (asyncErr) { console.error('Deferred R2 chunk transcription failed:', asyncErr.message); }
    });
  } catch (error) {
    next(error);
  }
});

router.post(
  '/:id/chunks',
  requireAuthUnlessEsp32,
  (req, res, next) => {
    console.log('[chunk-route:hit]', { method: req.method, path: req.originalUrl || req.url, contentType: req.headers['content-type'] || '', meetingParam: req.params.id, contentLength: req.headers['content-length'] || null });
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('multipart/form-data')) {
      req.setTimeout(120000);
      return upload.any()(req, res, (err) => {
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({
            success: false,
            error: {
              code: 'PAYLOAD_TOO_LARGE',
              message: `Uploaded audio is too large. Increase MAX_FILE_SIZE or reduce chunk size. Current limit: ${parseInt(process.env.MAX_FILE_SIZE, 10) || DEFAULT_MAX_FILE_SIZE} bytes`,
            },
          });
        }
        if (err) return next(err);
        console.log('[chunk-route:file]', { meetingParam: req.params.id, fileCount: Array.isArray(req.files) ? req.files.length : 0, fields: req.body ? Object.keys(req.body) : [], files: (req.files || []).map((file) => ({ fieldname: file.fieldname, originalname: file.originalname, size: file.size, mimetype: file.mimetype })) });
        return next();
      });
    }

    if (
      contentType.includes('audio/wav') ||
      contentType.includes('audio/x-wav') ||
      contentType.includes('audio/webm') ||
      contentType.includes('video/webm') ||
      contentType.includes('application/octet-stream')
    ) {
      req.setTimeout(120000);
      return handleRawBody(req, res, next);
    }

    return express.json({ limit: '10mb' })(req, res, next);
  },
  async (req, res, next) => {
    try {
      const hasMultipartFile = Array.isArray(req.files) && req.files.length > 0;
      const hasRawAudioBuffer = Buffer.isBuffer(req.body) && req.body.length > 0;
      const hasJsonBody =
        req.body && !Buffer.isBuffer(req.body) && Object.keys(req.body).length > 0;

      console.log('[chunk-route:body]', { meetingParam: req.params.id, hasMultipartFile, hasRawAudioBuffer, hasJsonBody, fields: req.body && !Buffer.isBuffer(req.body) ? Object.keys(req.body) : [] });

      if (!hasMultipartFile && !hasRawAudioBuffer && !hasJsonBody) {
        return res.status(400).json({
          success: false,
          ok: false,
          error: {
            code: 'FILE_REQUIRED',
            message: 'No audio file received',
            expectedField: 'audio',
            acceptedFields: ['audio', 'chunk', 'file'],
          },
        });
      }

      const meeting = await findMeetingByAnyId(req.params.id);
      if (!meeting) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Meeting not found' },
        });
      }

      // v17 FIX: Frontend sends 'selectedLanguage' in multipart form, not 'language'
      const requestLanguage =
        (typeof req.body === 'object' && !Buffer.isBuffer(req.body)
          ? (req.body?.selectedLanguage || req.body?.language)
          : undefined) ||
        req.query?.selectedLanguage ||
        req.query?.language ||
        req.headers['x-meeting-language'] ||
        req.headers['x-language'] ||
        undefined;

      const storageContext = await ensureMeetingStorageDirectory(meeting, requestLanguage);
      if (
        meeting.selectedLanguage !== storageContext.selectedLanguage ||
        meeting.normalizedLanguage !== storageContext.normalizedLanguage ||
        meeting.storageFolder !== storageContext.storageFolder ||
        meeting.storagePath !== storageContext.storagePath
      ) {
        meeting.selectedLanguage = storageContext.selectedLanguage;
        meeting.normalizedLanguage = storageContext.normalizedLanguage;
        meeting.storageFolder = storageContext.storageFolder;
        meeting.storagePath = storageContext.storagePath;
        await meeting.save();
      }

      console.log('[audio-storage:chunk]', {
        meetingId: meeting.meetingId,
        requestLanguage: requestLanguage || null,
        selectedLanguage: meeting.selectedLanguage || meeting.language,
        normalizedLanguage: meeting.normalizedLanguage || meeting.language,
        storageFolder: meeting.storageFolder,
        storagePath: meeting.storagePath,
      });

      let chunkIndex = 0;
      let savedPath = '';
      let storedFilename = '';
      let storedSize = 0;
      let mimeType = 'audio/wav';
      let originalName = '';
      let clientDurationSec = 0;
      let clientMeasuredDurationSec = 0;
      let clientUploadToken = '';
      let clientBlobSizeBytes = 0;
      let uploadedFile = null;

      const multipartBody =
        typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {};

      const clientChunkStartSec = toFiniteNumber(
        multipartBody.chunkStartSec ?? req.headers['x-chunk-start-sec'],
        null
      );
      const clientChunkEndSec = toFiniteNumber(
        multipartBody.chunkEndSec ?? req.headers['x-chunk-end-sec'],
        null
      );
      const clientCapturedAtRaw = multipartBody.clientCapturedAt || req.headers['x-client-captured-at'] || null;
      const clientCapturedAt = clientCapturedAtRaw ? new Date(clientCapturedAtRaw) : null;
      const explicitFinalPartial = String(
        multipartBody.isFinalPartialChunk ?? req.headers['x-is-final-partial-chunk'] ?? 'false'
      ).toLowerCase() === 'true';
      clientMeasuredDurationSec = toFiniteNumber(multipartBody.measuredDurationSec ?? req.headers['x-measured-duration-sec'], 0) || 0;
      clientBlobSizeBytes = Number(multipartBody.blobSizeBytes ?? req.headers['x-blob-size-bytes'] ?? 0) || 0;

      uploadedFile = pickUploadedFile(req);

      if (uploadedFile) {
        console.log('[chunk-route:selected-file]', {
          meetingParam: req.params.id,
          fieldname: uploadedFile.fieldname,
          originalname: uploadedFile.originalname,
          filename: uploadedFile.filename,
          path: uploadedFile.path,
          size: uploadedFile.size,
          mimetype: uploadedFile.mimetype,
        });

        await cleanupUnselectedUploadedFiles(req, uploadedFile);

        const multipartChunkIndex = multipartBody.chunkIndex ?? req.headers['x-chunk-index'] ?? parseChunkIndexFromName(uploadedFile.originalname);
        chunkIndex = Number(multipartChunkIndex || 0);
        clientDurationSec = Number(multipartBody.durationSec || multipartBody.clientMeasuredDurationSec || 0);
        clientUploadToken = String(
          multipartBody.uploadToken || multipartBody.sessionChunkId || ''
        ).trim();

        storedFilename = uploadedFile.filename;
        savedPath = uploadedFile.path;
        storedSize = uploadedFile.size || 0;
        mimeType = uploadedFile.mimetype || mimeType;
        originalName = uploadedFile.originalname || storedFilename;
      } else if (Buffer.isBuffer(req.body) && req.body.length > 0) {
        chunkIndex = Number(req.headers['x-chunk-index'] || 0);
        clientDurationSec = Number(req.headers['x-duration-sec'] || 0);
        clientUploadToken = String(
          req.headers['x-upload-token'] || req.headers['x-session-chunk-id'] || ''
        ).trim();

        const meetingDir = await ensureMeetingDir(meeting, requestLanguage);
        storedFilename = `${getChunkBaseName(chunkIndex)}_${Date.now()}${getRawBodyExtension(
          req.headers['content-type'] || 'application/octet-stream',
          req.body
        )}`;
        savedPath = path.join(meetingDir, storedFilename);
        await fs.promises.writeFile(savedPath, req.body);
        storedSize = req.body.length;
        mimeType = req.headers['content-type'] || mimeType;
        originalName = storedFilename;
      } else {
        console.warn('[chunk:error]', {
          meetingParam: req.params.id,
          message: 'No audio file received',
          receivedFields: getReceivedFileFields(req),
        });
        return res.status(400).json({
          success: false,
          ok: false,
          error: 'No audio file received',
          expectedFields: ['audio', 'chunk', 'file', 'upload'],
          receivedFields: getReceivedFileFields(req),
          meetingId: multipartBody.meetingId || meeting.meetingId || req.params.id,
        });
      }

      if (!Number.isFinite(chunkIndex) || chunkIndex < 0) {
        await fs.promises.unlink(savedPath).catch(() => {});
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_CHUNK_INDEX',
            message: 'chunkIndex must be a non-negative number',
          },
        });
      }

      if (storedSize < 512) {
        await fs.promises.unlink(savedPath).catch(() => {});
        return res.status(400).json({
          success: false,
          error: {
            code: 'EMPTY_CHUNK',
            message: 'Audio chunk is empty or too small',
          },
        });
      }

      console.log('[audio-storage:saved]', {
        meetingId: meeting.meetingId,
        storageFolder: meeting.storageFolder,
        savedPath,
        storedSize,
        fieldName: uploadedFile?.fieldname || 'raw',
        mimeType,
      });

      const probe = await probeAudioDurationAndContainer(savedPath);

      // FIX (Bug 5): Correct priority order for durationSec.
      // Old order put client-measured (always 0 for WebM) first and ffprobe last.
      // New order: ffprobe ground truth first, client wall-clock as last resort.
      const durationSec = (() => {
        const candidates = [
          probe.containerDurationSec,    // 1. ffprobe — most accurate (now fixed via stream-level fallback)
          probe.decodedDurationSec,      // 2. WAV header decode (accurate for WAV files)
          clientMeasuredDurationSec,     // 3. AudioContext measurement (now non-zero after Bug 2 fix)
          clientDurationSec,             // 4. Client wall-clock — last resort fallback
          /\.wav$/i.test(savedPath) ? getWavDurationSec(savedPath) : 0,
        ];
        for (const candidate of candidates) {
          const value = Number(candidate || 0);
          if (Number.isFinite(value) && value >= 0.2) return Number(value.toFixed(3));
        }
        return 0;
      })();

      // FIX (Improvement): Track which source won for observability in logs
      const durationSource =
        probe.containerDurationSec >= 0.2 ? `ffprobe_${probe.durationSource || 'container'}`
        : probe.decodedDurationSec >= 0.2 ? 'decoded_wav'
        : clientMeasuredDurationSec >= 0.2 ? 'client_measured'
        : 'client_wall_clock';

      const durationMs = Math.max(0, Math.round(Number(durationSec || 0) * 1000));
      const { startSec: chunkStartSec, endSec: chunkEndSec } = inferChunkTimeline({
        chunkIndex,
        durationMs,
        explicitStartSec: clientChunkStartSec,
        explicitEndSec: clientChunkEndSec,
      });
      const isFinalPartialChunk = Boolean(explicitFinalPartial || (durationMs > 0 && durationMs < 58000)); // 1-57.999s final/partial chunk for 60s chunks
      const fileHash = await hashFile(savedPath).catch(() => null);

      console.log('[CHUNK_RECEIVED]', {
        meetingId: meeting.meetingId,
        chunkIndex,
        source: meeting.source,
        storedSize,
        durationSec,
        durationSource,                            // FIX: which source won
        clientMeasuredDurationSec,
        containerDurationSec: probe.containerDurationSec,
        decodedDurationSec: probe.decodedDurationSec,
        ffprobeDurationSource: probe.durationSource || null,
      });

      const existingChunk = await AudioChunk.findOne({
        meetingId: meeting.meetingId,
        chunkIndex,
      });

      if (
        existingChunk &&
        ((clientUploadToken &&
          existingChunk.uploadToken &&
          existingChunk.uploadToken === clientUploadToken) ||
          (fileHash && existingChunk.checksum && existingChunk.checksum === fileHash))
      ) {
        console.log('[chunk:duplicate]', {
          meetingId: meeting.meetingId,
          chunkIndex,
          reason: 'matching-upload-token-or-checksum',
        });
        await fs.promises.unlink(savedPath).catch(() => {});
        await rebuildMeetingStats(meeting);
        return res.json({
          success: true,
          data: {
            meetingId: meeting.meetingId,
            chunkIndex,
            file: existingChunk.fileName,
            size: existingChunk.sizeBytes,
            durationSec: Math.round(Number(existingChunk.durationMs || 0) / 1000),
            duplicate: true,
            chunkStartSec: Number(existingChunk.chunkStartSec || 0),
            chunkEndSec: Number(existingChunk.chunkEndSec || 0),
            isFinalPartialChunk: Boolean(existingChunk.isFinalPartialChunk),
            chunksUploaded: meeting.stats.chunksUploaded,
            chunksCompleted30s: meeting.stats.chunksCompleted30s,
            hasFinalPartialChunk: meeting.stats.hasFinalPartialChunk,
            chunksTotal: meeting.stats.chunksTotal,
            durationSecTotal: Number(meeting.stats.durationSec || 0),
          },
        });
      }

      if (
        existingChunk?.filePath &&
        existingChunk.filePath !== savedPath &&
        fs.existsSync(existingChunk.filePath)
      ) {
        console.log('[chunk:duplicate]', {
          meetingId: meeting.meetingId,
          chunkIndex,
          reason: 'existing-chunk-index-preserved',
        });
        await fs.promises.unlink(savedPath).catch(() => {});
        await rebuildMeetingStats(meeting);
        meeting.status = meeting.endTime ? 'processing' : 'recording';
        await meeting.save();
        return res.json({
          success: true,
          data: {
            meetingId: meeting.meetingId,
            chunkIndex,
            file: existingChunk.fileName,
            size: existingChunk.sizeBytes,
            durationSec: Math.round(Number(existingChunk.durationMs || 0) / 1000),
            duplicate: true,
            chunkStartSec: Number(existingChunk.chunkStartSec || 0),
            chunkEndSec: Number(existingChunk.chunkEndSec || 0),
            isFinalPartialChunk: Boolean(existingChunk.isFinalPartialChunk),
            chunksUploaded: meeting.stats.chunksUploaded,
            chunksCompleted30s: meeting.stats.chunksCompleted30s,
            hasFinalPartialChunk: meeting.stats.hasFinalPartialChunk,
            chunksTotal: meeting.stats.chunksTotal,
            durationSecTotal: Number(meeting.stats.durationSec || 0),
          },
        });
      }

      const chunkDoc = await AudioChunk.findOneAndUpdate(
        { meetingId: meeting.meetingId, chunkIndex },
        {
          $set: {
            chunkNumber: chunkIndex,
            source: meeting.source,
            storageProvider: 'local',
            mimeType,
            originalName: originalName || storedFilename,
            fileName: storedFilename,
            filePath: savedPath,
            sizeBytes: storedSize,
            diagnostics: {
              containerDurationSec: probe.containerDurationSec,
              decodedDurationSec: probe.decodedDurationSec,
              durationDeltaSec: probe.containerDurationSec && durationSec ? Number((probe.containerDurationSec - durationSec).toFixed(3)) : null,
              blobSizeBytes: clientBlobSizeBytes || storedSize,
              mimeType: mimeType || '',
              ffprobe: probe.ffprobe || '',
              ffmpeg: '',
              rms: null,
              detectedLanguage: '',
              segmentCount: 0,
              groupedTurnCount: 0,
              displayWarning: false,
              coverageRatio: null,
              measuredByClientSec: clientMeasuredDurationSec || null,
              uploadedAt: new Date(),
            },
            durationMs,
            durationSource: clientDurationSec > 0 ? 'client' : 'backend',
            checksum: fileHash,
            uploadToken: clientUploadToken || null,
            chunkTimestamp: new Date(),
            chunkStartSec,
            chunkEndSec,
            startedAtMs: Math.round(chunkStartSec * 1000),
            endedAtMs: Math.round(chunkEndSec * 1000),
            sequenceStartMs: Math.round(chunkStartSec * 1000),
            sequenceEndMs: Math.round(chunkEndSec * 1000),
            clientCapturedAt: clientCapturedAt && !Number.isNaN(clientCapturedAt.getTime()) ? clientCapturedAt : null,
            finalChunk: Boolean(explicitFinalPartial || meeting.endTime),
            partialChunk: durationMs > 0 && durationMs < 58000,
            isFinalPartialChunk,
            status: 'transcribing',
            transcriptMergeStatus: 'pending',
            transcriptMergedAt: null,
            lastError: { message: null, at: null },
          },
          $setOnInsert: {
            retries: 0,
          },
        },
        {
          upsert: true,
          new: true,
          runValidators: true,
          setDefaultsOnInsert: true,
        }
      );

      let r2Mirror = null;
      if (isR2MirrorEnabled()) {
        try {
          r2Mirror = await uploadLocalFileToR2({
            filePath: savedPath,
            userId: req.user?.id || req.user?._id || meeting.userId || 'local',
            meetingId: meeting.meetingId,
            chunkIndex,
            mimeType,
            checksum: fileHash,
          });

          chunkDoc.storageProvider = 'local';
          chunkDoc.r2Bucket = r2Mirror.bucket;
          chunkDoc.r2Key = r2Mirror.r2Key;
          chunkDoc.r2ETag = r2Mirror.eTag;
          chunkDoc.r2Url = r2Mirror.r2Url || '';
          chunkDoc.uploadCompletedAt = new Date();
          chunkDoc.diagnostics = {
            ...(chunkDoc.diagnostics || {}),
            r2MirrorUploaded: true,
            r2MirrorUploadedAt: new Date(),
          };
          await chunkDoc.save();

          console.log('[r2:mirror:uploaded]', {
            meetingId: meeting.meetingId,
            chunkIndex,
            localPath: savedPath,
            r2Key: r2Mirror.r2Key,
            sizeBytes: r2Mirror.sizeBytes,
          });
        } catch (mirrorError) {
          console.warn('[r2:mirror:failed]', {
            meetingId: meeting.meetingId,
            chunkIndex,
            localPath: savedPath,
            error: mirrorError.message,
          });
          chunkDoc.diagnostics = {
            ...(chunkDoc.diagnostics || {}),
            r2MirrorUploaded: false,
            r2MirrorError: mirrorError.message,
            r2MirrorFailedAt: new Date(),
          };
          await chunkDoc.save().catch(() => {});
          if (String(process.env.LOCAL_AUDIO_FALLBACK || 'true').toLowerCase() === 'false') {
            throw mirrorError;
          }
        }
      }

      await rebuildMeetingStats(meeting);
      meeting.status = meeting.endTime ? 'processing' : 'recording';
      await meeting.save();

      if (meeting.deviceId) {
        await Device.findOneAndUpdate(
          { deviceId: meeting.deviceId },
          {
            status: 'online',
            lastSeenAt: new Date(),
            currentMeetingId: meeting.meetingId,
          }
        );
      }

      eventBus.emit('chunk_uploaded', {
        ...buildChunkSsePayload(meeting, chunkDoc),
        fileSizeBytes: storedSize,
        totalUploaded: meeting.stats.chunksUploaded,
      });

      res.json({
        success: true,
        data: {
          meetingId: meeting.meetingId,
          chunkIndex,
          file: storedFilename,
          savedPath,
          storagePath: meeting.storagePath,
          storedSize,
          size: storedSize,
          storageProvider: 'local',
          r2Mirrored: Boolean(r2Mirror?.r2Key || chunkDoc.r2Key),
          r2Key: r2Mirror?.r2Key || chunkDoc.r2Key || '',
          durationSec,
          chunkStartSec,
          chunkEndSec,
          isFinalPartialChunk,
          chunksUploaded: meeting.stats.chunksUploaded,
          chunksCompleted30s: meeting.stats.chunksCompleted30s,
          hasFinalPartialChunk: meeting.stats.hasFinalPartialChunk,
          chunksTotal: meeting.stats.chunksTotal,
          durationSecTotal: Number(meeting.stats.durationSec || 0),
          transcriptionStatus: 'queued',
        },
      });

      setImmediate(async () => {
        try {
          await processChunkTranscription(meeting.meetingId, chunkDoc._id, chunkIndex);
        } catch (asyncErr) {
          console.error('Deferred chunk transcription failed:', asyncErr.message);
        }
      });

      return;
    } catch (error) {
      next(error);
    }
  }
);

router.get('/:id/transcript', auth, async (req, res, next) => {
  try {
    const meeting = await findMeetingByAnyId(req.params.id);
    if (!meeting) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Meeting not found' },
      });
    }

    const transcript = await Transcript.findOne({ meetingId: meeting.meetingId });
    res.json({
      success: true,
      data:
        transcript ||
        {
          meetingId: meeting.meetingId,
          fullText: '',
          segments: [],
          processingStatus: 'pending',
        },
    });
  } catch (error) {
    next(error);
  }
});

// ─── TRANSCRIPT EXPORT: TXT ─────────────────────────────────────────────────
router.get('/:id/transcript.txt', auth, async (req, res, next) => {
  try {
    const meeting = await findMeetingByAnyId(req.params.id);
    if (!meeting) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Meeting not found' },
      });
    }

    const transcript = await Transcript.findOne({ meetingId: meeting.meetingId });
    if (!transcript || !(transcript.fullText || transcript.cleanEnglish || transcript.rawFullText)) {
      return res.status(404).json({
        success: false,
        error: { code: 'NO_TRANSCRIPT', message: 'No transcript available for this meeting' },
      });
    }

    const formatMs = (ms) => {
      const totalSec = Math.max(0, Math.floor(Number(ms || 0) / 1000));
      const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
      const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
      const s = String(totalSec % 60).padStart(2, '0');
      return `${h}:${m}:${s}`;
    };

    const normalizeText = (value = '') =>
      String(value || '').replace(/\r/g, '').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();

    const toPercent = (confidence) => {
      if (typeof confidence !== 'number' || Number.isNaN(confidence)) return null;
      return Math.round(confidence * 100);
    };

    const getConfidenceLabel = (turn) => {
      const raw = String(turn?.confidenceLabel || '').trim().toLowerCase();
      if (raw) return raw;
      return 'unknown';
    };

    const toGroupedTurns = () => {
      if (Array.isArray(transcript.groupedSpeakerTurns) && transcript.groupedSpeakerTurns.length > 0) {
        return [...transcript.groupedSpeakerTurns]
          .map((turn, index) => {
            const startMs = Number.isFinite(Number(turn.startMs))
              ? Number(turn.startMs)
              : Math.round(Number(turn.start || 0) * 1000);

            const endMs = Number.isFinite(Number(turn.endMs))
              ? Number(turn.endMs)
              : Math.round(Number(turn.end || turn.start || 0) * 1000);

            return {
              id: turn.id ?? index,
              speaker: String(turn.speaker || `Speaker ${index + 1}`).trim() || `Speaker ${index + 1}`,
              startMs,
              endMs,
              text: normalizeText(turn.text),
              confidence: typeof turn.confidence === 'number' ? turn.confidence : null,
              confidenceLabel: getConfidenceLabel(turn),
              segmentCount: Number(
                turn.segmentCount ||
                (Array.isArray(turn.segments) ? turn.segments.length : 0) ||
                1
              ),
            };
          })
          .filter((turn) => turn.text)
          .sort((a, b) => a.startMs - b.startMs);
      }

      if (Array.isArray(transcript.segments) && transcript.segments.length > 0) {
        return [...transcript.segments]
          .map((seg, index) => {
            const startMs = Number.isFinite(Number(seg.startMs))
              ? Number(seg.startMs)
              : Math.round(Number(seg.start || 0) * 1000);

            const endMs = Number.isFinite(Number(seg.endMs))
              ? Number(seg.endMs)
              : Math.round(Number(seg.end || seg.start || 0) * 1000);

            return {
              id: seg.id ?? index,
              speaker: String(seg.speaker || 'Speaker 1').trim() || 'Speaker 1',
              startMs,
              endMs,
              text: normalizeText(seg.text),
              confidence: typeof seg.confidence === 'number' ? seg.confidence : null,
              confidenceLabel: getConfidenceLabel(seg),
              segmentCount: 1,
            };
          })
          .filter((turn) => turn.text)
          .sort((a, b) => a.startMs - b.startMs);
      }

      const fallbackText = normalizeText(
        transcript.cleanEnglish || transcript.fullText || transcript.rawFullText || ''
      );

      return fallbackText
        ? [
            {
              id: 0,
              speaker: 'Speaker 1',
              startMs: 0,
              endMs: 0,
              text: fallbackText,
              confidence: null,
              confidenceLabel: 'unknown',
              segmentCount: 1,
            },
          ]
        : [];
    };

    const durationSec = meeting?.stats?.durationSec ? Number(meeting.stats.durationSec) : 0;
    const createdAt = meeting?.createdAt ? new Date(meeting.createdAt) : new Date();
    const turns = toGroupedTurns();

    const lines = [];

    lines.push('VOICEMIND TRANSCRIPT');
    lines.push('============================================================');
    lines.push(`Meeting : ${meeting.title || `Meeting ${createdAt.toLocaleString()}`}`);
    lines.push(`Date    : ${createdAt.toLocaleString()}`);
    lines.push(`Source  : ${meeting.source || 'web'}`);
    lines.push(`Status  : ${meeting.status || transcript.processingStatus || 'completed'}`);
    lines.push(`Duration: ${formatMs(durationSec * 1000)}`);
    lines.push('============================================================');
    lines.push('');

    for (const turn of turns) {
      lines.push(`[${formatMs(turn.startMs)}] ${turn.speaker}:`);
      lines.push(turn.text);
      lines.push('');
    }

    if (turns.length > 0) {
      for (const turn of turns) {
        const confidenceLabel = turn.confidenceLabel || 'unknown';
        const confidencePercent = toPercent(turn.confidence);
        const mergedCount = Math.max(1, Number(turn.segmentCount || 1));

        let metaLine = `${turn.speaker}  ${formatMs(turn.startMs)} - ${formatMs(turn.endMs)}  ${confidenceLabel}`;
        if (confidencePercent !== null) {
          metaLine += ` ${confidencePercent}%`;
        }
        metaLine += ` ${mergedCount} merged segment${mergedCount > 1 ? 's' : ''} :`;

        lines.push('---------------------------------------------------------------------');
        lines.push(metaLine);
        lines.push('---------------------------------------------------------------------');
        lines.push(turn.text);
        lines.push('');
      }
    }

    const safeTitle = String(meeting.title || 'Untitled')
      .replace(/[\/:*?"<>|\\]/g, '-')
      .slice(0, 60);

    const filename = `transcript-${safeTitle}.txt`;

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    return res.send(lines.join('\n'));
  } catch (error) {
    next(error);
  }
});

// ─── TRANSCRIPT EXPORT: PDF (served as styled HTML, browser prints to PDF) ───
router.get('/:id/transcript.pdf', auth, async (req, res, next) => {
  try {
    const meeting = await findMeetingByAnyId(req.params.id);
    if (!meeting) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Meeting not found' } });
    }
    const transcript = await Transcript.findOne({ meetingId: meeting.meetingId });
    if (!transcript || !transcript.fullText) {
      return res.status(404).json({ success: false, error: { code: 'NO_TRANSCRIPT', message: 'No transcript available for this meeting' } });
    }

    const formatMs = (ms) => {
      const totalSec = Math.max(0, Math.floor(Number(ms || 0) / 1000));
      const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
      const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
      const s = String(totalSec % 60).padStart(2, '0');
      return h + ':' + m + ':' + s;
    };

    const esc = (str) => String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    const speakerPalette = ['#2563EB', '#7C3AED', '#059669', '#D97706', '#DB2777', '#0891B2'];
    const getSpeakerColor = (speaker) => {
      const m = String(speaker || '').match(/\d+/);
      if (m) return speakerPalette[(Number(m[0]) - 1) % speakerPalette.length];
      return speakerPalette[0];
    };

    const durationSec = meeting.stats && meeting.stats.durationSec ? meeting.stats.durationSec : 0;
    const metaDate = new Date(meeting.createdAt).toLocaleString();
    const duration = formatMs(durationSec * 1000);
    const segments = Array.isArray(transcript.segments) ? transcript.segments : [];
    const segCount = segments.length;
    const wordCount = transcript.fullText ? transcript.fullText.trim().split(/\s+/).length : 0;

    let segmentsHtml = '';
    if (segCount > 0) {
      const sorted = [...segments].sort((a, b) => Number(a.startMs || 0) - Number(b.startMs || 0));
      for (const seg of sorted) {
        const segText = String(seg.text || '').trim();
        if (!segText) continue;
        const color = getSpeakerColor(seg.speaker);
        const speakerLabel = esc(String(seg.speaker || 'Speaker').toUpperCase());
        segmentsHtml += '<div class="segment">'
          + '<div class="seg-header">'
          + '<span class="speaker" style="background:' + color + '20;color:' + color + ';border-color:' + color + '40">' + speakerLabel + '</span>'
          + '</div>'
          + '<div class="seg-text">' + esc(segText) + '</div>'
          + '</div>\n';
      }
    } else {
      const paragraphs = String(transcript.cleanEnglish || transcript.fullText || '').split(/\n+/).map((l) => l.trim()).filter(Boolean);
      for (const para of paragraphs) {
        segmentsHtml += '<div class="segment">'
          + '<div class="seg-header">'
          + '<span class="speaker" style="background:#2563EB20;color:#2563EB;border-color:#2563EB40">SPEAKER 1</span>'
          + '</div>'
          + '<div class="seg-text">' + esc(para) + '</div>'
          + '</div>\n';
      }
    }

    const generatedAt = new Date().toLocaleString();
    const meetingTitle = esc(meeting.title || 'Untitled Meeting');
    const processingStatus = esc(transcript.processingStatus || 'completed');
    const sourceLabel = esc(meeting.source || 'web');

    const html = '<!DOCTYPE html>\n'
      + '<html lang="en">\n'
      + '<head>\n'
      + '<meta charset="UTF-8" />\n'
      + '<title>Transcript - ' + meetingTitle + '</title>\n'
      + '<style>\n'
      + '* { margin: 0; padding: 0; box-sizing: border-box; }\n'
      + 'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; background: #fff; color: #111; padding: 40px 48px; font-size: 13px; line-height: 1.7; }\n'
      + '.header { border-bottom: 3px solid #2563EB; padding-bottom: 20px; margin-bottom: 28px; }\n'
      + '.brand { font-size: 10px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; color: #6B7280; margin-bottom: 8px; }\n'
      + 'h1 { font-size: 22px; font-weight: 800; color: #111; margin-bottom: 14px; line-height: 1.3; }\n'
      + '.meta { display: flex; flex-wrap: wrap; gap: 16px; }\n'
      + '.meta-item { font-size: 12px; color: #4B5563; background: #F3F4F6; padding: 4px 10px; border-radius: 6px; }\n'
      + '.stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 24px 0 28px; }\n'
      + '.stat { border: 1px solid #E5E7EB; border-radius: 8px; padding: 12px 14px; }\n'
      + '.stat-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: #9CA3AF; margin-bottom: 4px; }\n'
      + '.stat-value { font-size: 18px; font-weight: 700; color: #111; }\n'
      + '.section-title { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.12em; color: #6B7280; margin-bottom: 16px; padding-bottom: 8px; border-bottom: 1px solid #F3F4F6; }\n'
      + '.segment { margin-bottom: 14px; padding: 14px 16px; border: 1px solid #E5E7EB; border-radius: 8px; page-break-inside: avoid; }\n'
      + '.seg-header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }\n'
      + '.speaker { font-size: 10px; font-weight: 700; letter-spacing: 0.12em; padding: 3px 10px; border-radius: 999px; border: 1px solid; }\n'
      + '.seg-text { font-size: 13px; color: #1F2937; line-height: 1.8; }\n'
      + '.footer { margin-top: 40px; padding-top: 14px; border-top: 1px solid #E5E7EB; font-size: 11px; color: #9CA3AF; text-align: center; }\n'
      + '@media print { body { padding: 20px 24px; } .segment { page-break-inside: avoid; } }\n'
      + '</style>\n'
      + '</head>\n'
      + '<body>\n'
      + '<div class="header">\n'
      + '  <div class="brand">VoiceMind Transcript</div>\n'
      + '  <h1>' + meetingTitle + '</h1>\n'
      + '  <div class="meta">\n'
      + '    <span class="meta-item">&#128197; ' + metaDate + '</span>\n'
      + '    <span class="meta-item">&#9201; ' + duration + '</span>\n'
      + '    <span class="meta-item">&#128266; ' + sourceLabel + '</span>\n'
      + '    <span class="meta-item">&#10003; ' + processingStatus + '</span>\n'
      + '  </div>\n'
      + '</div>\n'
      + '<div class="stats">\n'
      + '  <div class="stat"><div class="stat-label">Duration</div><div class="stat-value">' + duration + '</div></div>\n'
      + '  <div class="stat"><div class="stat-label">Segments</div><div class="stat-value">' + segCount + '</div></div>\n'
      + '  <div class="stat"><div class="stat-label">Words</div><div class="stat-value">' + wordCount + '</div></div>\n'
      + '  <div class="stat"><div class="stat-label">Status</div><div class="stat-value" style="font-size:13px">' + processingStatus + '</div></div>\n'
      + '</div>\n'
      + '<div class="section-title">Transcript</div>\n'
      + segmentsHtml
      + '<div class="footer">Generated by VoiceMind &bull; ' + generatedAt + '</div>\n'
      + '</body>\n'
      + '</html>';

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="transcript-' + meeting.meetingId + '.html"');
    return res.send(html);
  } catch (error) {
    next(error);
  }
});

module.exports = router;