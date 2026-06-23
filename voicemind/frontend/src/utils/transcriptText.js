// backend/src/utils/transcriptText.js
// ============================================================
// VoiceMind Transcript Text Utilities — v5.0 FIXED
// ============================================================
//
// FIX: isHallucinatedRepetition() enhanced with two new rules:
//   1. Reject if >45% of tokens are the same token (was >50%)
//   2. Reject numeric-repetition output like "2-3-4-5-6-6-6-6..."
//      — text where ≥45% tokens are same token AND ≥8 numeric tokens
//      — normalized text with <3 alpha words and >10 repeated numeric tokens
//
// FIX: assessTranscriptCandidate() — uses enhanced detector above.
// All other functions unchanged from v4.
// ============================================================

'use strict';

function normalizeTranscriptText(value = '') {
  return String(value || '')
    .replace(/\r/g, ' ')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeUnicode(text = '') {
  return normalizeTranscriptText(text)
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter(Boolean);
}

// ─── BAD PATTERN LISTS ───────────────────────────────────────────────────────
const BAD_PLACEHOLDER_PATTERNS = [
  // Whisper YouTube hallucinations — hard banned
  /thanks?\s+for\s+watching/iu,
  /thank\s+you\s+(very\s+much\s+)?for\s+watching/iu,
  /please\s+(like\s+and\s+)?(subscribe|share)/iu,
  /don'?t\s+forget\s+to\s+subscribe/iu,
  /like\s+and\s+subscribe/iu,
  /hit\s+the\s+bell\s+(icon|button)/iu,
  /i\s+want\s+to\s+be\s+a\s+i\s+want\s+to\s+be\s+a/iu,
  // Original patterns
  /gujarati\s+script\s+when\s+gujarati\s+speech\s+is\s+present/iu,
  /prefer\s+gujarati\s+script\s+when\s+gujarati\s+speech\s+is\s+present/iu,
  /transcribe\s+in\s+gujarati\s+script/iu,
  /render\s+hindi\s+words\s+in\s+gujarati\s+script/iu,
  /return\s+only/iu,
  /^\[?(?:અસ્પષ્ટ|unclear|inaudible)\]?$/iu,
  /^transcript\s+(?:failed|unavailable|not\s+available)$/iu,
  /^gujarati\s+speech\s+detected/iu,
  /do\s+not\s+summarize\s*,?\s*shorten\s*,?\s*or\s+replace\s+valid\s+speech\s+with\s+placeholder\s+text/iu,
  /you\s+are\s+a\s+transcript-preserving\s+translation\s+engine/iu,
  /\bhere\s*['']?s\s+a\s+possible\s+interpretation\b/iu,
  /possible\s+interpretation/iu,
  /this\s+appears\s+to\s+be/iu,
  /the\s+speaker\s+says/iu,
  /^\.*$/,
];

const META_TRANSLATION_PATTERNS = [
  /^(translate|transcribe|convert|return|detect)\b/iu,
  /\bdo not\b/iu,
  /\breturn only\b/iu,
  /\brules\s*:/iu,
  /\bpreserve every spoken detail\b/iu,
  /\bcomplete natural english\b/iu,
  /\bspoken gujarati\/hindi\/english transcript\b/iu,
  /\bthis appears to be\b/iu,
  /\btranslation\s*:/iu,
  /\bsummary\s*:/iu,
  /\bthe speaker says\b/iu,
  /\bpossible\s+interpretation\b/iu,
  /\bfragmented\s+message\b/iu,
  /\bpreserve\s+spoken\s+order\b/iu,
];

const GARBAGE_TOKEN_PATTERNS = [
  /^[h]+$/iu,
  /^[hm]+$/iu,
  /^[._\-+=~]+$/u,
  /^[%#@*&^!?|/\\]+$/u,
  /^[઀-૿]{1,2}$/u,
  /^[ऀ-ॿ]{1,2}$/u,
];

// ─── BASIC DETECTORS ─────────────────────────────────────────────────────────
function hasKnownBadPlaceholder(text = '') {
  const normalized = normalizeTranscriptText(text);
  if (!normalized) return false;
  return BAD_PLACEHOLDER_PATTERNS.some((p) => p.test(normalized));
}

function looksLikeInstructionText(text = '') {
  const normalized = normalizeTranscriptText(text);
  if (!normalized) return false;
  const instructionHits = META_TRANSLATION_PATTERNS.filter((p) => p.test(normalized)).length;
  const lowered = normalized.toLocaleLowerCase();
  if (hasKnownBadPlaceholder(normalized)) return true;
  if (
    lowered.startsWith('do not ')     ||
    lowered.startsWith('rules:')      ||
    lowered.startsWith('return only ') ||
    lowered.startsWith('translate ')  ||
    lowered.startsWith('transcribe ') ||
    lowered.startsWith('convert ')
  ) return true;
  if (lowered.includes('placeholder text') && lowered.includes('do not')) return true;
  return instructionHits >= 1;
}

function hasRepeatedCharacterStretch(text = '', minStretch = 8) {
  const normalized = normalizeTranscriptText(text);
  if (!normalized) return false;
  return (
    /([A-Za-z઀-૿ऀ-ॿ])\1{7,}/u.test(normalized) ||
    new RegExp(`(.)\\1{${Math.max(3, minStretch - 1)},}`, 'u').test(normalized)
  );
}

// ─── FIX: NUMERIC SEQUENCE DETECTOR ──────────────────────────────────────────
// Detects "2-3-4-5-6-6-6-6-6..." and similar numeric repetition hallucinations.
function isNumericSequenceHallucination(text = '') {
  const normalized = normalizeTranscriptText(text);
  if (!normalized) return false;

  const compact = normalized.replace(/\s+/gu, '');

  // Compact form: all digits + separators, 12+ chars
  if (/^(?:\d+[-–—,.:/]*){12,}$/u.test(compact)) {
    const digits = compact.match(/\d/gu) || [];
    if (digits.length >= 12) {
      const counts = new Map();
      for (const d of digits) counts.set(d, (counts.get(d) || 0) + 1);
      const maxCount = Math.max(...counts.values());
      const uniqueRatio = counts.size / Math.max(1, digits.length);
      return uniqueRatio <= 0.45 || maxCount >= Math.max(8, Math.floor(digits.length * 0.55));
    }
  }

  // Token form: 12+ numeric tokens
  const tokens = normalized.match(/\d+/gu) || [];
  if (tokens.length >= 12) {
    const counts = new Map();
    for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
    return Math.max(...counts.values()) >= Math.max(8, Math.floor(tokens.length * 0.55));
  }

  // NEW: Short numeric repetition (8+ tokens, 45%+ same token, <3 alpha words)
  const allTokens = normalized.match(/[\p{L}\p{N}%:/._'-]+/gu) || [];
  if (allTokens.length >= 8) {
    const numericTokens = allTokens.filter((t) => /^\d+[-–—,.:]*\d*$/.test(t));
    if (numericTokens.length >= 8) {
      const counts = new Map();
      for (const t of allTokens) counts.set(t, (counts.get(t) || 0) + 1);
      const maxCount = Math.max(...counts.values());
      const dominantRatio = maxCount / Math.max(allTokens.length, 1);
      const alphaWords = allTokens.filter((t) => /[a-zA-Z\u0900-\u097F\u0A80-\u0AFF]/.test(t));

      // ≥45% same token OR (<3 alpha words AND >10 numeric tokens)
      if (dominantRatio >= 0.45) return true;
      if (alphaWords.length < 3 && numericTokens.length > 10) return true;
    }
  }

  return false;
}

function repeatedLineRatio(text = '') {
  const tokens = tokenizeUnicode(text).map((item) => item.toLocaleLowerCase());
  if (tokens.length < 8) return 0;
  const uniqueCount = new Set(tokens).size;
  return Number((1 - uniqueCount / Math.max(tokens.length, 1)).toFixed(3));
}

// ─── FIX: ENHANCED HALLUCINATION DETECTOR ────────────────────────────────────
function isHallucinatedRepetition(text = '', options = {}) {
  const normalized = normalizeTranscriptText(text);
  if (!normalized) return false;

  // Base: character stretch or numeric sequence
  if (hasRepeatedCharacterStretch(normalized, options.minStretch || 8)) return true;
  if (isNumericSequenceHallucination(normalized)) return true;

  const tokens = normalized.toLocaleLowerCase().match(/[\p{L}\p{N}%:/._'-]+/gu) || [];
  if (tokens.length < 8) return false;

  const uniqueRatio = new Set(tokens).size / Math.max(tokens.length, 1);
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
  const maxCount = Math.max(...counts.values());

  // FIX v8.0: Raised thresholds to avoid rejecting real conversational speech.
  // Real conversations can repeat the same question many times (e.g. someone asking
  // "What's your name?" 8× in a 60s chunk). The old 0.45 dominance threshold
  // was falsely flagging this as hallucination.
  // True Whisper hallucinations (silence → repeated phrase loop) are caught by:
  //   1. The banned-phrase check in _hasBannedPhrase()
  //   2. uniqueRatio < 0.10 (extremely collapsed vocabulary)
  //   3. The phrase repetition detector below (exact phrase repeated 3+ times)
  if (uniqueRatio < 0.10 || maxCount >= Math.max(8, Math.floor(tokens.length * 0.70))) {
    return true;
  }

  // Phrase repetition detector
  for (let size = Math.min(14, Math.floor(tokens.length / 2)); size >= 3; size -= 1) {
    const left = tokens.slice(0, size).join(' ');
    let repeats = 1;
    while ((repeats + 1) * size <= tokens.length) {
      const next = tokens.slice(repeats * size, (repeats + 1) * size).join(' ');
      if (next !== left) break;
      repeats += 1;
    }
    if (repeats >= 3 || (repeats >= 2 && size >= 6)) return true;
  }

  return false;
}

// ─── TEXT CLEANERS ────────────────────────────────────────────────────────────
function removeExactConsecutiveDuplicateWords(text = '', maxConsecutive = 2) {
  const tokens = tokenizeUnicode(text);
  if (tokens.length <= 1) return normalizeTranscriptText(text);

  const out = [];
  let prev  = null;
  let streak = 0;

  for (const token of tokens) {
    const lowered = token.toLocaleLowerCase();
    if (prev && lowered === prev) {
      streak += 1;
      if (streak > Math.max(2, Number(maxConsecutive || 2))) continue;
    } else {
      streak = 1;
      prev = lowered;
    }
    out.push(token);
  }

  return normalizeTranscriptText(out.join(' '));
}

function removeRepeatedPhrases(text = '', options = {}) {
  const tokens = tokenizeUnicode(text);
  if (tokens.length < 12) return normalizeTranscriptText(text);

  const lowered  = tokens.map((t) => t.toLocaleLowerCase());
  const out      = [];
  let i          = 0;
  const maxWindow    = Math.max(4, Number(options.maxWindow    || 14));
  const minPhraseSize = Math.max(3, Number(options.minPhraseSize || 3));

  while (i < tokens.length) {
    let collapsed = false;
    const maxN = Math.min(maxWindow, Math.floor((tokens.length - i) / 2));

    for (let size = maxN; size >= minPhraseSize; size -= 1) {
      const phrase = lowered.slice(i, i + size).join(' ');
      let repeats = 1;
      while (i + (repeats + 1) * size <= tokens.length) {
        const next = lowered.slice(i + repeats * size, i + (repeats + 1) * size).join(' ');
        if (next !== phrase) break;
        repeats += 1;
      }
      const shouldCollapse = repeats >= 3 || (repeats >= 2 && size >= 8);
      if (!shouldCollapse) continue;
      out.push(...tokens.slice(i, i + size));
      i += repeats * size;
      collapsed = true;
      break;
    }

    if (!collapsed) { out.push(tokens[i]); i += 1; }
  }

  return normalizeTranscriptText(out.join(' '));
}

function removeInternalDuplicatePassages(text = '', options = {}) {
  const tokens = tokenizeUnicode(text);
  if (tokens.length < 22) return normalizeTranscriptText(text);

  const lowered       = tokens.map((t) => t.toLocaleLowerCase());
  const minAnchorSize = Math.max(5, Number(options.minAnchorSize || 5));
  const maxAnchorSize = Math.min(12, Math.max(minAnchorSize, Number(options.maxAnchorSize || 10)));

  for (let anchorSize = maxAnchorSize; anchorSize >= minAnchorSize; anchorSize -= 1) {
    const prefix = lowered.slice(0, anchorSize).join(' ');

    for (let idx = anchorSize + 10; idx <= tokens.length - anchorSize; idx += 1) {
      const candidate = lowered.slice(idx, idx + anchorSize).join(' ');
      if (candidate !== prefix) continue;

      const left  = lowered.slice(0, idx);
      const right = lowered.slice(idx);
      const leftUniqueRatio  = new Set(left).size  / Math.max(1, left.length);
      const rightUniqueRatio = new Set(right).size / Math.max(1, right.length);
      const repeatedIntro = idx <= Math.max(26, anchorSize * 3);

      if (repeatedIntro && (leftUniqueRatio < 0.55 || rightUniqueRatio < 0.55)) {
        return normalizeTranscriptText(tokens.slice(0, idx).join(' '));
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
    /\b(?:mrp|gst|otp|api|url|http|https|v\d+)\b/giu,
    /\b[A-Z]{2,}[A-Z0-9-]*\b/gu,
    /\b\d+[\d,.:/-]*\b/gu,
  ];

  for (const pattern of protectedPatterns) {
    for (const match of normalized.matchAll(pattern)) {
      keepRanges.push([match.index, match.index + match[0].length]);
    }
  }

  const isProtected = (start, end) => keepRanges.some(([a, b]) => start < b && end > a);

  let cleaned = normalized.replace(/\b(?:\d+\s+){7,}\d+\b/gu, (match, offset) =>
    isProtected(offset, offset + match.length) ? match : ' '
  );
  cleaned = cleaned.replace(/\b([A-Za-z])\1{6,}\b/g, '$1');
  return normalizeTranscriptText(cleaned);
}

function cleanTranscriptText(text = '', options = {}) {
  const preserveRepeats = Boolean(options.preserveRepeats);
  const preserveNumbers = options.preserveNumbers !== false;
  let value = normalizeTranscriptText(text);
  if (!value) return '';
  if (hasKnownBadPlaceholder(value) || looksLikeInstructionText(value)) return '';
  if (isHallucinatedRepetition(value, options)) {
    if (preserveRepeats) {
      value = removeExactConsecutiveDuplicateWords(value, options.maxConsecutiveRepeats || 2);
    } else {
      value = removeRepeatedPhrases(value, options);
      value = removeExactConsecutiveDuplicateWords(value, options.maxConsecutiveRepeats || 2);
    }
  } else if (!preserveRepeats) {
    value = removeRepeatedPhrases(value, options);
  }
  value = removeInternalDuplicatePassages(value, options);
  value = removeExactConsecutiveDuplicateWords(value, options.maxConsecutiveRepeats || 2);
  if (!preserveNumbers) value = removeNoiseTokens(value);
  return normalizeTranscriptText(value);
}

// ─── QUALITY ASSESSORS ────────────────────────────────────────────────────────
function isMostlyNonLatin(text = '') {
  const cleaned = normalizeTranscriptText(text);
  if (!cleaned) return false;
  const chars = [...cleaned];
  let letters = 0;
  let nonLatin = 0;
  for (const ch of chars) {
    if (/\p{L}/u.test(ch)) {
      letters += 1;
      if (!/\p{Script=Latin}/u.test(ch)) nonLatin += 1;
    }
  }
  return letters > 0 && (nonLatin / letters) >= 0.35;
}

function countPreservedNumbers(text = '') {
  return (normalizeTranscriptText(text).match(/\b\d+[\d,.:/-]*\b/g) || []).length;
}

function isSuspiciousShrinkage(sourceText = '', candidateText = '', options = {}) {
  const source    = normalizeTranscriptText(sourceText);
  const candidate = normalizeTranscriptText(candidateText);
  if (!source || !candidate) return false;

  const sourceWords    = tokenizeUnicode(source).length;
  const candidateWords = tokenizeUnicode(candidate).length;
  const minWordRatio = Number(options.minWordRatio || 0.55);
  const minCharRatio = Number(options.minCharRatio || 0.45);

  if (
    candidateWords < Math.max(1, Math.floor(sourceWords * minWordRatio)) &&
    candidate.length < Math.floor(source.length * minCharRatio)
  ) return true;

  const sourceNumbers    = countPreservedNumbers(source);
  const candidateNumbers = countPreservedNumbers(candidate);
  if (sourceNumbers >= 2 && candidateNumbers < Math.max(1, Math.floor(sourceNumbers * 0.65))) return true;

  return false;
}

function looksLikeGarbageNoise(text = '') {
  const normalized = normalizeTranscriptText(text);
  if (!normalized) return true;
  const tokens = tokenizeUnicode(normalized);
  if (!tokens.length) return true;

  const badTokens  = tokens.filter((t) => GARBAGE_TOKEN_PATTERNS.some((p) => p.test(t)));
  const badRatio   = badTokens.length / Math.max(tokens.length, 1);
  const symbolCount  = (normalized.match(/[^\p{L}\p{N}\s]/gu) || []).length;
  const letterCount  = (normalized.match(/[\p{L}\p{N}]/gu) || []).length;
  const symbolHeavy  = symbolCount > 0 && symbolCount > letterCount * 1.2;

  return badRatio >= 0.45 || symbolHeavy;
}

function isUsableTranscript(text = '', options = {}) {
  const cleaned  = normalizeTranscriptText(text);
  const minWords = Number(options.minWords || 1);
  if (!cleaned) return false;
  if (hasKnownBadPlaceholder(cleaned) || looksLikeInstructionText(cleaned)) return false;
  if (isHallucinatedRepetition(cleaned, options)) return false;
  if (looksLikeGarbageNoise(cleaned)) return false;
  const words = tokenizeUnicode(cleaned);
  if (words.length < minWords && cleaned.length < 10) return false;
  return true;
}

// ─── SELECTION ────────────────────────────────────────────────────────────────
function chooseBestTranscriptText(...values) {
  const candidates = values.flat().map((v) => normalizeTranscriptText(v)).filter(Boolean);
  if (!candidates.length) return '';

  const scored = candidates
    .map((text, index) => ({
      text,
      index,
      usable:      isUsableTranscript(text, { minWords: 1 }),
      placeholder: hasKnownBadPlaceholder(text),
      instruction: looksLikeInstructionText(text),
      repeated:    isHallucinatedRepetition(text),
      garbage:     looksLikeGarbageNoise(text),
      words:       tokenizeUnicode(text).length,
      chars:       text.length,
      nonLatin:    isMostlyNonLatin(text),
    }))
    .sort((a, b) => {
      if (a.usable      !== b.usable)      return Number(b.usable)      - Number(a.usable);
      if (a.placeholder !== b.placeholder) return Number(a.placeholder) - Number(b.placeholder);
      if (a.instruction !== b.instruction) return Number(a.instruction) - Number(b.instruction);
      if (a.repeated    !== b.repeated)    return Number(a.repeated)    - Number(b.repeated);
      if (a.garbage     !== b.garbage)     return Number(a.garbage)     - Number(b.garbage);
      if (a.words       !== b.words)       return b.words - a.words;
      if (a.chars       !== b.chars)       return b.chars - a.chars;
      if (a.nonLatin    !== b.nonLatin)    return Number(b.nonLatin) - Number(a.nonLatin);
      return a.index - b.index;
    });

  return scored[0]?.text || candidates[0] || '';
}

function selectValidatedFinalText(payload = {}, fallbackText = '') {
  // PRESERVE_ORIGINAL: source text always wins over translated English.
  const validatedSource = chooseBestTranscriptText(
    payload?.validatedSourceText,
    payload?.sourceFullText,
    payload?.normalizedSourceFullText,
    payload?.rawTranscriptNormalized,
    payload?.rawFullText,
    // Python fields
    payload?.conversation_text,
    payload?.normalized_text,
    payload?.text,
  );

  const validatedFinal = chooseBestTranscriptText(
    payload?.finalValidatedText,
    payload?.finalBestTranscript,
    payload?.displayText,
    payload?.fullText,
  );

  const validatedEnglish = chooseBestTranscriptText(
    payload?.validatedEnglishText,
    payload?.translatedEnglish,
    payload?.cleanEnglish,
  );

  const primary = chooseBestTranscriptText(validatedSource, validatedFinal);
  if (primary) return primary;
  return chooseBestTranscriptText(validatedEnglish, fallbackText);
}

function preferReadableTranscript(payload = {}) {
  return selectValidatedFinalText(payload, '');
}

function assessTranscriptCandidate(text = '', options = {}) {
  const cleaned = cleanTranscriptText(text, {
    preserveRepeats: Boolean(options.preserveRepeats),
    preserveNumbers: options.preserveNumbers !== false,
  });

  if (!normalizeTranscriptText(text)) {
    return { accepted: false, text: '', reason: 'empty_transcript' };
  }
  if (!cleaned) {
    if (hasKnownBadPlaceholder(text))          return { accepted: false, text: '', reason: 'placeholder_text' };
    if (looksLikeInstructionText(text))        return { accepted: false, text: '', reason: 'instruction_text' };
    if (isHallucinatedRepetition(text, options)) return { accepted: false, text: '', reason: 'hallucinated_repetition' };
    if (looksLikeGarbageNoise(text))           return { accepted: false, text: '', reason: 'garbage_noise_output' };
    return { accepted: false, text: '', reason: 'empty_transcript' };
  }
  if (hasRepeatedCharacterStretch(cleaned, options.minStretch || 8)) return { accepted: false, text: '', reason: 'repeated_character_stretch' };
  if (hasKnownBadPlaceholder(cleaned))         return { accepted: false, text: '', reason: 'placeholder_text' };
  if (looksLikeInstructionText(cleaned))       return { accepted: false, text: '', reason: 'instruction_text' };
  if (isHallucinatedRepetition(cleaned, options)) return { accepted: false, text: '', reason: 'hallucinated_repetition' };
  if (looksLikeGarbageNoise(cleaned))          return { accepted: false, text: '', reason: 'garbage_noise_output' };
  if (!isUsableTranscript(cleaned, { minWords: options.minWords || 1 })) return { accepted: false, text: '', reason: 'empty_transcript' };
  return { accepted: true, text: cleaned, reason: null };
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────
module.exports = {
  normalizeTranscriptText,
  tokenizeUnicode,
  cleanTranscriptText,
  hasKnownBadPlaceholder,
  looksLikeInstructionText,
  hasRepeatedCharacterStretch,
  repeatedLineRatio,
  isHallucinatedRepetition,
  isNumericSequenceHallucination,
  removeExactConsecutiveDuplicateWords,
  removeRepeatedPhrases,
  removeInternalDuplicatePassages,
  removeNoiseTokens,
  isMostlyNonLatin,
  countPreservedNumbers,
  isSuspiciousShrinkage,
  looksLikeGarbageNoise,
  isUsableTranscript,
  chooseBestTranscriptText,
  selectValidatedFinalText,
  preferReadableTranscript,
  assessTranscriptCandidate,
};