// backend/src/services/transcribe.service.js
// ============================================================
// VoiceMind Backend Transcription Service — v8.0
// ============================================================
//
// KEY CHANGES IN v8.0:
//
//  UPGRADE — Dynamic Speaker Diarization via SpeakerManager
//    Python service now uses ECAPA-TDNN / Resemblyzer embeddings
//    for voice-based speaker identification.
//    Cosine similarity matching (threshold=0.75).
//    Embedding profile updating (EMA: 0.8 * old + 0.2 * new).
//
//  SPEAKER LABELS ALWAYS "Speaker N"
//    All role-based labels (Doctor, Patient, Teacher, Student,
//    Interviewer, Candidate, Bhai, Friend) are permanently removed.
//    Segment and turn speaker normalization produces only:
//    "Speaker 1", "Speaker 2", ... "Speaker N"
//    No other naming format is allowed.
//
//  All v7.0 fixes preserved.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

// ─── OPTIONAL DEPS (graceful fallback if utils are missing) ───────────────────
let _cleanTranscriptText = (t) => String(t || '').replace(/\s+/g, ' ').trim();
let _chooseBestTranscriptText = (...args) => args.find((v) => typeof v === 'string' && v.trim()) || '';
let _isUsableTranscript = (t) => typeof t === 'string' && t.trim().length >= 3;
let _hasKnownBadPlaceholder = () => false;
let _isSuspiciousShrinkage = () => false;
let _normalizeTranscriptText = (t) => String(t || '').replace(/\s+/g, ' ').trim();
let _isHallucinatedRepetitionBase = () => false;
let _selectValidatedFinalText = (obj) => obj.sourceFullText || obj.text || '';

try {
  const utils = require('../utils/transcriptText');
  _cleanTranscriptText = utils.cleanTranscriptText || _cleanTranscriptText;
  _chooseBestTranscriptText = utils.chooseBestTranscriptText || _chooseBestTranscriptText;
  _isUsableTranscript = utils.isUsableTranscript || _isUsableTranscript;
  _hasKnownBadPlaceholder = utils.hasKnownBadPlaceholder || _hasKnownBadPlaceholder;
  _isSuspiciousShrinkage = utils.isSuspiciousShrinkage || _isSuspiciousShrinkage;
  _normalizeTranscriptText = utils.normalizeTranscriptText || _normalizeTranscriptText;
  _isHallucinatedRepetitionBase = utils.isHallucinatedRepetition || _isHallucinatedRepetitionBase;
  _selectValidatedFinalText = utils.selectValidatedFinalText || _selectValidatedFinalText;
} catch (_e) {
  console.warn('[transcribe:service] transcriptText utils not found — using fallbacks');
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const DEFAULT_TRANSCRIBE_API_URL = process.env.TRANSCRIBE_API_URL || 'http://127.0.0.1:8001';
const TRANSCRIBE_UPLOAD_PATH = '/transcribe-upload';
// FIX: Reduced timeout from 1200s to 180s.
// With beam_size=1, cpu_threads=6, a 4s chunk should decode in <30s.
// A 60s chunk with optimised settings should decode in <120s.
// 1200s was masking hung transcriptions and causing memory buildup.
const DEFAULT_TIMEOUT_MS = Number(process.env.TRANSCRIBE_TIMEOUT_MS || 180000);
const DEFAULT_ENABLE_DIARIZATION = String(process.env.TRANSCRIBE_ENABLE_DIARIZATION || 'false').trim().toLowerCase() === 'true';
const TRANSCRIBE_CONCURRENCY = Math.max(1, Number(process.env.TRANSCRIBE_CONCURRENCY || 1));

let activeTranscriptions = 0;
const pendingTranscriptions = [];

// ─── BANNED PHRASE DETECTOR (v7.0) ───────────────────────────────────────────
// These are Whisper hallucinations that must NEVER appear in the Live Transcript.
// Applied at the backend level as a secondary defense after Python rejection.
const _BACKEND_BANNED_PHRASES = [
  /thanks?\s+for\s+watching/i,
  /thank\s+you\s+(very\s+much\s+)?for\s+watching/i,
  /please\s+(like\s+and\s+)?(subscribe|share)/i,
  /don'?t\s+forget\s+to\s+subscribe/i,
  /like\s+and\s+subscribe/i,
  /hit\s+the\s+bell\s+(icon|button)/i,
  /i\s+want\s+to\s+be\s+a\s+i\s+want\s+to\s+be\s+a/i,
  /i\s+don['’]?t\s+know\s+if\s+you\s+can\s+hear\s+me/i,
  /i['’]?m\s+going\s+to\s+show\s+you\s+how\s+to\s+do\s+it/i,
  /so,?\s+i['’]?m\s+going\s+to\s+show\s+you/i,
  /thank\s+you\.?$/i,
  /(no,?\s+){4,}/i,
  /(yes,?\s+){4,}/i,
  /(okay,?\s+){4,}/i,
];

function _hasBannedPhrase(text = '') {
  if (!text) return false;
  const normalized = String(text).replace(/\s+/g, ' ').toLowerCase();
  return _BACKEND_BANNED_PHRASES.some((p) => p.test(normalized));
}

// ─── GEMINI CLOSING PHRASE STRIPPER (v8.0) ───────────────────────────────────
// Gemini (unlike Whisper) appends polite closing phrases like "Thank you." to its
// output fields. The banned-phrase gate has /thank\s+you\.?$/ which fires on any
// field ending with that phrase — rejecting perfectly valid Hinglish transcripts.
// Strip these Gemini-style closings BEFORE running the banned-phrase check.
const _GEMINI_CLOSING_PHRASES = [
  /\s*thank\s+you[!.]*\s*$/i,
  /\s*thanks[!.]*\s*$/i,
  /\s*you['’]?re\s+welcome[!.]*\s*$/i,
  /\s*thank\s+you\s+for\s+(listening|your\s+time|watching)[!.]*\s*$/i,
];

function _stripGeminiClosings(text = '') {
  let t = String(text || '').trimEnd();
  for (const pat of _GEMINI_CLOSING_PHRASES) {
    t = t.replace(pat, '').trimEnd();
  }
  return t;
}

// Unsupported languages — if Python detected these, reject the payload
const _UNSUPPORTED_LANGUAGES = new Set(['jw', 'es', 'ur', 'bn', 'id', 'ja', 'ko', 'zh', 'pt', 'ar', 'tr', 'ms', 'tl']);

function _isUnsupportedLanguage(lang = '') {
  return _UNSUPPORTED_LANGUAGES.has(String(lang || '').trim().toLowerCase());
}

function _tokens(text = '') {
  return String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

function _uniqueWordRatio(text = '') {
  const tokens = _tokens(text);
  if (!tokens.length) return 0;
  return new Set(tokens).size / tokens.length;
}

function _repeatedNgramRatio(text = '', n = 3) {
  const tokens = _tokens(text);
  if (tokens.length < n * 2) return 0;
  const counts = new Map();
  let total = 0;
  for (let i = 0; i <= tokens.length - n; i += 1) {
    const gram = tokens.slice(i, i + n).join(' ');
    counts.set(gram, (counts.get(gram) || 0) + 1);
    total += 1;
  }
  return total ? Math.max(...counts.values()) / total : 0;
}

function _hasNativeIndianScript(text = '') {
  // Devanagari (Hindi) or Gujarati characters present
  return /[\u0900-\u097F\u0A80-\u0AFF]/.test(String(text || ''));
}

function _looksLikeLowConfidenceHallucination(payload = {}) {
  // Use one best text field only — concatenating all 4 identical fields inflates
  // n-gram repetition scores 4x, causing false rejections of valid transcripts.
  // Strip speaker labels ("Speaker 1 :\n") that we now prepend in conversation_text
  // before scoring, so label tokens don't skew uniqueness/repetition ratios.
  const rawField = String(
    payload.normalized_text ||
    payload.text ||
    payload.raw_text ||
    payload.conversation_text ||
    ''
  ).replace(/^(Speaker\s+\d+)\s*:\s*\n?/gim, '').trim();
  const combined = rawField;
  // v14: If ANY field has native Devanagari or Gujarati script, never reject
  // (Real Hindi/Gujarati speech will always have these characters)
  const allText = String((payload.conversation_text || '') + ' ' +
    (payload.normalized_text || '') + ' ' + (payload.raw_text || '') + ' ' + (payload.text || ''));
  if (_hasNativeIndianScript(allText)) return false;
  const confidence = String(payload.confidence || '').toLowerCase();
  const coverage = Number(payload.coverage_ratio ?? payload.coverageRatio ?? payload?.quality?.coverageRatio ?? 0);
  const displayWarning = payload.displayWarning === true || payload?.quality?.displayWarning === true;
  const tokens = _tokens(combined);
  const unique = _uniqueWordRatio(combined);
  const rep3 = _repeatedNgramRatio(combined, 3);
  const rep5 = _repeatedNgramRatio(combined, 5);

  // Hard reject: banned phrase or pure repetition (classic Whisper hallucination)
  if (_hasBannedPhrase(combined)) return true;

  // FIX v8.0: Real conversational speech can repeat the same question many times
  // (e.g. "What's your name?" 8× in a 60s chunk). Previously rep3>=0.55 rejected this.
  // Only reject if BOTH repetition is extreme AND vocabulary is very low — true
  // hallucinations (silence → "Thanks for watching" loop) are caught by banned-phrase
  // check above. A single repeated 3-gram that dominates ≥90% of the text AND the
  // vocabulary is collapsed (<15% unique) is the true hallucination pattern.
  // v14: extreme repetition check — only for pure hallucination (≥95% one phrase)
  if (rep3 >= 0.95 && unique < 0.08) return true;
  if (rep5 >= 0.90 && unique < 0.08) return true;

  // Reject only if vocabulary is EXTREMELY low AND text is long enough to be sure
  // Raised from 0.22 → 0.12 to avoid rejecting real speech with repeated phrases
  // v14: raised to 0.08 — Hindi speech naturally repeats particles (है, ने, का)
  if (tokens.length >= 30 && unique < 0.08) return true;

  // Python explicitly rejected — trust it
  if (confidence === 'rejected') return true;

  // FIX v18: Never reject Gujarati/Hindi even if confidence=low
  // Indian language ASR always produces "low" confidence scores due to mixed vocabulary
  const language = String(payload.language || '').toLowerCase();
  if (['gu', 'hi', 'gujarati', 'hindi'].includes(language) && !_hasBannedPhrase(combined)) {
    return false;  // never hallucination-reject Indian language content that passed Python
  }

  
  // confidence=low is extremely common for Gujarati/Hindi sports commentary and
  // mixed-language speech. NEVER auto-reject on low confidence alone.
  // Only reject very short text with absolutely no signal.
  if (tokens.length < 3 && displayWarning && coverage < 0.20) return true;

  return false;
}

/**
 * isTranscriptDisplayable — v7.0 strict gate
 * Returns false for any payload that should NOT be shown in the transcript.
 */
function isTranscriptDisplayable(payload = {}) {
  // Python explicitly rejected
  if (payload.success === false) return false;
  if (payload.transcript_status === 'rejected_hallucination') return false;
  if (payload.hallucination && payload.hallucination.is_hallucination === true) return false;
  // FIX v18: auto_fallback_language_mismatch with success=true means Python accepted it
  // (happens when GU_ACCEPT_HIGHCONF_ENGLISH kicks in for code-switched cricket)
  // Don't re-reject it here.
  if (String(payload.confidence || '').toLowerCase() === 'rejected') return false;

  // Unsupported language detected
  const detectedLang = String(payload.language || payload.languageDetected || '').trim().toLowerCase();
  if (_isUnsupportedLanguage(detectedLang)) {
    console.warn('[transcribe:rejected] Unsupported language detected:', detectedLang);
    return false;
  }

  // Banned phrase in any text field
  // FIX v8.0: Strip Gemini closing phrases ("Thank you.", "Thanks.") before checking.
  // Gemini frequently appends these to its output; the raw /thank\s+you\.?$/ regex
  // was rejecting entire valid Hinglish transcripts because one field ended with it.
  const textFields = [
    payload.text, payload.raw_text, payload.normalized_text, payload.conversation_text
  ];
  for (const field of textFields) {
    const strippedField = _stripGeminiClosings(String(field || ''));
    if (strippedField && _hasBannedPhrase(strippedField)) {
      console.warn('[transcribe:rejected] Banned phrase detected in payload (after stripping Gemini closings)', {
        fieldPreview: String(field || '').slice(0, 80),
        strippedPreview: strippedField.slice(0, 80),
      });
      return false;
    }
  }

  if (_looksLikeLowConfidenceHallucination(payload)) {
    console.warn('[transcribe:rejected] Low-confidence hallucination/repetition detected', {
      confidence: payload.confidence,
      needsReview: payload.needs_review || payload.needsReview,
      coverageRatio: payload.coverage_ratio ?? payload.coverageRatio ?? payload?.quality?.coverageRatio,
      preview: String(payload.conversation_text || payload.text || '').slice(0, 100),
    });
    return false;
  }

  return true;
}

// ─── DIARIZATION WARNING PATTERN ──────────────────────────────────────────────
// Matches the note appended by older Python conversation_formatter.py v5.0:
//   "[Note: Diarization is disabled. Speaker labels are assigned by heuristic only...]"
const _DIARIZATION_WARNING_PATTERN = /\[Note:\s*Diarization\s+is\s+disabled[^\]]*\]/gi;

// Also catch any stray warning variants
const _SPEAKER_HEURISTIC_PATTERN = /\[Speaker\s+labels?\s+are\s+assigned\s+by\s+heuristic[^\]]*\]/gi;

function _stripDiarizationWarning(text) {
  if (!text) return text;
  let cleaned = String(text)
    .replace(_DIARIZATION_WARNING_PATTERN, '')
    .replace(_SPEAKER_HEURISTIC_PATTERN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned;
}

// ─── URL RESOLVER ─────────────────────────────────────────────────────────────
// TRANSCRIBE_API_URL may be either:
//   http://127.0.0.1:8001
// or, for old .env files:
//   http://127.0.0.1:8001/transcribe-upload
// This resolver normalizes both forms to exactly one /transcribe-upload suffix.
let _urlLogged = false;
function resolveTranscribeUploadUrl() {
  let base = String(DEFAULT_TRANSCRIBE_API_URL || 'http://127.0.0.1:8001').trim();
  base = base.replace(/\/+$/, '');
  base = base.replace(/\/transcribe-upload$/i, '');
  const url = `${base}${TRANSCRIBE_UPLOAD_PATH}`;
  if (!_urlLogged) {
    console.log('[transcribe:service] Python transcription URL:', url);
    console.log('[transcribe:service] Base env TRANSCRIBE_API_URL:', DEFAULT_TRANSCRIBE_API_URL);
    console.log('[transcribe:service] Timeout:', DEFAULT_TIMEOUT_MS, 'ms');
    console.log('[transcribe:service] Concurrency:', TRANSCRIBE_CONCURRENCY);
    _urlLogged = true;
  }
  return url;
}

// ─── CONCURRENCY QUEUE ────────────────────────────────────────────────────────
function runQueuedTranscription(task) {
  return new Promise((resolve, reject) => {
    pendingTranscriptions.push({ task, resolve, reject });
    drainTranscriptionQueue();
  });
}

function drainTranscriptionQueue() {
  while (activeTranscriptions < TRANSCRIBE_CONCURRENCY && pendingTranscriptions.length > 0) {
    const item = pendingTranscriptions.shift();
    activeTranscriptions += 1;

    // FIX (Bug 3): Log AFTER increment — reflects true active count.
    // Old code logged concurrencyActive before runQueuedTranscription() incremented it → always 0.
    console.log('[CONCURRENCY] slot-acquired', {
      concurrencyActive: activeTranscriptions,
      concurrencyQueue: pendingTranscriptions.length,
      concurrencyLimit: TRANSCRIBE_CONCURRENCY,
    });

    Promise.resolve()
      .then(item.task)
      .then(item.resolve, item.reject)
      .finally(() => {
        activeTranscriptions -= 1;
        console.log('[CONCURRENCY] slot-released', {
          concurrencyActive: activeTranscriptions,
          concurrencyQueue: pendingTranscriptions.length,
        });
        drainTranscriptionQueue();
      });
  }
}

// ─── LANGUAGE NORMALIZER ──────────────────────────────────────────────────────
function normalizeLanguage(language) {
  const value = String(language || '').trim().toLowerCase();
  if (!value || ['auto', 'automatic', 'detect', 'autodetect', 'auto-detect', 'none', 'null'].includes(value)) {
    return 'auto';
  }
  if (['en', 'english'].includes(value)) return 'en';
  if (['hi', 'hindi'].includes(value)) return 'hi';
  if (['gu', 'guj', 'gujarati'].includes(value)) return 'gu';
  return 'auto';
}

// ─── TEXT UTILITIES ───────────────────────────────────────────────────────────
function normalizeText(value, options = {}) {
  return _cleanTranscriptText(String(value || ''), options);
}

function normalizeArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function pickDisplayText(...values) {
  for (const v of values) {
    const cleaned = _normalizeTranscriptText(String(v || ''));
    if (cleaned && cleaned.length >= 2) return cleaned;
  }
  return '';
}

// ─── ENHANCED HALLUCINATION DETECTOR ──────────────────────────────────────────
function isHallucinatedRepetition(text = '', options = {}) {
  if (_isHallucinatedRepetitionBase(text, options)) return true;

  const normalized = _normalizeTranscriptText(text);
  if (!normalized) return false;

  const tokens = normalized.match(/[\p{L}\p{N}%:/._'-]+/gu) || [];
  if (tokens.length >= 8) {
    const numericTokens = tokens.filter((t) => /^\d+[-–—,.:]*\d*$/.test(t));
    if (numericTokens.length >= 8) {
      const counts = new Map();
      for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
      const maxCount = Math.max(...counts.values());
      const dominantRatio = maxCount / Math.max(tokens.length, 1);
      if (dominantRatio >= 0.45) return true;
    }
    const alphaWords = tokens.filter((t) => /[a-zA-Z\u0900-\u097F\u0A80-\u0AFF]/.test(t));
    if (numericTokens.length >= 10 && alphaWords.length < 3) return true;
  }

  return false;
}

// ─── NORMALIZE SEGMENTS (accepts Python snake_case) ───────────────────────────
function normalizeSegments(segments) {
  if (!Array.isArray(segments)) return [];

  return segments
    .map((segment, index) => {
      const sourceText = normalizeText(
        segment?.sourceText ||
        segment?.source_text ||
        segment?.normalizedSourceText ||
        segment?.rawSourceText ||
        segment?.text || '',
        { preserveRepeats: true, preserveNumbers: true },
      );

      const englishText = normalizeText(
        segment?.englishText || segment?.translatedText || '',
        { preserveRepeats: true, preserveNumbers: true },
      );

      const finalValidatedText = (sourceText && _isUsableTranscript(sourceText, { minWords: 1 }))
        ? sourceText
        : pickDisplayText(
          segment?.finalValidatedText,
          segment?.displayText,
          segment?.text,
          englishText,
        );

      const speakerId = String(segment?.speakerId || segment?.speaker_id || 'SPEAKER_1').trim();

      // Always use Speaker N numeric format — no role labels
      const _rawSpeaker = String(segment?.speaker || '').trim();
      const _speakerMatch = _rawSpeaker.match(/(\d+)$/);
      const speakerLabel = _speakerMatch
        ? `Speaker ${_speakerMatch[1]}`
        : (_rawSpeaker ? 'Speaker 1' : 'Speaker 1');

      return {
        id: Number.isFinite(Number(segment?.id)) ? Number(segment.id) : index,
        speaker: speakerLabel,
        speakerId,
        speaker_id: speakerId,
        start: Number(segment?.start || 0),
        end: Number(segment?.end || 0),
        startMs: Number.isFinite(Number(segment?.startMs)) ? Number(segment.startMs) : Math.round(Number(segment?.start || 0) * 1000),
        endMs: Number.isFinite(Number(segment?.endMs)) ? Number(segment.endMs) : Math.round(Number(segment?.end || 0) * 1000),
        text: finalValidatedText,
        displayText: finalValidatedText,
        finalValidatedText,
        rawSourceText: normalizeText(segment?.rawSourceText || sourceText, { preserveRepeats: true, preserveNumbers: true }),
        sourceText,
        normalizedSourceText: normalizeText(segment?.normalizedSourceText || sourceText, { preserveRepeats: true, preserveNumbers: true }),
        englishText,
        translatedText: englishText,
        words: Array.isArray(segment?.words) ? segment.words : [],
        confidence: typeof segment?.confidence === 'number' ? segment.confidence : null,
        confidenceLabel: segment?.confidenceLabel || 'unknown',
        uncertainTerms: normalizeArray(segment?.uncertainTerms),
        needsReview: Boolean(segment?.needsReview),
        chunkIndex: Number.isFinite(Number(segment?.chunkIndex)) ? Number(segment.chunkIndex) : 0,
        sourceLanguage: normalizeLanguage(segment?.sourceLanguage || segment?.language || ''),
        language: normalizeLanguage(segment?.language || segment?.sourceLanguage || ''),
        detectedLanguage: normalizeLanguage(segment?.detectedLanguage || segment?.sourceLanguage || segment?.language || ''),
        translationWarnings: normalizeArray(segment?.translationWarnings),
      };
    })
    .filter((segment) => {
      const candidate = segment.finalValidatedText || segment.englishText || segment.sourceText;
      return !isHallucinatedRepetition(candidate) && (
        _isUsableTranscript(segment.finalValidatedText, { minWords: 1 }) ||
        _isUsableTranscript(segment.sourceText, { minWords: 1 }) ||
        segment.words.length
      );
    });
}

// ─── NORMALIZE GROUPED TURNS (accepts Python snake_case) ─────────────────────
function normalizeGroupedTurns(turns) {
  if (!Array.isArray(turns)) return [];

  return turns
    .map((turn, index) => {
      const sourceText = normalizeText(
        turn?.sourceText ||
        turn?.source_text ||
        turn?.text ||
        '',
        { preserveRepeats: true, preserveNumbers: true },
      );

      const englishText = normalizeText(
        turn?.englishText || turn?.translatedText || '',
        { preserveRepeats: true, preserveNumbers: true },
      );

      const finalValidatedText = (sourceText && _isUsableTranscript(sourceText, { minWords: 1 }))
        ? sourceText
        : pickDisplayText(turn?.finalValidatedText, turn?.displayText, turn?.text, englishText);

      const speakerId = String(turn?.speakerId || turn?.speaker_id || 'SPEAKER_1').trim();
      const segmentCount = Number(turn?.segmentCount || turn?.segment_count || 1);

      // Always use Speaker N numeric format — no role labels
      const _rawTurnSpeaker = String(turn?.speaker || '').trim();
      const _turnSpeakerMatch = _rawTurnSpeaker.match(/(\d+)$/);
      const speakerLabel = _turnSpeakerMatch
        ? `Speaker ${_turnSpeakerMatch[1]}`
        : 'Speaker 1';

      return {
        ...turn,
        id: Number.isFinite(Number(turn?.id)) ? Number(turn.id) : index,
        speaker: speakerLabel,
        speakerId,
        speaker_id: speakerId,
        text: finalValidatedText,
        displayText: finalValidatedText,
        finalValidatedText,
        sourceText,
        englishText,
        start: Number(turn?.start || 0),
        end: Number(turn?.end || 0),
        startMs: Number.isFinite(Number(turn?.startMs)) ? Number(turn.startMs) : Math.round(Number(turn?.start || 0) * 1000),
        endMs: Number.isFinite(Number(turn?.endMs)) ? Number(turn.endMs) : Math.round(Number(turn?.end || 0) * 1000),
        chunkIndex: Number.isFinite(Number(turn?.chunkIndex)) ? Number(turn.chunkIndex) : 0,
        segmentCount,
        segment_count: segmentCount,
        segments: normalizeSegments(turn?.segments || []),
        uncertainTerms: normalizeArray(turn?.uncertainTerms),
        confidence: typeof turn?.confidence === 'number' ? turn.confidence : null,
        confidenceLabel: turn?.confidenceLabel || 'unknown',
        translationWarnings: normalizeArray(turn?.translationWarnings),
      };
    })
    .filter((turn) => {
      const candidate = turn.finalValidatedText || turn.text || turn.sourceText || turn.englishText;
      return _isUsableTranscript(candidate, { minWords: 1 });
    })
    .filter((turn) => !isHallucinatedRepetition(turn.finalValidatedText || turn.text || turn.sourceText));
}

// ─── COVERAGE RATIO ───────────────────────────────────────────────────────────
function calculateCoverageRatio(bestText, groupedSpeakerTurns, segments) {
  const bestChars = normalizeText(bestText, { preserveRepeats: true, preserveNumbers: true }).length;
  if (!bestChars) return 0;
  const groupedChars = normalizeText((groupedSpeakerTurns || []).map((item) => item?.text || '').join(' '), { preserveRepeats: true, preserveNumbers: true }).length;
  const segmentChars = normalizeText((segments || []).map((item) => item?.text || '').join(' '), { preserveRepeats: true, preserveNumbers: true }).length;
  return Number((Math.max(groupedChars, segmentChars, 0) / Math.max(bestChars, 1)).toFixed(3));
}

// ─── buildSafeResponse ────────────────────────────────────────────────────────
function buildSafeResponse(payload = {}, fallbackLanguage = 'auto') {

  // v7.0: Hard rejection gate — if Python says it's bad, don't build any text from it.
  // This prevents hallucinations like "Thanks for watching!" from reaching the UI.
  if (!isTranscriptDisplayable(payload)) {
    console.warn('[transcribe:buildSafeResponse] Payload rejected by isTranscriptDisplayable gate', {
      success: payload.success,
      transcript_status: payload.transcript_status,
      language: payload.language,
      textPreview: String(payload.text || payload.conversation_text || '').slice(0, 60),
    });
    return {
      success: false,
      language: normalizeLanguage(payload.language || fallbackLanguage),
      languageDetected: normalizeLanguage(payload.language || fallbackLanguage),
      text: '', displayText: '', fullText: '', finalValidatedText: '',
      validatedEnglishText: '', cleanEnglish: '', translatedEnglish: '',
      validatedSourceText: '', rawFullText: '', rawTranscriptNormalized: '',
      sourceFullText: '', sourceTranscriptNormalized: '', rawTranscript: '', cleanedTranscript: '',
      segments: [], groupedSpeakerTurns: [], diarization: null, diagnostics: null, recovery: null,
      coverageRatio: 0, displayWarning: true, fallbackReason: 'rejected_hallucination',
      quality: { coverageRatio: 0, displayWarning: true, fallbackReason: 'rejected_hallucination' },
      usedModel: null, usedFallback: true, cleanupUsed: true,
      warnings: ['Transcript rejected: hallucination or unsupported language detected'],
      translationWarnings: [], uncertainTerms: [], confidenceNotes: [], lowConfidenceParts: [],
      finalBestTranscript: '', analysisWindowSeconds: 0, postProcessed: false, postProcessMode: 'OFF', mode: '',
      raw_text: '', normalized_text: '', conversation_text: '', turns: [],
      needs_review: true, speaker_count: 1,
      transcript_status: payload.transcript_status || 'rejected_hallucination',
    };
  }

  // FIX 1: Strip diarization warning from ALL text fields before processing.
  // This removes the legacy "[Note: Diarization is disabled...]" note that
  // Python v5.0 appended to conversation_text.
  const stripWarn = (v) => (v ? _stripDiarizationWarning(String(v)) : v);

  // FIX v8.0: Also strip Gemini closing phrases from all text fields before building
  // the safe response, so downstream functions never see trailing "Thank you." etc.
  const rawConversationText = _stripGeminiClosings(stripWarn(payload.conversation_text));
  const rawNormalizedText   = _stripGeminiClosings(stripWarn(payload.normalized_text));
  const rawText             = _stripGeminiClosings(stripWarn(payload.text));
  const rawRawText          = _stripGeminiClosings(stripWarn(payload.raw_text));

  // SOURCE FULL TEXT
  const sourceFullText = pickDisplayText(
    payload.sourceFullText,
    payload.sourceTranscriptNormalized,
    payload.rawTranscriptNormalized,
    payload.normalizedSourceFullText,
    payload.rawFullText,
    payload.rawTranscript,
    rawRawText,
    rawNormalizedText,
    rawText,
  );

  // RAW FULL TEXT
  const rawFullText = pickDisplayText(
    payload.rawFullText,
    payload.rawTranscriptNormalized,
    payload.rawTranscript,
    rawRawText,
    rawNormalizedText,
    sourceFullText,
    rawText,
  );

  // ENGLISH / TRANSLATED TEXT
  let translatedEnglish = pickDisplayText(
    payload.validatedEnglishText,
    payload.translatedEnglish,
    payload.englishText,
    payload.cleanEnglish,
    payload.cleanedTranscript,
  );

  const warnings = normalizeArray(payload.warnings);
  const translationWarnings = normalizeArray(payload.translationWarnings);

  if (!translatedEnglish || _hasKnownBadPlaceholder(translatedEnglish) || isHallucinatedRepetition(translatedEnglish)) {
    if (translatedEnglish) warnings.push('Rejected broken or placeholder-like English transcript candidate.');
    translatedEnglish = '';
  }

  if (translatedEnglish && sourceFullText && _isSuspiciousShrinkage(sourceFullText, translatedEnglish)) {
    translationWarnings.push('English translation looked suspiciously shorter than source.');
    translatedEnglish = '';
  }

  // SEGMENTS & TURNS — Python returns .turns (not .groupedSpeakerTurns)
  const groupedSpeakerTurns = normalizeGroupedTurns(
    payload.groupedSpeakerTurns || payload.turns || [],
  );
  const segments = normalizeSegments(payload.segments || []);

  // FIX 3: conversation_text wins for display (preferred source)
  // (Speaker 1: ..., Speaker 2: ...) — this is the primary output.
  const postProcessed = Boolean(payload.postProcessed) ||
    String(payload.postProcessMode || '').trim().toUpperCase() === 'MASTER_PROMPT';

  // Build bestText — conversation_text has highest priority
  let bestText = '';

  // Try conversation_text first (has Speaker N labels)
  if (rawConversationText && _isUsableTranscript(rawConversationText, { minWords: 1 })) {
    bestText = rawConversationText;
  }

  // Fall back to normalized/source text
  if (!bestText) {
    bestText = _selectValidatedFinalText({
      finalValidatedText: payload.finalValidatedText,
      finalBestTranscript: payload.finalBestTranscript,
      displayText: payload.displayText,
      fullText: payload.fullText,
      conversation_text: rawConversationText,
      normalized_text: rawNormalizedText,
      text: rawText,
      validatedSourceText: sourceFullText,
      sourceFullText,
      rawFullText,
      rawTranscriptNormalized: sourceFullText,
      translatedEnglish,
      cleanEnglish: translatedEnglish,
      validatedEnglishText: translatedEnglish,
    }, '');
  }

  const coverageRatio = calculateCoverageRatio(bestText, groupedSpeakerTurns, segments);
  const displayWarning = !_isUsableTranscript(bestText, { minWords: 1 }) || coverageRatio < 0.7;
  const fallbackReason = translatedEnglish ? 'none'
    : (sourceFullText ? 'source_preserving_fallback' : 'empty_transcript');

  // Logging
  console.log('[transcribe:buildSafeResponse:lengths]', {
    'payload.text': String(payload.text || '').length,
    'payload.raw_text': String(payload.raw_text || '').length,
    'payload.normalized_text': String(payload.normalized_text || '').length,
    'payload.conversation_text': String(payload.conversation_text || '').length,
    'safeResponse.bestText': String(bestText || '').length,
    'safeResponse.sourceFullText': String(sourceFullText || '').length,
    'safeResponse.segments': segments.length,
    'safeResponse.turns': groupedSpeakerTurns.length,
    displayWarning,
    coverageRatio,
  });

  if (!bestText && (payload.text || payload.normalized_text || payload.raw_text)) {
    console.warn(
      '[transcribe:buildSafeResponse:WARNING] bestText is empty but Python returned text! ' +
      'Python fields: text=' + String(payload.text || '').slice(0, 60) + ' ...'
    );
  }

  return {
    success: payload.success !== false,
    language: normalizeLanguage(payload.language || payload.languageDetected || fallbackLanguage),
    languageDetected: normalizeLanguage(payload.languageDetected || payload.language || fallbackLanguage),

    // PRIMARY TEXT (conversation_text wins)
    text: bestText,
    displayText: bestText,
    fullText: bestText,
    finalValidatedText: bestText,

    // ENGLISH (secondary)
    validatedEnglishText: translatedEnglish,
    cleanEnglish: translatedEnglish || '',
    translatedEnglish: translatedEnglish || '',

    // SOURCE / RAW
    validatedSourceText: sourceFullText || rawFullText || bestText,
    rawFullText: rawFullText || sourceFullText || bestText,
    rawTranscriptNormalized: sourceFullText || rawFullText || bestText,
    sourceFullText: sourceFullText || rawFullText || bestText,
    sourceTranscriptNormalized: sourceFullText || rawFullText || bestText,
    rawTranscript: rawFullText || sourceFullText || bestText,
    cleanedTranscript: translatedEnglish || bestText || sourceFullText,

    // STRUCTURED DATA
    segments,
    groupedSpeakerTurns,
    diarization: payload.diarization || null,
    diagnostics: payload.diagnostics || null,
    recovery: payload.recovery || null,

    // QUALITY
    coverageRatio,
    displayWarning,
    fallbackReason,
    quality: {
      ...(payload.quality || {}),
      coverageRatio,
      suspiciousTranslationShrinkage: Boolean(
        sourceFullText && translatedEnglish && _isSuspiciousShrinkage(sourceFullText, translatedEnglish)
      ),
      displayWarning,
      fallbackReason,
    },

    // METADATA
    usedModel: payload.usedModel || null,
    usedFallback: Boolean(payload.usedFallback || fallbackReason !== 'none'),
    cleanupUsed: payload.cleanupUsed !== false,
    warnings: [...new Set(warnings.filter(Boolean))],
    translationWarnings: [...new Set(translationWarnings.filter(Boolean))],
    uncertainTerms: normalizeArray(payload.uncertainTerms),
    confidenceNotes: normalizeArray(payload.confidenceNotes),
    lowConfidenceParts: Array.isArray(payload.lowConfidenceParts) ? payload.lowConfidenceParts : [],
    finalBestTranscript: bestText,
    analysisWindowSeconds: Number(payload.analysisWindowSeconds || 0),
    postProcessed,
    postProcessMode: payload.postProcessMode || (postProcessed ? 'MASTER_PROMPT' : 'OFF'),
    mode: payload.mode || '',

    // Python pass-through fields
    raw_text: rawRawText || '',
    normalized_text: rawNormalizedText || '',
    conversation_text: rawConversationText || '',
    turns: payload.turns || [],
    needs_review: Boolean(payload.needs_review || payload.needsReview),
    speaker_count: Number(payload.speaker_count || payload.speakerCount || 1),
  };
}

// ─── HTTP ERROR FORMATTER ─────────────────────────────────────────────────────
function toReadableError(error, { url, filePath, timeoutMs } = {}) {
  const serviceMessage =
    error?.response?.data?.detail ||
    error?.response?.data?.error?.message ||
    error?.response?.data?.message ||
    error?.message ||
    'Transcription request failed';

  const status = error?.response?.status;
  const responseBody = error?.response?.data ? JSON.stringify(error.response.data).slice(0, 500) : null;

  console.error('[transcribe:http:error]', {
    url: url || error?.config?.url || 'unknown',
    filePath: filePath || 'unknown',
    errorCode: error?.code,
    status: status || 'no_response',
    responseBody: responseBody || '(none)',
    timeout: timeoutMs || error?.config?.timeout || DEFAULT_TIMEOUT_MS,
    message: error?.message,
  });

  if (error?.code === 'ECONNRESET') {
    return (
      `ECONNRESET from Python at ${url || 'unknown URL'}. ` +
      `Check: (1) /transcribe-upload route exists in main.py; ` +
      `(2) Python is running; (3) GET http://127.0.0.1:8001/health`
    );
  }
  if (error?.code === 'ECONNREFUSED') {
    return `ECONNREFUSED — Python not running at ${url || DEFAULT_TRANSCRIBE_API_URL}. Start: cd python && python main.py`;
  }
  if (error?.code === 'ECONNABORTED' || /timeout/i.test(String(error?.message || ''))) {
    return (
      `Transcription timeout after ${timeoutMs || DEFAULT_TIMEOUT_MS}ms. ` +
      `Fix: set WHISPER_BEAM_SIZE=1 and WHISPER_BEST_OF=1 in python_services/transcription_service/.env, ` +
      `then restart Python. Also set TRANSCRIBE_TIMEOUT_MS=1200000 in backend/.env.`
    );
  }
  if (status === 404) {
    return `Transcription service 404 at ${url || 'unknown URL'}. Add @app.post("/transcribe-upload") to main.py.`;
  }
  return status ? `Transcription service error (${status}): ${serviceMessage}` : serviceMessage;
}

// ─── MAIN ENTRY POINT ─────────────────────────────────────────────────────────
async function transcribeAudioFile({
  filePath,
  language = 'auto',
  meetingContext = '',
  diarization = DEFAULT_ENABLE_DIARIZATION,
  analysisWindowSec = null,
  focusFirstWindowOnly = false,
  chunkDiagnosticsJson = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!filePath) throw new Error('filePath is required for transcribeAudioFile');

  const absolutePath = path.resolve(filePath);
  if (!fs.existsSync(absolutePath)) throw new Error(`Audio file not found: ${absolutePath}`);

  const targetUrl = resolveTranscribeUploadUrl();
  const lang = normalizeLanguage(language);

  const form = new FormData();
  form.append('file', fs.createReadStream(absolutePath));
  form.append('language', lang);
  if (meetingContext) form.append('meetingContext', String(meetingContext));
  if (diarization) form.append('diarization', 'true');
  if (analysisWindowSec != null) form.append('analysisWindowSec', String(analysisWindowSec));
  if (focusFirstWindowOnly != null) form.append('focusFirstWindowOnly', String(Boolean(focusFirstWindowOnly)));
  if (chunkDiagnosticsJson) form.append('chunkDiagnosticsJson', String(chunkDiagnosticsJson));

  const fileStats = fs.statSync(absolutePath);

  // FIX (Bug 3): Log moved inside runQueuedTranscription so concurrencyActive reflects
  // the real count AFTER drainTranscriptionQueue increments it (not before, which was always 0).
  const response = await runQueuedTranscription(async () => {
    console.log('[CONCURRENCY] transcribe:http:request', {
      url: targetUrl,
      filePath: absolutePath,
      fileSizeBytes: fileStats.size,
      language: lang,
      timeoutMs,
      concurrencyActive: activeTranscriptions,
      concurrencyQueue: pendingTranscriptions.length,
    });
    try {
      const res = await axios.post(targetUrl, form, {
        headers: form.getHeaders(),
        timeout: timeoutMs,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        validateStatus: (s) => s >= 200 && s < 300,
      });

      console.log('[transcribe:http:response]', {
        url: targetUrl,
        status: res.status,
        success: res.data?.success,
        textLength: String(res.data?.text || '').length,
        raw_textLength: String(res.data?.raw_text || '').length,
        normalized_textLength: String(res.data?.normalized_text || '').length,
        conversation_textLength: String(res.data?.conversation_text || '').length,
        language: res.data?.language || 'unknown',
        segmentCount: Array.isArray(res.data?.segments) ? res.data.segments.length : 0,
        turnsCount: Array.isArray(res.data?.turns) ? res.data.turns.length : 0,
        needs_review: res.data?.needs_review,
        confidence: res.data?.confidence,
      });

      return res;
    } catch (error) {
      throw new Error(toReadableError(error, { url: targetUrl, filePath: absolutePath, timeoutMs }));
    }
  });

  const safeResult = buildSafeResponse(response?.data || {}, lang);
  // FIX v8.0: Attach raw Python payload so callers can check whether Python actually
  // returned usable text before buildSafeResponse's hallucination gate zeroed it out.
  // This prevents false-positive "skipped" chunks when the gate is too aggressive.
  safeResult._rawPythonData = response?.data || {};
  return safeResult;
}

module.exports = {
  transcribeAudioFile,
  buildSafeResponse,
  normalizeLanguage,
  normalizeSegments,
  normalizeGroupedTurns,
  calculateCoverageRatio,
  isHallucinatedRepetition,
  isTranscriptDisplayable,
};