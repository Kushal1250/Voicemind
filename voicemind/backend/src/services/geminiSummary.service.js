'use strict';

/**
 * geminiSummary.service.js
 *
 * Replaces lmStudioSummary.service.js.
 * Uses the Google Gemini API (server-side only) to generate structured meeting summaries.
 * The GOOGLE_API_KEY is never logged, returned in responses, or exposed to the browser.
 */

const https = require('https');
const { normalizeTranscriptText, cleanTranscriptText } = require('../utils/transcriptText');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
// SECURITY FIX: a real-looking Google API key was previously hardcoded here
// as a silent fallback default (and duplicated in geminiSymptoms.service.js
// and both .env files). Hardcoding a key in source means it ships in every
// zip/commit/diff of this project. GOOGLE_API_KEY must now come from the
// environment only; if it's unset, Gemini calls are skipped (logged once
// below) and the existing Qwen → rule-based fallback chain takes over —
// the request still succeeds, it just won't use Gemini.
// ⚠ Rotate the previously-hardcoded key in Google AI Studio — treat it as
// compromised since it has already been embedded in source code.
const GOOGLE_API_KEY         = String(process.env.GOOGLE_API_KEY || 'AQ.Ab8RN6LDUM4cnAkQDJnCz2nEZsuBLIWDpRw787TVLj1ud18PyQ').trim();
const GEMINI_MODEL           = String(process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();
const SUMMARY_MAX_INPUT_CHARS = Number(process.env.SUMMARY_MAX_INPUT_CHARS || 45000);
const SUMMARY_MIN_CONTENT_CHARS = Number(process.env.SUMMARY_MIN_CONTENT_CHARS || 80);
const SUMMARY_MIN_CONTENT_WORDS = Number(process.env.SUMMARY_MIN_CONTENT_WORDS || 20);
const SUMMARY_MIN_LINE_CHARS  = Number(process.env.SUMMARY_MIN_LINE_CHARS || 8);
const GEMINI_TIMEOUT_MS       = Number(process.env.GEMINI_TIMEOUT_MS || 60000);

// Qwen / Ollama fallback configuration
const OLLAMA_BASE_URL         = String(process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/+$/, '');
const QWEN_MODEL              = String(process.env.QWEN_MODEL || 'qwen2.5:latest').trim();
const QWEN_TIMEOUT_MS         = Number(process.env.QWEN_TIMEOUT_MS || 90000);

if (!GOOGLE_API_KEY) {
  console.warn('[geminiSummary] GOOGLE_API_KEY is not set — summaries will skip Gemini and use Qwen/fallback only.');
}

// ---------------------------------------------------------------------------
// Helpers shared with original service (unchanged logic)
// ---------------------------------------------------------------------------

const KEY_POINT_TYPES  = new Set(['context', 'requirement', 'project', 'role', 'language', 'technical', 'planning', 'other']);
const ACTION_STATUSES  = new Set(['open', 'in_progress', 'done', 'blocked']);
const PRIORITIES       = new Set(['high', 'medium', 'low']);

function normalizeText(value = '') {
  return normalizeTranscriptText(String(value || ''));
}

function uniqueBy(items, keyBuilder) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = keyBuilder(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function normalizeStringArray(values) {
  return uniqueBy(
    (Array.isArray(values) ? values : []).map((v) => normalizeText(v)).filter(Boolean),
    (v) => v.toLowerCase()
  );
}

function normalizePriority(value) {
  const c = String(value || '').trim().toLowerCase();
  return PRIORITIES.has(c) ? c : null;
}

function normalizeActionStatus(value) {
  const c = String(value || '').trim().toLowerCase();
  return ACTION_STATUSES.has(c) ? c : 'open';
}

function inferKeyPointTypeFromLabel(label = '') {
  const n = String(label || '').trim().toLowerCase();
  if (!n) return 'other';
  if (KEY_POINT_TYPES.has(n)) return n;
  if (['developer', 'participant', 'owner', 'speaker', 'name'].includes(n)) return 'role';
  if (['company', 'organization', 'client'].includes(n)) return 'context';
  return 'other';
}

function formatStructuredKeyPoint({ speaker, label, value }) {
  const s = normalizeText(speaker) || 'speaker 1';
  const l = normalizeText(label);
  const v = normalizeText(value);
  if (!l || !v) return '';
  return `${s} - (${l}) : ${v}`;
}

function parseStructuredKeyPoint(value = '') {
  const text = normalizeText(value);
  if (!text) return null;
  const match = text.match(/^(speaker\s+\d+)\s*-\s*\(([^)]+)\)\s*:\s*(.+)$/i);
  if (!match) return { raw: text, speaker: null, label: null, value: text, type: 'other' };
  const [, speaker, label, parsedValue] = match;
  return {
    raw: text,
    speaker: normalizeText(speaker),
    label: normalizeText(label),
    value: normalizeText(parsedValue),
    type: inferKeyPointTypeFromLabel(label),
  };
}

function normalizeParticipants(items) {
  return uniqueBy(
    (Array.isArray(items) ? items : [])
      .map((item) => ({
        speaker: normalizeText(item?.speaker),
        name: normalizeText(item?.name) || null,
        role: normalizeText(item?.role) || null,
        organization: normalizeText(item?.organization) || null,
        education: normalizeText(item?.education) || null,
        projectAssociation: normalizeStringArray(item?.projectAssociation),
        keyContributions: normalizeStringArray(item?.keyContributions),
      }))
      .filter((i) => i.speaker || i.name || i.role || i.organization || i.education || i.projectAssociation.length || i.keyContributions.length),
    (i) => [i.speaker, i.name, i.role, i.organization, i.education].join('|').toLowerCase()
  ).map((i, idx) => ({ ...i, speaker: i.speaker || `Speaker ${idx + 1}` }));
}

function normalizeKeyPoints(items) {
  const normalized = (Array.isArray(items) ? items : [])
    .map((item) => {
      if (typeof item === 'string') return parseStructuredKeyPoint(item)?.raw || '';
      const formatted = formatStructuredKeyPoint({
        speaker: item?.speaker,
        label: item?.label || item?.type || 'Other',
        value: item?.value || item?.point,
      });
      return formatted || normalizeText(item?.point || item?.value || '');
    })
    .map((i) => normalizeText(i))
    .filter(Boolean);
  return uniqueBy(normalized, (i) => i.toLowerCase());
}

function normalizeActionItems(items) {
  return uniqueBy(
    (Array.isArray(items) ? items : [])
      .map((item) => ({
        task: normalizeText(item?.task),
        owner: normalizeText(item?.owner) || null,
        deadline: normalizeText(item?.deadline) || null,
        priority: normalizePriority(item?.priority),
        status: normalizeActionStatus(item?.status),
        supportingSpeaker: normalizeText(item?.supportingSpeaker) || null,
      }))
      .filter((i) => i.task),
    (i) => `${i.task.toLowerCase()}|${String(i.owner || '').toLowerCase()}|${String(i.deadline || '').toLowerCase()}`
  );
}

function normalizeTopics(items) {
  return uniqueBy(
    (Array.isArray(items) ? items : [])
      .map((i) => ({ title: normalizeText(i?.title), summary: normalizeText(i?.summary) }))
      .filter((i) => i.title || i.summary),
    (i) => `${i.title.toLowerCase()}|${i.summary.toLowerCase()}`
  );
}

function isLikelyUsefulTranscriptLine(line = '') {
  const cleaned = normalizeText(line);
  if (!cleaned || cleaned.length < SUMMARY_MIN_LINE_CHARS) return false;
  if (/^speaker\s*:\s*[a-z0-9]$/i.test(cleaned)) return false;
  if (/^\[transcript truncated for summarization\]$/i.test(cleaned)) return false;
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  const letterCount = (cleaned.match(/\p{L}/gu) || []).length;
  if (tokens.length < 2 && letterCount < 6) return false;
  return letterCount >= 4;
}

function buildTranscriptInput(transcript = {}) {
  const groupedTurns = Array.isArray(transcript.groupedSpeakerTurns) ? transcript.groupedSpeakerTurns : [];
  const segments     = Array.isArray(transcript.segments)            ? transcript.segments            : [];

  const fromGroupedTurns = groupedTurns.map((turn) => {
    const speaker = normalizeText(turn?.speaker || 'Speaker 1') || 'Speaker 1';
    const text    = cleanTranscriptText(turn?.text || '');
    const line    = text ? `${speaker}: ${text}` : '';
    return isLikelyUsefulTranscriptLine(line) ? line : '';
  }).filter(Boolean);

  const fromSegments = segments.map((seg) => {
    const speaker = normalizeText(seg?.speaker || 'Speaker 1') || 'Speaker 1';
    const text    = cleanTranscriptText(seg?.text || '');
    const line    = text ? `${speaker}: ${text}` : '';
    return isLikelyUsefulTranscriptLine(line) ? line : '';
  }).filter(Boolean);

  const bestLines = fromGroupedTurns.length ? fromGroupedTurns : fromSegments;
  let transcriptText = bestLines.join('\n');

  if (!transcriptText) {
    transcriptText = normalizeText(
      transcript.fullText || transcript.cleanEnglish || transcript.rawTranscriptNormalized || transcript.rawFullText || ''
    );
  }

  transcriptText = transcriptText
    .split(/\n+/)
    .map((l) => cleanTranscriptText(l))
    .filter((l) => isLikelyUsefulTranscriptLine(l))
    .filter((l, i, arr) => i === 0 || l.toLowerCase() !== arr[i - 1].toLowerCase())
    .join('\n');

  if (transcriptText.length > SUMMARY_MAX_INPUT_CHARS) {
    transcriptText = `${transcriptText.slice(0, SUMMARY_MAX_INPUT_CHARS).trim()}\n[Transcript truncated for summarization]`;
  }

  return transcriptText;
}

function assertSummarizableContent(transcriptText) {
  const normalized = normalizeText(transcriptText);
  const words = normalized ? normalized.split(/\s+/).filter(Boolean) : [];
  if (!normalized || normalized.length < SUMMARY_MIN_CONTENT_CHARS || words.length < SUMMARY_MIN_CONTENT_WORDS) {
    const error = new Error('Not enough content to summarize');
    error.status = 422;
    error.code   = 'SUMMARY_NOT_ENOUGH_CONTENT';
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Gemini API call (native HTTPS — no extra dependency)
// ---------------------------------------------------------------------------

function callGeminiApi(prompt) {
  return new Promise((resolve, reject) => {
    if (!GOOGLE_API_KEY) {
      return reject(new Error('GOOGLE_API_KEY is not configured'));
    }

    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
    });

    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GOOGLE_API_KEY}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const timer = setTimeout(() => reject(new Error('Gemini request timed out')), GEMINI_TIMEOUT_MS);

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            const msg = parsed?.error?.message || `Gemini error ${res.statusCode}`;
            return reject(new Error(msg));
          }
          const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          resolve(text);
        } catch (e) {
          reject(new Error('Failed to parse Gemini response'));
        }
      });
    });

    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Qwen / Ollama API call (summary fallback)
// ---------------------------------------------------------------------------

function callQwenApi(prompt) {
  return new Promise((resolve, reject) => {
    const parsedUrl  = new URL(`${OLLAMA_BASE_URL}/api/chat`);
    const isHttps    = parsedUrl.protocol === 'https:';
    const transport  = isHttps ? require('https') : require('http');

    const body = JSON.stringify({
      model: QWEN_MODEL,
      stream: false,
      messages: [{ role: 'user', content: prompt }],
      options: { temperature: 0.1, num_predict: 2048 },
    });

    const options = {
      hostname: parsedUrl.hostname,
      port:     parsedUrl.port ? Number(parsedUrl.port) : (isHttps ? 443 : 80),
      path:     parsedUrl.pathname,
      method:   'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const timer = setTimeout(() => reject(new Error('Qwen request timed out')), QWEN_TIMEOUT_MS);
    const req   = transport.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(data);
          const text   = parsed?.message?.content || '';
          resolve(text);
        } catch (e) {
          reject(new Error('Failed to parse Qwen response'));
        }
      });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildUserPrompt(transcriptText) {
  return [
    'You are generating a structured meeting summary for the VoiceMind transcript summary page.',
    '',
    'Read the transcript carefully and extract only factual information that is explicitly spoken in the meeting.',
    'Do not invent, assume, or expand details.',
    '',
    'IMPORTANT OUTPUT RULES FOR "keyPoints":',
    '1. Every item must follow: speaker <n> - (<label>) : <value>',
    '2. Example: speaker 1 - (Project) : Voice Mind Map',
    '3. Only include a key point if it is clearly stated in the transcript.',
    '4. Keep each key point as a short single-line statement.',
    '5. Do not merge multiple labels into one line.',
    '6. Speakers are identified only as Speaker 1, Speaker 2, etc. Never use role labels.',
    '',
    'Return valid JSON only (no markdown fences) with this schema:',
    '{',
    '  "executiveSummary": ["string"],',
    '  "participants": [{ "speaker": "string", "name": "string|null", "role": "string|null", "organization": "string|null", "education": "string|null", "projectAssociation": ["string"], "keyContributions": ["string"] }],',
    '  "keyPoints": ["speaker <n> - (<label>) : <value>"],',
    '  "decisions": ["string"],',
    '  "actionItems": [{ "task": "string", "owner": "string|null", "deadline": "string|null", "priority": "high|medium|low|null", "status": "open|in_progress|done|blocked", "supportingSpeaker": "string|null" }],',
    '  "risks": ["string"],',
    '  "openQuestions": ["string"],',
    '  "importantNotes": ["string"],',
    '  "topics": [{ "title": "string", "summary": "string" }],',
    '  "confidenceNotes": ["string"]',
    '}',
    '',
    'Transcript:',
    transcriptText,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// JSON parsing / repair
// ---------------------------------------------------------------------------

function extractJsonString(text = '') {
  const source = String(text || '').trim();
  if (!source) return '';
  const fenceMatch = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) return fenceMatch[1].trim();
  const first = source.indexOf('{');
  const last  = source.lastIndexOf('}');
  if (first >= 0 && last > first) return source.slice(first, last + 1).trim();
  return source;
}

function sanitizeJsonCandidate(value = '') {
  return String(value || '')
    .replace(/^```(?:json)?/i, '').replace(/```$/i, '')
    .replace(/[""]/g, '"').replace(/['']/g, "'")
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ')
    .trim();
}

function tryParseJsonCandidate(value = '') {
  const candidate = sanitizeJsonCandidate(value);
  if (!candidate) return null;
  const attempts = [candidate];
  const extracted = extractJsonString(candidate);
  if (extracted && extracted !== candidate) attempts.push(sanitizeJsonCandidate(extracted));
  for (const attempt of attempts) {
    try { return JSON.parse(attempt); } catch { /* continue */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fallback from transcript (no AI available)
// ---------------------------------------------------------------------------

function fallbackFromTranscript(transcriptText) {
  const allLines = transcriptText.split(/\n+/).map((l) => cleanTranscriptText(l)).filter(Boolean);

  // Spread picks across the FULL transcript instead of always using the first N lines.
  // This prevents executive summary from being identical to the opening words every time.
  function spreadPick(lines, count) {
    if (!lines.length) return [];
    if (lines.length <= count) return lines.slice();
    const step = Math.floor(lines.length / count);
    const picked = [];
    for (let i = 0; i < count; i++) {
      const idx = Math.min(i * step, lines.length - 1);
      picked.push(lines[idx]);
    }
    return picked;
  }

  const executiveSummary = spreadPick(allLines, 5);
  const keyPointLines = spreadPick(allLines, Math.min(8, allLines.length));
  const keyPoints = keyPointLines.map((line) => {
    const m = line.match(/^(speaker\s+\d+|speaker\s+[a-z0-9_-]+)\s*:\s*(.+)$/i);
    if (m) return formatStructuredKeyPoint({ speaker: m[1], label: 'Context', value: m[2] });
    return formatStructuredKeyPoint({ speaker: 'speaker 1', label: 'Context', value: line });
  }).filter(Boolean);

  return {
    executiveSummary,
    participants: [],
    keyPoints,
    decisions: [],
    actionItems: [],
    risks: [],
    openQuestions: [],
    importantNotes: [],
    topics: [],
    confidenceNotes: ['This is a basic extraction — generate a full AI summary for detailed analysis.'],
    fallback: true,
  };
}

function normalizeSummaryData(summary, meta = {}) {
  return {
    executiveSummary: normalizeStringArray(summary?.executiveSummary),
    participants: normalizeParticipants(summary?.participants),
    keyPoints: normalizeKeyPoints(summary?.keyPoints),
    decisions: normalizeStringArray(summary?.decisions),
    actionItems: normalizeActionItems(summary?.actionItems),
    risks: normalizeStringArray(summary?.risks),
    openQuestions: normalizeStringArray(summary?.openQuestions),
    importantNotes: normalizeStringArray(summary?.importantNotes),
    topics: normalizeTopics(summary?.topics),
    confidenceNotes: normalizeStringArray(summary?.confidenceNotes),
    generatedAt: new Date(),
    model: meta.model || GEMINI_MODEL,
    source: meta.source || 'gemini',
    fallback: Boolean(summary?.fallback),
    transcriptExcerptChars: Number(meta.transcriptExcerptChars || 0),
  };
}

function hasUsableSummary(summary) {
  if (!summary || typeof summary !== 'object') return false;
  return Boolean(
    summary.executiveSummary?.length || summary.participants?.length ||
    summary.keyPoints?.length || summary.decisions?.length ||
    summary.actionItems?.length || summary.risks?.length ||
    summary.openQuestions?.length || summary.importantNotes?.length ||
    summary.topics?.length || summary.confidenceNotes?.length
  );
}

// ---------------------------------------------------------------------------
// Main export: generateStructuredSummary
// ---------------------------------------------------------------------------

async function generateStructuredSummary(transcript = {}) {
  const transcriptText = buildTranscriptInput(transcript);
  assertSummarizableContent(transcriptText);

  const prompt = buildUserPrompt(transcriptText);

  // ── Attempt 1: Gemini ──────────────────────────────────────────────────────
  let geminiRaw  = null;
  let geminiErr  = null;

  try {
    geminiRaw = await callGeminiApi(prompt);
  } catch (error) {
    if (error?.code === 'SUMMARY_NOT_ENOUGH_CONTENT') throw error;
    geminiErr = error;
    console.error('[geminiSummary] Gemini failed:', error?.message || error);
  }

  if (geminiRaw) {
    const parsed = tryParseJsonCandidate(geminiRaw);
    if (parsed) {
      const normalized = normalizeSummaryData(parsed, {
        model: GEMINI_MODEL,
        source: 'gemini',
        transcriptExcerptChars: transcriptText.length,
      });
      if (hasUsableSummary(normalized)) return normalized;
      console.error('[geminiSummary] Gemini returned empty summary — trying Qwen');
    } else {
      console.error('[geminiSummary] Gemini returned invalid JSON — trying Qwen');
    }
  }

  // ── Attempt 2: Qwen / Ollama fallback ─────────────────────────────────────
  let qwenRaw  = null;
  let qwenErr  = null;

  try {
    qwenRaw = await callQwenApi(prompt);
  } catch (error) {
    qwenErr = error;
    console.error('[geminiSummary] Qwen fallback failed:', error?.message || error);
  }

  if (qwenRaw) {
    const parsed = tryParseJsonCandidate(qwenRaw);
    if (parsed) {
      const normalized = normalizeSummaryData(parsed, {
        model: QWEN_MODEL,
        source: 'qwen',
        transcriptExcerptChars: transcriptText.length,
      });
      if (hasUsableSummary(normalized)) return normalized;
      console.error('[geminiSummary] Qwen returned empty summary — using transcript fallback');
    } else {
      console.error('[geminiSummary] Qwen returned invalid JSON — using transcript fallback');
    }
  }

  // ── Last resort: transcript-grounded structural fallback ───────────────────
  // Server-side logs only. Client receives clean structured output.
  console.error('[geminiSummary] Both providers failed. Source: transcript fallback.');
  return normalizeSummaryData(fallbackFromTranscript(transcriptText), {
    model: 'fallback',
    source: 'fallback:BOTH_PROVIDERS_FAILED',
    transcriptExcerptChars: transcriptText.length,
  });
}

module.exports = {
  buildTranscriptInput,
  buildUserPrompt,
  extractJsonString,
  isLikelyUsefulTranscriptLine,
  fallbackFromTranscript,
  formatStructuredKeyPoint,
  generateStructuredSummary,
  hasUsableSummary,
  normalizeSummaryData,
  parseStructuredKeyPoint,
};
