const {
  cleanTranscriptText,
  normalizeTranscriptText,
  chooseBestTranscriptText,
  isUsableTranscript,
  isHallucinatedRepetition,
} = require('./transcriptText');

const DEFAULTS = {
  // v5.1: raised from 1200ms to 2000ms — Gujarati/Hindi speech has natural
  // pauses between phrases that were incorrectly splitting single turns
  mergeGapMs: Number(process.env.TRANSCRIPT_SAME_SPEAKER_MERGE_GAP_MS || 2000),
  longPauseSplitMs: Number(process.env.TRANSCRIPT_SAME_SPEAKER_LONG_PAUSE_SPLIT_MS || 5000),
  fillerMaxWords: Number(process.env.TRANSCRIPT_FILLER_MAX_WORDS || 3),
};

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function formatMsClock(ms) {
  const totalSeconds = Math.max(0, Math.floor(toNumber(ms, 0) / 1000));
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function normalizeWords(words = []) {
  return (Array.isArray(words) ? words : [])
    .map((word) => ({
      ...word,
      word: normalizeTranscriptText(word?.word || word?.text || ''),
      start: toNumber(word?.start, 0),
      end: toNumber(word?.end, toNumber(word?.start, 0)),
      startMs: toNumber(word?.startMs, Math.round(toNumber(word?.start, 0) * 1000)),
      endMs: toNumber(word?.endMs, Math.round(toNumber(word?.end, toNumber(word?.start, 0)) * 1000)),
      probability: typeof word?.probability === 'number' ? word.probability : null,
    }))
    .filter((word) => word.word);
}

function normalizeSegment(segment = {}, index = 0) {
  const startMs = toNumber(segment.startMs, Math.round(toNumber(segment.start, 0) * 1000));
  const endMs = Math.max(startMs, toNumber(segment.endMs, Math.round(toNumber(segment.end, toNumber(segment.start, 0)) * 1000)));
  const sourceText = cleanTranscriptText(segment.sourceText || segment.normalizedSourceText || segment.rawSourceText || '', { preserveRepeats: true, preserveNumbers: true });
  const englishText = cleanTranscriptText(segment.englishText || segment.translatedText || '', { preserveRepeats: true, preserveNumbers: true });
  const validatedText = chooseBestTranscriptText(segment.finalValidatedText, segment.displayText, englishText, sourceText, segment.text);
  if (!isUsableTranscript(validatedText, { minWords: 1 }) && !isUsableTranscript(sourceText, { minWords: 1 }) && !isUsableTranscript(englishText, { minWords: 1 })) {
    return null;
  }
  return {
    id: Number.isFinite(Number(segment.id)) ? Number(segment.id) : index,
    start: startMs / 1000,
    end: endMs / 1000,
    startMs,
    endMs,
    speaker: String(segment.speaker || 'Speaker 1').trim() || 'Speaker 1',
    language: String(segment.language || segment.sourceLanguage || '').trim(),
    sourceLanguage: String(segment.sourceLanguage || segment.language || '').trim(),
    text: validatedText || sourceText || englishText,
    displayText: validatedText || sourceText || englishText,
    sourceText,
    englishText,
    rawSourceText: cleanTranscriptText(segment.rawSourceText || sourceText, { preserveRepeats: true, preserveNumbers: true }),
    normalizedSourceText: cleanTranscriptText(segment.normalizedSourceText || sourceText, { preserveRepeats: true, preserveNumbers: true }),
    confidence: typeof segment.confidence === 'number' ? segment.confidence : null,
    confidenceLabel: String(segment.confidenceLabel || 'unknown').trim() || 'unknown',
    needsReview: Boolean(segment.needsReview),
    uncertainTerms: Array.isArray(segment.uncertainTerms)
      ? segment.uncertainTerms.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    translationWarnings: Array.isArray(segment.translationWarnings)
      ? segment.translationWarnings.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    words: normalizeWords(segment.words),
    chunkIndex: Number.isFinite(Number(segment.chunkIndex)) ? Number(segment.chunkIndex) : 0,
  };
}

function dedupeBoundaryOverlap(prevText = '', nextText = '', maxOverlapWords = 12) {
  const left = normalizeTranscriptText(prevText);
  const right = normalizeTranscriptText(nextText);
  if (!left) return right;
  if (!right) return '';
  const leftTokens = left.split(/\s+/u);
  const rightTokens = right.split(/\s+/u);
  const maxOverlap = Math.min(maxOverlapWords, leftTokens.length, rightTokens.length);
  for (let size = maxOverlap; size >= 4; size -= 1) {
    const leftSlice = leftTokens.slice(-size).join(' ').toLocaleLowerCase();
    const rightSlice = rightTokens.slice(0, size).join(' ').toLocaleLowerCase();
    if (leftSlice && leftSlice === rightSlice) {
      return normalizeTranscriptText(rightTokens.slice(size).join(' '));
    }
  }
  return right;
}

function averageConfidence(segments = []) {
  const values = segments.map((segment) => segment?.confidence).filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (!values.length) return null;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4));
}

function labelConfidence(confidence) {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return 'unknown';
  if (confidence < 0.45) return 'low';
  if (confidence < 0.65) return 'medium';
  return 'high';
}

function isShortFillerTurn(text = '', fillerMaxWords = DEFAULTS.fillerMaxWords) {
  const normalized = normalizeTranscriptText(text).toLocaleLowerCase();
  if (!normalized) return true;
  const tokens = normalized.split(/\s+/u).filter(Boolean);
  if (tokens.length > fillerMaxWords) return false;
  return tokens.every((token) => ['yes', 'ok', 'okay', 'hmm', 'hm', 'mm', 'uh', 'um', 'right', 'sure', 'હં', 'એમ', 'અં'].includes(token));
}

function shouldMergeTurns(previousTurn, nextSegment, options = {}) {
  if (!previousTurn || !nextSegment) return false;
  const mergeGapMs = toNumber(options.mergeGapMs, DEFAULTS.mergeGapMs);
  const longPauseSplitMs = toNumber(options.longPauseSplitMs, DEFAULTS.longPauseSplitMs);
  const gapMs = Math.max(0, toNumber(nextSegment.startMs, 0) - toNumber(previousTurn.endMs, 0));
  if (String(previousTurn.speaker) !== String(nextSegment.speaker)) return false;
  if (gapMs <= mergeGapMs) return true;
  if (gapMs >= longPauseSplitMs) return false;
  const prevText = normalizeTranscriptText(previousTurn.text || previousTurn.sourceText || '');
  const nextText = normalizeTranscriptText(nextSegment.text || nextSegment.sourceText || '');
  if (!prevText || !nextText) return gapMs <= mergeGapMs;
  if (isShortFillerTurn(prevText) || isShortFillerTurn(nextText)) return gapMs <= Math.max(mergeGapMs, 1800);
  const prevEndsWithSentence = /[.!?।]$/.test(prevText);
  const nextStartsContinuation = /^[a-zઅ-હऀ-ॿ0-9]/iu.test(nextText);
  if (!prevEndsWithSentence || nextStartsContinuation) return gapMs <= Math.max(mergeGapMs, 1800);
  return false;
}

function mergeValidatedText(previousTurn, current) {
  const source = cleanTranscriptText(
    [previousTurn.sourceText, dedupeBoundaryOverlap(previousTurn.sourceText, current.sourceText)]
      .filter(Boolean)
      .join(' '),
    { preserveRepeats: true, preserveNumbers: true },
  );
  const english = cleanTranscriptText(
    [previousTurn.englishText, dedupeBoundaryOverlap(previousTurn.englishText, current.englishText)]
      .filter(Boolean)
      .join(' '),
    { preserveRepeats: true, preserveNumbers: true },
  );
  // PRESERVE_ORIGINAL: source text ALWAYS wins for the display field.
  // English is stored separately for Q&A / search — never shown as primary display.
  // chooseBestTranscriptText would pick english when it has more words (translated text
  // is often longer), which would override the original Gujarati/Hindi text.
  const display = source || english || cleanTranscriptText(
    chooseBestTranscriptText(previousTurn.text, current.text),
    { preserveRepeats: true, preserveNumbers: true },
  );
  return {
    english,
    source,
    display: cleanTranscriptText(display, { preserveRepeats: true, preserveNumbers: true }),
  };
}

function buildSpeakerTurns(segments = [], options = {}) {
  const normalizedSegments = (Array.isArray(segments) ? segments : [])
    .map((segment, index) => normalizeSegment(segment, index))
    .filter((segment) => segment && (segment.text || segment.sourceText))
    .filter((segment) => !isHallucinatedRepetition(segment.text || segment.sourceText || ''))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id - b.id);

  const turns = [];
  for (const segment of normalizedSegments) {
    const current = {
      ...segment,
      segments: [segment],
      words: [...(segment.words || [])],
      uncertainTerms: [...(segment.uncertainTerms || [])],
      translationWarnings: [...(segment.translationWarnings || [])],
    };

    if (!turns.length) {
      turns.push(current);
      continue;
    }

    const previousTurn = turns[turns.length - 1];
    if (shouldMergeTurns(previousTurn, current, options)) {
      previousTurn.endMs = Math.max(previousTurn.endMs, current.endMs);
      previousTurn.end = previousTurn.endMs / 1000;
      const merged = mergeValidatedText(previousTurn, current);
      previousTurn.text = merged.display;
      previousTurn.displayText = merged.display;
      previousTurn.sourceText = merged.source;
      previousTurn.englishText = merged.english;
      previousTurn.rawSourceText = cleanTranscriptText(
        [previousTurn.rawSourceText, dedupeBoundaryOverlap(previousTurn.rawSourceText, current.rawSourceText)]
          .filter(Boolean)
          .join(' '),
        { preserveRepeats: true, preserveNumbers: true },
      );
      previousTurn.normalizedSourceText = previousTurn.sourceText;
      previousTurn.words = [...(previousTurn.words || []), ...(current.words || [])];
      previousTurn.segments.push(segment);
      previousTurn.needsReview = previousTurn.needsReview || current.needsReview;
      previousTurn.uncertainTerms = [...new Set([...(previousTurn.uncertainTerms || []), ...(current.uncertainTerms || [])])];
      previousTurn.translationWarnings = [...new Set([...(previousTurn.translationWarnings || []), ...(current.translationWarnings || [])])];
      previousTurn.confidence = averageConfidence(previousTurn.segments);
      previousTurn.confidenceLabel = labelConfidence(previousTurn.confidence);
      previousTurn.start = previousTurn.startMs / 1000;
      continue;
    }

    turns.push(current);
  }

  return turns
    .map((turn, index) => {
      // PRESERVE_ORIGINAL: source text is always the primary display.
      // chooseBestTranscriptText picks by word count — English text is often
      // longer than Gujarati/Hindi script, causing it to incorrectly "win".
      const sourceText = cleanTranscriptText(turn.sourceText, { preserveRepeats: true, preserveNumbers: true });
      const englishText = cleanTranscriptText(turn.englishText, { preserveRepeats: true, preserveNumbers: true });
      // Use source if available; fall back to english only if source is empty
      const display = (sourceText && isUsableTranscript(sourceText, { minWords: 1 }))
        ? sourceText
        : (englishText && isUsableTranscript(englishText, { minWords: 1 }))
          ? englishText
          : cleanTranscriptText(turn.text, { preserveRepeats: true, preserveNumbers: true });

      if (!isUsableTranscript(display, { minWords: 1 }) || isHallucinatedRepetition(display)) return null;
      return {
        id: index,
        speaker: turn.speaker,
        start: turn.startMs / 1000,
        end: turn.endMs / 1000,
        startMs: turn.startMs,
        endMs: turn.endMs,
        startTimecode: formatMsClock(turn.startMs),
        endTimecode: formatMsClock(turn.endMs),
        language: turn.language || '',
        sourceLanguage: turn.sourceLanguage || turn.language || '',
        text: display,
        displayText: display,
        sourceText,
        englishText,
        rawSourceText: cleanTranscriptText(turn.rawSourceText, { preserveRepeats: true, preserveNumbers: true }),
        normalizedSourceText: cleanTranscriptText(turn.normalizedSourceText, { preserveRepeats: true, preserveNumbers: true }),
        confidence: averageConfidence(turn.segments),
        confidenceLabel: labelConfidence(averageConfidence(turn.segments)),
        needsReview: Boolean(turn.needsReview),
        uncertainTerms: [...new Set(turn.uncertainTerms || [])],
        translationWarnings: [...new Set(turn.translationWarnings || [])],
        chunkIndex: turn.segments.length ? Math.min(...turn.segments.map((seg) => toNumber(seg.chunkIndex, 0))) : 0,
        segmentCount: turn.segments.length,
        segments: turn.segments.map((seg) => ({ ...seg })),
      };
    })
    .filter(Boolean);
}

module.exports = {
  DEFAULTS,
  formatMsClock,
  normalizeSegment,
  buildSpeakerTurns,
  shouldMergeTurns,
  dedupeBoundaryOverlap,
  averageConfidence,
  labelConfidence,
};