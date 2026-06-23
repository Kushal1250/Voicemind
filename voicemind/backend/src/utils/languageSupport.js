const path = require('path');
const fs = require('fs');

const ALLOWED_MEETING_LANGUAGES = ['auto', 'en', 'gu', 'hi'];
const NON_AUTO_MEETING_LANGUAGES = ['en', 'gu', 'hi'];
const AUDIO_STORAGE_FOLDERS = ['auto', 'english', 'gujarati', 'hindi'];

const LANGUAGE_ALIASES = {
  auto: 'auto',
  automatic: 'auto',
  autodetect: 'auto',
  'auto-detect': 'auto',
  detect: 'auto',
  none: 'auto',
  null: 'auto',
  undefined: 'auto',
  '': 'auto',
  en: 'en',
  english: 'en',
  hi: 'hi',
  hindi: 'hi',
  gu: 'gu',
  guj: 'gu',
  gujarati: 'gu',
};

const STORAGE_FOLDER_MAP = {
  auto: 'auto',
  en: 'english',
  hi: 'hindi',
  gu: 'gujarati',
};

function normalizeMeetingLanguage(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  const compact = raw.replace(/[^a-z]/g, '');
  return LANGUAGE_ALIASES[raw] || LANGUAGE_ALIASES[compact] || 'auto';
}

function isSupportedMeetingLanguage(value) {
  return ALLOWED_MEETING_LANGUAGES.includes(normalizeMeetingLanguage(value));
}

function resolveAudioLanguageFolder(language) {
  const normalized = normalizeMeetingLanguage(language);
  return STORAGE_FOLDER_MAP[normalized] || 'auto';
}

function sanitizeMeetingId(meetingId) {
  const safeMeetingId = String(meetingId ?? '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeMeetingId) {
    throw new Error('Invalid meetingId for audio storage');
  }
  return safeMeetingId;
}

function getProjectRootDirectory() {
  return path.resolve(process.env.AUDIO_STORAGE_ROOT || process.cwd());
}

function getLegacyUploadsRootDirectory() {
  return path.resolve(process.env.UPLOAD_DIR || './uploads');
}

function ensureDirectoryExists(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function assertSafeChildPath(baseDir, candidatePath) {
  const normalizedBase = path.resolve(baseDir);
  const normalizedCandidate = path.resolve(candidatePath);
  const relative = path.relative(normalizedBase, normalizedCandidate);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Unsafe storage path detected');
  }

  return normalizedCandidate;
}

function getMeetingAudioDirectory(language, meetingId) {
  const projectRoot = getProjectRootDirectory();
  const storageFolder = resolveAudioLanguageFolder(language);
  const safeMeetingId = sanitizeMeetingId(meetingId);
  const candidatePath = path.join(projectRoot, storageFolder, safeMeetingId);
  const safePath = assertSafeChildPath(projectRoot, candidatePath);
  ensureDirectoryExists(safePath);
  return safePath;
}

function getLegacyMeetingDirectory(meetingId) {
  const uploadsRoot = getLegacyUploadsRootDirectory();
  const safeMeetingId = sanitizeMeetingId(meetingId);
  const candidatePath = path.join(uploadsRoot, safeMeetingId);
  return assertSafeChildPath(uploadsRoot, candidatePath);
}

function buildMeetingStorageMetadata(language, meetingId) {
  const normalizedLanguage = normalizeMeetingLanguage(language);
  const storageFolder = resolveAudioLanguageFolder(normalizedLanguage);
  return {
    selectedLanguage: normalizedLanguage,
    normalizedLanguage,
    storageFolder,
    storagePath: getMeetingAudioDirectory(normalizedLanguage, meetingId),
  };
}

module.exports = {
  ALLOWED_MEETING_LANGUAGES,
  NON_AUTO_MEETING_LANGUAGES,
  AUDIO_STORAGE_FOLDERS,
  LANGUAGE_ALIASES,
  normalizeMeetingLanguage,
  isSupportedMeetingLanguage,
  resolveAudioLanguageFolder,
  sanitizeMeetingId,
  getProjectRootDirectory,
  getLegacyUploadsRootDirectory,
  ensureDirectoryExists,
  assertSafeChildPath,
  getMeetingAudioDirectory,
  getLegacyMeetingDirectory,
  buildMeetingStorageMetadata,
};
