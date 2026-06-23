// frontend/src/utils/transcriptTurns.js
/**
 * VoiceMind Transcript Turns Utility — v6.0
 *
 * CHANGES IN v6.0
 * ---------------
 *
 * UPGRADE — Dynamic Speaker Diarization via SpeakerManager
 *   Python service now uses ECAPA-TDNN / Resemblyzer voice embeddings
 *   for dynamic speaker identification. Cosine similarity matching.
 *
 * SPEAKER LABELS — ALWAYS "Speaker N" FORMAT
 *   Speaker labels are always "Speaker 1", "Speaker 2", ... "Speaker N".
 *   No role names of any kind (Doctor, Patient, Teacher, Student,
 *   Interviewer, Candidate, bhai, friend) are ever used.
 *   This utility normalizes any stale legacy labels from old DB records.
 *
 * FIX — DIARIZATION WARNING STRIPPED (v4.0 preserved)
 * FIX — REJECTED CHUNK TEXT NEVER SHOWN (v4.0 preserved)
 */

// ─── DIARIZATION WARNING PATTERN ─────────────────────────────────────────────
const _DIARIZATION_WARNING_PATTERN = /\[Note:\s*Diarization\s+is\s+disabled[^\]]*\]/gi;
const _SPEAKER_HEURISTIC_PATTERN   = /\[Speaker\s+labels?\s+are\s+assigned\s+by\s+heuristic[^\]]*\]/gi;

const _stripDiarizationNote = (text) => {
  if (!text) return text;
  return String(text)
    .replace(_DIARIZATION_WARNING_PATTERN, '')
    .replace(_SPEAKER_HEURISTIC_PATTERN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

// ─── SPEAKER NORMALIZER ─────────────────────────────────────────────────────
// Always normalize to "Speaker N" format.
// Legacy role labels from old DB records (Doctor, Patient, Teacher, etc.)
// are stripped and converted to Speaker 1 as a safety net.
// The Python SpeakerManager guarantees only Speaker N labels in new data.
const _normalizeSpeakerLabel = (speaker) => {
  if (!speaker) return 'Speaker 1';
  const s = String(speaker).trim();
  // Already in "Speaker N" form (case-insensitive)
  const m = s.match(/(?:speaker)[_\s]?(\d+)/i);
  if (m) return `Speaker ${m[1]}`;
  // SPEAKER_N form (from Python diarization)
  const m2 = s.match(/SPEAKER_?(\d+)/);
  if (m2) return `Speaker ${m2[1]}`;
  // Any other label with a number
  const m3 = s.match(/(\d+)/);
  if (m3) return `Speaker ${m3[1]}`;
  // Any named role label or unknown → default to Speaker 1
  return 'Speaker 1';
};

const _isKnownRole = (speaker) => {
  if (!speaker) return false;
  const s = String(speaker).trim().toLowerCase();
  return /^speaker[_\s]?\d+$/.test(s);
};

// ─── TEXT UTILITIES ───────────────────────────────────────────────────────────
export const formatTranscriptClock = (valueMs, valueSeconds = 0) => {
  const ms = Number.isFinite(Number(valueMs))
    ? Number(valueMs)
    : Math.round(Number(valueSeconds || 0) * 1000);

  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours   = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');

  return `${hours}:${minutes}:${seconds}`;
};

const normalizeText = (value = '') => {
  const stripped = _stripDiarizationNote(String(value || ''));
  return stripped.replace(/\s+/g, ' ').trim();
};

// ─── HALLUCINATION / BAD PLACEHOLDER DETECTION ────────────────────────────────
const BAD_PLACEHOLDER_PATTERNS = [
  /gujarati\s+script\s+when\s+gujarati\s+speech\s+is\s+present/iu,
  /prefer\s+gujarati\s+script\s+when\s+gujarati\s+speech\s+is\s+present/iu,
  /transcribe\s+in\s+gujarati\s+script/iu,
  /render\s+hindi\s+words\s+in\s+gujarati\s+script/iu,
  /^\[?(?:અસ્પષ્ટ|unclear|inaudible)\]?$/iu,
  /do\s+not\s+summarize\s*,?\s*shorten\s*,?\s*or\s+replace\s+valid\s+speech\s+with\s+placeholder\s+text/iu,
  /you\s+are\s+a\s+transcript-preserving\s+translation\s+engine/iu,
  /\bhere\s*['\u2019]?s\s+a\s+possible\s+interpretation\b/iu,
  /\bthis\s+appears\s+to\s+be\b/iu,
  /\bthe speaker says\b/iu,
  /multi[\s\-]+speaker\s+meeting/iu,
  /preserve\s+speaker\s+changes\s+where\s+possible/iu,
  /avoid\s+collapsing\s+different\s+voices/iu,
  /avoid\s+collapsing\s+(the\s+)?speakers/iu,
  /gujarati[\s\-]+first\s+multilingual/iu,
  /hindi[\s\-]+first\s+multilingual/iu,
  /english[\s\-]+priority\s+multilingual/iu,
  /automatic\s+multilingual\s+meeting\s+decoding/iu,
  /prefer\s+exact\s+meeting\s+terms/iu,
  /production\.grade\s+(multilingual|transcription)/iu,
  /speech\s+pipeline/iu,
  /voicemind.*meeting.*preserve/iu,

  // v4.0: Diarization warning note
  /\[Note:\s*Diarization\s+is\s+disabled/iu,
  /Speaker\s+labels?\s+are\s+assigned\s+by\s+heuristic\s+only/iu,

  // v4.0: Hallucinated Whisper output patterns
  /\bau\s+matra\b/iu,
  /\bndi\s+ndi\b/iu,
  /[ૌ]\s+[ૌ]/u,
  /।\s+।/u,
  /namaste\s+doctor\s+saheb.*ketlak\s+divas/isu,
  /sathal\s+par\s+khanjvaal.*allergy.*cream/isu,
];

const hasKnownBadPlaceholder = (text = '') => {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return BAD_PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(normalized));
};

const looksLikeInstructionText = (text = '') => {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  const hits = [
    /^(translate|transcribe|convert|return|detect)\b/iu,
    /\bdo not\b/iu,
    /\breturn only\b/iu,
    /\brules\s*:/iu,
    /\bsummary\s*:/iu,
  ].filter((pattern) => pattern.test(normalized)).length;
  return hits >= 1 || hasKnownBadPlaceholder(normalized);
};

const hasRepeatedCharacterStretch = (text = '') =>
  /([A-Za-z઀-૿ऀ-ॿ])\1{7,}/u.test(normalizeText(text));

const isHallucinatedRepetition = (text = '') => {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  if (hasRepeatedCharacterStretch(normalized)) return true;
  const tokens = normalized.toLowerCase().match(/[\p{L}\p{N}%:._'-]+/gu) || [];
  if (tokens.length < 8) return false;
  const uniqueRatio = new Set(tokens).size / Math.max(tokens.length, 1);
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
  const maxCount = Math.max(...counts.values());
  return uniqueRatio < 0.22 || maxCount >= Math.max(6, Math.floor(tokens.length / 2));
};

const isUsableTranscriptText = (text = '', minWords = 1) => {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  if (hasKnownBadPlaceholder(normalized) || looksLikeInstructionText(normalized) || isHallucinatedRepetition(normalized)) return false;
  const words = normalized.split(/\s+/).filter(Boolean);
  return words.length >= minWords || normalized.length >= 10;
};

export const chooseBestTranscriptText = (...values) => {
  const candidates = values
    .flat()
    .map((value) => normalizeText(value))
    .filter(Boolean);

  if (!candidates.length) return '';

  const scored = candidates
    .map((text, index) => ({
      text,
      index,
      usable: isUsableTranscriptText(text, 1),
      bad: hasKnownBadPlaceholder(text) || looksLikeInstructionText(text) || isHallucinatedRepetition(text),
      words: text.split(/\s+/).filter(Boolean).length,
      chars: text.length,
    }))
    .sort((a, b) => {
      if (a.usable !== b.usable) return Number(b.usable) - Number(a.usable);
      if (a.bad !== b.bad) return Number(a.bad) - Number(b.bad);
      if (a.words !== b.words) return b.words - a.words;
      if (a.chars !== b.chars) return b.chars - a.chars;
      return a.index - b.index;
    });

  return scored[0]?.text || candidates[0] || '';
};

export const chooseSourceFirstTranscriptText = (sourceText = '', englishText = '', ...fallbackValues) => {
  const source  = normalizeText(sourceText);
  const english = normalizeText(englishText);
  const fallbacks = fallbackValues.flat().map((value) => normalizeText(value)).filter(Boolean);

  if (source && isUsableTranscriptText(source, 1)) {
    return source;
  }
  if (english && isUsableTranscriptText(english, 1)) {
    return english;
  }
  return chooseBestTranscriptText(...fallbacks);
};

const toNumberOrFallback = (value, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

// ─── selectDisplayTranscript (v4.0: conversation_text wins) ──────────────────
export const selectDisplayTranscript = (transcript = {}, fallbackText = '') => {
  const postProcessed = Boolean(transcript?.postProcessed)
    || String(transcript?.postProcessMode || '').trim().toUpperCase() === 'MASTER_PROMPT';

  // v6.0: conversation_text contains Speaker N labeled lines
  // "Speaker 1: text...\n\nSpeaker 2: ..." — prefer this for display.
  const conversationText = normalizeText(transcript?.conversation_text || '');
  if (conversationText && isUsableTranscriptText(conversationText, 2)) {
    return conversationText;
  }

  if (postProcessed) {
    return chooseBestTranscriptText(
      transcript?.finalValidatedText,
      transcript?.displayText,
      transcript?.fullText,
      transcript?.sourceFullText,
      transcript?.rawTranscriptNormalized,
      transcript?.rawFullText,
      transcript?.validatedEnglishText,
      transcript?.translatedEnglish,
      transcript?.cleanEnglish,
      fallbackText,
    );
  }

  return chooseSourceFirstTranscriptText(
    transcript?.sourceFullText || transcript?.rawTranscriptNormalized || transcript?.rawFullText,
    transcript?.finalValidatedText || transcript?.displayText || transcript?.fullText,
    transcript?.validatedEnglishText || transcript?.translatedEnglish || transcript?.cleanEnglish,
    fallbackText,
  );
};

// ─── normalizeTurn (v6.0: dynamic Speaker N labels only) ─────────────────────
const normalizeTurn = (item = {}, index = 0) => {
  const startSeconds = toNumberOrFallback(item?.start, 0);
  const fallbackEndSeconds = toNumberOrFallback(item?.start, 0);
  const endSeconds   = toNumberOrFallback(item?.end, fallbackEndSeconds);

  const startMs = Number.isFinite(Number(item?.startMs))
    ? Number(item.startMs)
    : Math.round(startSeconds * 1000);

  const endMsRaw = Number.isFinite(Number(item?.endMs))
    ? Number(item.endMs)
    : Math.round(endSeconds * 1000);

  const endMs = Math.max(startMs, endMsRaw);

  const sourceText  = normalizeText(item?.sourceText || item?.normalizedSourceText || item?.rawSourceText || '');
  const englishText = normalizeText(item?.englishText || item?.translatedText || '');
  const text = chooseSourceFirstTranscriptText(
    sourceText,
    englishText,
    item?.finalValidatedText,
    item?.displayText,
    item?.text,
  );

  if (!isUsableTranscriptText(text || sourceText || englishText, 1)) {
    return null;
  }

  // FIX v20: Always normalize to "speaker N" — no role labels
  const rawSpeaker = String(item?.speaker || '').trim();
  const speakerLabel = _normalizeSpeakerLabel(rawSpeaker);

  return {
    id:
      item?.id !== undefined && item?.id !== null
        ? item.id
        : `${toNumberOrFallback(item?.chunkIndex, 0)}-${index}`,
    speaker: speakerLabel,
    start: startSeconds,
    end: endSeconds,
    startMs,
    endMs,
    time:      formatTranscriptClock(startMs, startSeconds),
    startTime: formatTranscriptClock(startMs, startSeconds),
    endTime:   formatTranscriptClock(endMs, endSeconds),
    text,
    displayText:        text,
    finalValidatedText: text,
    rawText:            text,
    sourceText,
    englishText,
    confidence:      typeof item?.confidence === 'number' ? item.confidence : null,
    confidenceLabel: String(item?.confidenceLabel || 'unknown').trim() || 'unknown',
    needsReview:     Boolean(item?.needsReview),
    uncertainTerms:  Array.isArray(item?.uncertainTerms) ? item.uncertainTerms.filter(Boolean) : [],
    translationWarnings: Array.isArray(item?.translationWarnings) ? item.translationWarnings.filter(Boolean) : [],
    words:         Array.isArray(item?.words) ? item.words : [],
    chunkIndex:    toNumberOrFallback(item?.chunkIndex, index),
    segmentCount:  toNumberOrFallback(
      item?.segmentCount,
      Array.isArray(item?.segments) ? item.segments.length : 1,
    ),
    segments: Array.isArray(item?.segments) ? item.segments : [],
  };
};

const normalizeTurns = (items = []) =>
  (Array.isArray(items) ? items : [])
    .map((item, index) => normalizeTurn(item, index))
    .filter(Boolean)
    .sort(
      (a, b) =>
        Number(a.startMs || 0) - Number(b.startMs || 0) ||
        Number(a.chunkIndex || 0) - Number(b.chunkIndex || 0),
    );

// ─── buildTurnsFromLines (for plain-text conversation_text parsing) ───────────
/**
 * Parse speaker-labeled text into turn objects.
 * Handles BOTH formats:
 *   Newline-separated: "Speaker 1: text\nSpeaker 2: text"
 *   Inline (old DB):   "Speaker 1: text Speaker 2: text Speaker 1: more text"
 * Only "Speaker N:" labels are accepted — no role labels.
 */
const _SPEAKER_LINE_PATTERN = /^(Speaker\s*\d+):\s*(.+)$/iu;

// Matches "Speaker N:" or "SPEAKER N:" appearing inline (not just at line start)
const _INLINE_SPEAKER_SPLIT = /(?=(?:Speaker\s*\d+|SPEAKER\s*\d+)\s*:)/g;

/**
 * Pre-process text so inline "Speaker N:" labels each start on their own line.
 * If the text already has newlines between speakers, this is a no-op.
 */
const _normalizeInlineSpeakers = (text = '') => {
  const raw = String(text || '').trim();
  // Count inline speaker tokens (mid-sentence, not at start of line)
  const inlineMatches = raw.match(/(?<!\n)(?:Speaker\s*\d+|SPEAKER\s*\d+)\s*:/gi) || [];
  // Only reformat if there are multiple speaker tokens embedded inline
  if (inlineMatches.length < 2) return raw;
  // Split on every "Speaker N:" boundary so each gets its own line
  return raw
    .split(_INLINE_SPEAKER_SPLIT)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .join('\n');
};

const buildTurnsFromLines = (text = '') => {
  const preprocessed = _normalizeInlineSpeakers(text);

  return preprocessed
    .split(/\n+/)
    .map((line) => normalizeText(line))
    .filter((line) => isUsableTranscriptText(line, 1))
    .map((line, index) => {
      // Try to extract "Speaker N: text" format
      const match = line.match(_SPEAKER_LINE_PATTERN);
      if (match) {
        const speakerLabel = _normalizeSpeakerLabel(match[1].trim());
        const turnText     = match[2].trim();
        if (isUsableTranscriptText(turnText, 1)) {
          return normalizeTurn(
            {
              id:             `line-${index}`,
              speaker:        speakerLabel,
              startMs:        index * 12000,
              endMs:          index * 12000 + 8000,
              text:           turnText,
              displayText:    turnText,
              confidenceLabel: 'unknown',
              confidence:      null,
              segmentCount:    1,
            },
            index,
          );
        }
      }

      // Plain line — assign to Speaker 1
      return normalizeTurn(
        {
          id:             `line-${index}`,
          speaker:        'Speaker 1',
          startMs:        index * 12000,
          endMs:          index * 12000 + 8000,
          text:           line,
          displayText:    line,
          confidenceLabel: 'unknown',
          confidence:      null,
          segmentCount:    1,
        },
        index,
      );
    })
    .filter(Boolean);
};

// ─── COVERAGE ─────────────────────────────────────────────────────────────────
export const transcriptCoverageRatio = (turns = [], fallbackText = '') => {
  const normalizedFallback = normalizeText(fallbackText);
  if (!normalizedFallback) return 1;
  const turnsText = normalizeText((turns || []).map((turn) => turn?.text || '').join(' '));
  if (!turnsText) return 0;
  return Number((turnsText.length / Math.max(1, normalizedFallback.length)).toFixed(3));
};


// ─── EXPAND TURNS WITH EMBEDDED SPEAKER LABELS ───────────────────────────────
/**
 * Detect if a turn's text contains embedded "Speaker N:" labels (old DB format
 * where the Gemini blob was stored as one segment).
 * If so, split it into multiple turns with proportional timestamps.
 * Otherwise return the turn as-is in a single-element array.
 */
const _EMBEDDED_SPEAKER_PATTERN = /^(?:Speaker\s*\d+|SPEAKER\s*\d+)\s*:\s*/im;

const expandTurnIfEmbeddedLabels = (turn, turnIndex) => {
  const text = String(turn.text || '').trim();
  if (!text || !_EMBEDDED_SPEAKER_PATTERN.test(text)) {
    // No embedded labels — return as-is
    return [turn];
  }

  // Split on lines starting with "Speaker N:" or "SPEAKER N:"
  const blockPattern = /^(?=(?:Speaker\s*\d+|SPEAKER\s*\d+)\s*:)/im;
  const rawBlocks = text.split(blockPattern).filter(Boolean);
  if (rawBlocks.length <= 1) return [turn];

  const startMs = Number(turn.startMs || 0);
  const endMs   = Number(turn.endMs   || startMs + rawBlocks.length * 10000);
  const duration = Math.max(endMs - startMs, rawBlocks.length * 1000);
  const perBlock = duration / rawBlocks.length;

  return rawBlocks.map((block, i) => {
    const lineMatch = block.match(/^(Speaker\s*\d+|SPEAKER\s*\d+)\s*:\s*([\s\S]*)/i);
    const rawSpeaker = lineMatch ? lineMatch[1].trim() : (turn.speaker || 'Speaker 1');
    const blockText  = lineMatch ? lineMatch[2].trim() : block.trim();
    if (!blockText) return null;

    const blockStart = Math.round(startMs + i * perBlock);
    const blockEnd   = Math.round(startMs + (i + 1) * perBlock);
    const speakerLabel = _normalizeSpeakerLabel(rawSpeaker);

    return normalizeTurn({
      ...turn,
      id: `${turn.id || turnIndex}-expand-${i}`,
      speaker: speakerLabel,
      startMs: blockStart,
      endMs:   blockEnd,
      start:   blockStart / 1000,
      end:     blockEnd   / 1000,
      text:     blockText,
      displayText: blockText,
      finalValidatedText: blockText,
      sourceText:  blockText,
      englishText: '',
    }, i);
  }).filter(Boolean);
};

// ─── buildRenderableTranscriptTurns (main entry point) ────────────────────────
export const buildRenderableTranscriptTurns = (transcript = {}, fallbackText = '') => {
  // v6.0: try conversation_text first — has Speaker N labels
  // Only accept if we get MULTIPLE turns (> 1 speaker found).
  // If only 1 turn comes back it means the inline-speaker split didn't fire
  // (e.g. the text is a plain blob without labels) — fall through so
  // groupedSpeakerTurns (which expandTurnIfEmbeddedLabels handles) gets a chance.
  const conversationText = normalizeText(transcript?.conversation_text || '');
  if (conversationText && isUsableTranscriptText(conversationText, 2)) {
    const turns = buildTurnsFromLines(conversationText);
    if (turns.length > 1) return turns;
    // single-turn fallthrough — try structured paths first, use this as last resort
    var conversationFallbackTurns = turns;
  }

  // Try groupedSpeakerTurns (already normalized turns from backend)
  // Expand any turns whose .text contains embedded "Speaker N:" labels (legacy DB format)
  const rawGrouped = normalizeTurns(transcript?.groupedSpeakerTurns || []);
  if (rawGrouped.length > 0) {
    const expanded = rawGrouped.flatMap((turn, i) => expandTurnIfEmbeddedLabels(turn, i));
    if (expanded.length > 0) return expanded;
  }

  // Try segments
  const rawSegments = normalizeTurns(transcript?.segments || []);
  if (rawSegments.length > 0) {
    const expanded = rawSegments.flatMap((turn, i) => expandTurnIfEmbeddedLabels(turn, i));
    if (expanded.length > 0) return expanded;
  }

  // Use single-turn conversation_text result if we have it (better than raw parse)
  if (typeof conversationFallbackTurns !== 'undefined' && conversationFallbackTurns.length > 0) {
    return conversationFallbackTurns;
  }

  // Last resort: parse fullText as lines
  const normalizedFallback = selectDisplayTranscript(transcript, fallbackText);
  return buildTurnsFromLines(normalizedFallback);
};

// ─── normalizeTranscriptEventPayload ─────────────────────────────────────────
export const normalizeTranscriptEventPayload = (payload = {}) => ({
  meetingId:          payload?.meetingId || null,
  finalValidatedText: selectDisplayTranscript(payload),
  fullText:           selectDisplayTranscript(payload),
  displayText:        selectDisplayTranscript(payload),
  conversation_text:  normalizeText(payload?.conversation_text || ''),
  validatedEnglishText: chooseBestTranscriptText(
    payload?.validatedEnglishText,
    payload?.translatedEnglish,
    payload?.cleanEnglish,
  ),
  translatedEnglish: chooseBestTranscriptText(
    payload?.validatedEnglishText,
    payload?.translatedEnglish,
    payload?.cleanEnglish,
  ),
  cleanEnglish: chooseBestTranscriptText(
    payload?.validatedEnglishText,
    payload?.cleanEnglish,
    payload?.translatedEnglish,
  ),
  validatedSourceText: chooseBestTranscriptText(
    payload?.validatedSourceText,
    payload?.sourceFullText,
    payload?.rawTranscriptNormalized,
    payload?.rawFullText,
  ),
  sourceFullText: chooseBestTranscriptText(
    payload?.validatedSourceText,
    payload?.sourceFullText,
    payload?.rawTranscriptNormalized,
    payload?.rawFullText,
  ),
  rawFullText: chooseBestTranscriptText(
    payload?.rawFullText,
    payload?.sourceFullText,
    payload?.rawTranscriptNormalized,
  ),
  rawTranscriptNormalized: chooseBestTranscriptText(
    payload?.rawTranscriptNormalized,
    payload?.sourceFullText,
    payload?.rawFullText,
  ),
  groupedSpeakerTurns: normalizeTurns(payload?.groupedSpeakerTurns || []),
  segments:            normalizeTurns(payload?.segments || []),
  processingStatus:    payload?.processingStatus || 'partial',
  warnings:            Array.isArray(payload?.warnings) ? payload.warnings.filter(Boolean) : [],
  translationWarnings: Array.isArray(payload?.translationWarnings) ? payload.translationWarnings.filter(Boolean) : [],
  uncertainTerms:      Array.isArray(payload?.uncertainTerms) ? payload.uncertainTerms.filter(Boolean) : [],
  confidenceNotes:     Array.isArray(payload?.confidenceNotes)
    ? payload.confidenceNotes.filter(Boolean)
    : (payload?.confidenceNotes ? [String(payload.confidenceNotes)] : []),
  quality:        payload?.quality || {},
  fallbackReason: payload?.fallbackReason || payload?.quality?.fallbackReason || '',
});