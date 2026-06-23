/**
 * qa.js — Frontend QA utilities — v9.0
 * =======================================
 * Changes from v8.0:
 *  - getModeLabel: covers qwen/qwen2.5, rule_based, extractive variants — all neutral labels
 *  - isModeAI: extended to include qwen
 *  - buildAnswerState: error message is always neutral (no provider/technical text to user)
 *  - buildAnswerState: success message updated for collapsed evidence ("expand Evidence below")
 *  - normalizeSources: unchanged (already correct)
 */

// ─── Timestamp formatter ─────────────────────────────────────────────────────
export const formatMs = (value) => {
  const totalSeconds = Math.max(0, Math.floor(Number(value || 0) / 1000));
  const hours   = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
};

// ─── Source normalizer — preserves `speaker` field ────────────────────────────
export const normalizeSources = (sources) => {
  if (!Array.isArray(sources)) return [];

  return sources
    .map((source) => ({
      startMs:     Number(source?.startMs || 0),
      endMs:       Number(source?.endMs   || 0),
      textSnippet: String(source?.textSnippet || source?.text || '').trim(),
      confidence:  Number(source?.confidence  || 0),
      speaker:     source?.speaker ? String(source.speaker).trim() : null,
    }))
    .filter((source) => source.textSnippet);
};

// ─── Limited-context detector ─────────────────────────────────────────────────
export const isLimitedContext = (transcriptText = '', chunkCount = 0, wordCount = 0) => {
  const safeWordCount =
    Number(wordCount || 0) ||
    String(transcriptText || '').trim().split(/\s+/).filter(Boolean).length;
  const safeChunkCount = Number(chunkCount || 0);
  return safeWordCount > 0 && (safeWordCount <= 24 || safeChunkCount <= 2);
};

// ─── Answer state builder ─────────────────────────────────────────────────────
export const buildAnswerState = (interaction = {}) => {
  if (interaction?.loading) {
    return {
      tone: 'loading',
      label: 'Thinking …',
      message: 'Searching the transcript and building a grounded answer.',
    };
  }

  // Error — always neutral, never expose provider/technical details
  if (interaction?.error) {
    return {
      tone: 'error',
      label: 'Unavailable',
      message: 'This answer could not be retrieved. Please try again.',
    };
  }

  if (interaction?.transcriptAvailable === false) {
    return {
      tone: 'empty',
      label: 'No transcript yet',
      message: 'No transcript is available yet for this meeting.',
    };
  }

  if (interaction?.limitedContext) {
    return {
      tone: 'limited',
      label: 'Limited transcript',
      message: 'Answer is based only on the currently available (partial) transcript.',
    };
  }

  const conf    = String(interaction?.confidence || '').toLowerCase();
  const confMap = {
    high:   'High confidence',
    medium: 'Medium confidence',
    low:    'Low confidence',
  };

  return {
    tone:    'normal',
    label:   confMap[conf] || (conf ? `${conf.charAt(0).toUpperCase()}${conf.slice(1)} confidence` : 'Grounded answer'),
    message: 'Answer is grounded in transcript evidence. Expand Evidence below to inspect sources.',
  };
};

// ─── Transcript status formatter ──────────────────────────────────────────────
export const formatTranscriptStatus = (transcriptState) => {
  const safe = String(transcriptState || '').toLowerCase();
  if (safe === 'completed')  return 'Transcript ready';
  if (safe === 'partial')    return 'Transcript partially available';
  if (safe === 'processing') return 'Transcript still streaming';
  if (safe === 'pending')    return 'Transcript not available yet';
  if (!safe)                 return 'Transcript status unavailable';
  return safe.charAt(0).toUpperCase() + safe.slice(1);
};

// ─── Chat timestamp formatters ────────────────────────────────────────────────
export const formatChatTime = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

export const formatChatDay = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' });
};

export const isSameChatDay = (first, second) => {
  if (!first || !second) return false;
  const a = new Date(first);
  const b = new Date(second);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return false;
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth()    === b.getMonth()    &&
    a.getDate()     === b.getDate()
  );
};

// ─── Mode label helper ─────────────────────────────────────────────────────────
// Returns a clean, user-facing label for the AI mode value.
// Never exposes internal fallback mechanics or provider failure text.
export const getModeLabel = (mode) => {
  if (!mode) return 'AI';
  const m = String(mode).toLowerCase().trim();

  // Known AI providers
  if (m === 'gemini')               return 'Gemini AI';
  if (m === 'qwen' || m === 'qwen2.5' || m === 'qwen2') return 'Qwen 2.5';
  if (m === 'semantic')             return 'Semantic';
  if (m === 'rule_based')           return 'Rule-based';

  // All fallback / extractive / rule variants → neutral label
  if (m.includes('fallback') || m.includes('rule') || m.includes('extractive')) return 'AI';

  return 'AI';
};

export const isModeGemini = (mode) => String(mode || '').toLowerCase() === 'gemini';
export const isModeAI     = (mode) => {
  const m = String(mode || '').toLowerCase();
  return m === 'gemini' || m === 'qwen' || m === 'qwen2.5' || m === 'qwen2' || m === 'semantic';
};
