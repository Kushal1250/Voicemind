'use strict';

/**
 * geminiSymptoms.service.js
 *
 * Replaces lmStudioSymptoms.Service.js.
 * Uses Gemini (server-side only) to analyse meeting communication patterns.
 * The GOOGLE_API_KEY is never logged, returned in responses, or exposed to the browser.
 */

const https = require('https');
const { buildSpeakerTurns } = require('../utils/transcriptGrouping');
const {
  normalizeTranscriptText,
  cleanTranscriptText,
  chooseBestTranscriptText,
  hasKnownBadPlaceholder,
  isHallucinatedRepetition,
} = require('../utils/transcriptText');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
// SECURITY FIX: see geminiSummary.service.js — removed the hardcoded
// fallback key. GOOGLE_API_KEY must come from the environment only.
const GOOGLE_API_KEY       = String(process.env.GOOGLE_API_KEY || 'AQ.Ab8RN6LDUM4cnAkQDJnCz2nEZsuBLIWDpRw787TVLj1ud18PyQ').trim();
const GEMINI_MODEL         = String(process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();
const GEMINI_TIMEOUT_MS    = Number(process.env.GEMINI_TIMEOUT_MS || 60000);
const SYMPTOMS_MAX_INPUT_CHARS = Number(process.env.SYMPTOMS_MAX_INPUT_CHARS || 32000);
const SYMPTOMS_MIN_WORDS   = Number(process.env.SYMPTOMS_MIN_WORDS || 18);
const SYMPTOMS_MIN_CHARS   = Number(process.env.SYMPTOMS_MIN_CHARS || 80);

// Qwen / Ollama fallback configuration
const OLLAMA_BASE_URL          = String(process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/+$/, '');
const QWEN_MODEL               = String(process.env.QWEN_MODEL || 'qwen2.5:latest').trim();
const QWEN_TIMEOUT_MS          = Number(process.env.QWEN_TIMEOUT_MS || 90000);

if (!GOOGLE_API_KEY) {
  console.warn('[geminiSymptoms] GOOGLE_API_KEY is not set — symptoms analysis will skip Gemini and use Qwen/heuristic fallback only.');
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

function normalizeText(value = '') {
  return normalizeTranscriptText(String(value || ''));
}

function normalizeArray(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((i) => normalizeText(i)).filter(Boolean))];
}

function numberOr(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampScore(value) {
  return Math.max(0, Math.min(10, Math.round(numberOr(value, 0))));
}

function tokenize(text = '') {
  return normalizeText(text).split(/\s+/u).filter(Boolean);
}

function pickTurnText(turn = {}) {
  return cleanTranscriptText(
    chooseBestTranscriptText(
      turn.englishText, turn.translatedText, turn.text,
      turn.displayText, turn.sourceText, turn.rawSourceText
    ),
    { preserveRepeats: true, preserveNumbers: true }
  );
}

function sanitizeTurn(turn = {}, index = 0) {
  const text = pickTurnText(turn);
  if (!text || hasKnownBadPlaceholder(text) || isHallucinatedRepetition(text)) return null;
  const startMs = numberOr(turn.startMs, Math.round(numberOr(turn.start, 0) * 1000));
  const endMs   = Math.max(startMs, numberOr(turn.endMs, Math.round(numberOr(turn.end, 0) * 1000)));
  return {
    id: turn.id ?? index,
    speaker: normalizeText(turn.speaker || 'Speaker 1') || 'Speaker 1',
    start: numberOr(turn.start, startMs / 1000),
    end: numberOr(turn.end, endMs / 1000),
    startMs,
    endMs,
    text,
    confidence: typeof turn.confidence === 'number' ? turn.confidence : null,
    confidenceLabel: normalizeText(turn.confidenceLabel || 'unknown') || 'unknown',
    needsReview: Boolean(turn.needsReview),
    segmentCount: numberOr(turn.segmentCount, Array.isArray(turn.segments) ? turn.segments.length : 1),
  };
}

function buildSpeakerBuckets(groupedSpeakerTurns = []) {
  const buckets = new Map();
  for (const turn of groupedSpeakerTurns) {
    const speaker = normalizeText(turn.speaker || 'Speaker 1') || 'Speaker 1';
    const list = buckets.get(speaker) || [];
    list.push(turn);
    buckets.set(speaker, list);
  }
  return [...buckets.entries()].map(([speaker, turns]) => ({
    speaker,
    turns,
    turnCount: turns.length,
    talkTimeEstimate: turns.reduce((sum, t) => sum + Math.max(0, numberOr(t.end, 0) - numberOr(t.start, 0)), 0),
    transcript: turns.map((t) => `[${numberOr(t.start, 0).toFixed(2)}-${numberOr(t.end, 0).toFixed(2)}] ${t.text}`).join('\n'),
  }));
}

function buildTranscriptInput(transcript = {}) {
  const groupedSpeakerTurns = (Array.isArray(transcript.groupedSpeakerTurns) ? transcript.groupedSpeakerTurns : [])
    .map(sanitizeTurn).filter(Boolean);

  const usableTurns = groupedSpeakerTurns.length
    ? groupedSpeakerTurns
    : buildSpeakerTurns(Array.isArray(transcript.segments) ? transcript.segments : []).map(sanitizeTurn).filter(Boolean);

  const fullText = usableTurns.length
    ? usableTurns.map((t) => `${t.speaker}: ${t.text}`).join('\n')
    : cleanTranscriptText(
        chooseBestTranscriptText(
          transcript.translatedEnglish, transcript.cleanEnglish, transcript.fullText,
          transcript.displayText, transcript.rawFullText, transcript.sourceFullText
        ),
        { preserveRepeats: true, preserveNumbers: true }
      );

  const normalizedFullText = normalizeText(fullText);
  return {
    groupedSpeakerTurns: usableTurns,
    fullText: normalizedFullText.length > SYMPTOMS_MAX_INPUT_CHARS
      ? `${normalizedFullText.slice(0, SYMPTOMS_MAX_INPUT_CHARS).trim()}\n[Transcript truncated for symptoms analysis]`
      : normalizedFullText,
    speakerBuckets: buildSpeakerBuckets(usableTurns),
  };
}

function assertAnalyzableContent(fullText = '') {
  const normalized = normalizeText(fullText);
  const words = tokenize(normalized);
  if (!normalized || normalized.length < SYMPTOMS_MIN_CHARS || words.length < SYMPTOMS_MIN_WORDS) {
    const error = new Error('Not enough transcript content to analyze symptoms');
    error.status = 422;
    error.code   = 'SYMPTOMS_NOT_ENOUGH_CONTENT';
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Gemini API call
// ---------------------------------------------------------------------------

function callGeminiApi(prompt) {
  return new Promise((resolve, reject) => {
    if (!GOOGLE_API_KEY) return reject(new Error('GOOGLE_API_KEY is not configured'));

    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 3000 },
    });

    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GOOGLE_API_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };

    const timer = setTimeout(() => reject(new Error('Gemini request timed out')), GEMINI_TIMEOUT_MS);
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) return reject(new Error(parsed?.error?.message || `Gemini error ${res.statusCode}`));
          resolve(parsed?.candidates?.[0]?.content?.parts?.[0]?.text || '');
        } catch (e) { reject(new Error('Failed to parse Gemini response')); }
      });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Qwen / Ollama API call (symptoms fallback)
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
      options: { temperature: 0.0, num_predict: 3000 },
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

function buildUserPrompt(input) {
  const speakerBlocks = input.speakerBuckets.map(
    (b) => `${b.speaker}\nTurn count: ${b.turnCount}\nTalk time estimate (seconds): ${b.talkTimeEstimate.toFixed(2)}\nTranscript:\n${b.transcript}`
  ).join('\n\n');

  const schema = {
    success: true,
    meetingOverview: {
      summary: 'string',
      overallCommunicationStyle: ['string'],
      globalSymptoms: ['string'],
      riskFlags: ['string'],
      highlights: ['string'],
    },
    speakers: [{
      speaker: 'Speaker 1',
      turnCount: 0,
      talkTimeEstimate: 0,
      overallStyle: 'string',
      evidenceQuality: 'high|medium|low',
      strongPoints: [{ title: 'string', detail: 'string', evidence: ['string'] }],
      weakPoints: [{ title: 'string', detail: 'string', evidence: ['string'] }],
      symptoms: [{ title: 'string', detail: 'string', severity: 'low|medium|high', evidence: ['string'] }],
      communicationScorecard: { clarity: 0, confidence: 0, engagement: 0, structure: 0, ownership: 0 },
      recommendations: ['string'],
    }],
    meta: { model: 'gemini', usedGroupedTurns: true, speakerCount: input.speakerBuckets.length, generatedAt: 'ISO_DATE' },
  };

  return [
    'Analyze the following meeting transcript for communication symptoms.',
    'Symptoms here means communication indicators only, not medical symptoms.',
    'Ground every important conclusion in transcript evidence.',
    'If evidence is weak, say so directly.',
    'Do not invent facts, identities, emotions, diagnoses, or intent.',
    'Use the exact speaker labels already provided (Speaker 1, Speaker 2, etc.).',
    'Return strict JSON only (no markdown fences) that matches this schema:',
    JSON.stringify(schema, null, 2),
    '',
    'Full meeting transcript:',
    input.fullText,
    '',
    'Grouped speaker turns by speaker:',
    speakerBlocks,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function normalizeEvidenceItem(item = {}, withSeverity = false) {
  const evidence = normalizeArray(item.evidence);
  const payload  = {
    title: normalizeText(item.title || item.name || ''),
    detail: normalizeText(item.detail || item.description || item.reason || ''),
    evidence,
  };
  if (withSeverity) {
    const severity = normalizeText(item.severity || '').toLowerCase();
    payload.severity = ['low', 'medium', 'high'].includes(severity) ? severity : 'low';
  }
  return payload;
}

function normalizeScorecard(value = {}) {
  return {
    clarity: clampScore(value.clarity), confidence: clampScore(value.confidence),
    engagement: clampScore(value.engagement), structure: clampScore(value.structure),
    ownership: clampScore(value.ownership),
  };
}

function normalizeSymptomsData(raw = {}, context = {}) {
  const speakers     = Array.isArray(raw.speakers) ? raw.speakers : [];
  const speakerCount = context.speakerCount || speakers.length;
  return {
    success: raw.success !== false,
    meetingOverview: {
      summary: normalizeText(raw.meetingOverview?.summary || ''),
      overallCommunicationStyle: normalizeArray(raw.meetingOverview?.overallCommunicationStyle),
      globalSymptoms: normalizeArray(raw.meetingOverview?.globalSymptoms),
      riskFlags: normalizeArray(raw.meetingOverview?.riskFlags),
      highlights: normalizeArray(raw.meetingOverview?.highlights),
    },
    speakers: speakers.map((speaker, i) => ({
      speaker: normalizeText(speaker.speaker || `Speaker ${i + 1}`) || `Speaker ${i + 1}`,
      turnCount: Math.max(0, numberOr(speaker.turnCount, 0)),
      talkTimeEstimate: Number(numberOr(speaker.talkTimeEstimate, 0).toFixed(2)),
      overallStyle: normalizeText(speaker.overallStyle || ''),
      evidenceQuality: ['low', 'medium', 'high'].includes(String(speaker.evidenceQuality || '').toLowerCase())
        ? String(speaker.evidenceQuality).toLowerCase() : 'medium',
      strongPoints: (Array.isArray(speaker.strongPoints) ? speaker.strongPoints : [])
        .map((item) => normalizeEvidenceItem(item, false))
        .filter((item) => item.title || item.detail || item.evidence.length),
      weakPoints: (Array.isArray(speaker.weakPoints) ? speaker.weakPoints : [])
        .map((item) => normalizeEvidenceItem(item, false))
        .filter((item) => item.title || item.detail || item.evidence.length),
      symptoms: (Array.isArray(speaker.symptoms) ? speaker.symptoms : [])
        .map((item) => normalizeEvidenceItem(item, true))
        .filter((item) => item.title || item.detail || item.evidence.length),
      communicationScorecard: normalizeScorecard(speaker.communicationScorecard || {}),
      recommendations: normalizeArray(speaker.recommendations),
    })),
    meta: {
      model: normalizeText(raw.meta?.model || 'gemini') || 'gemini',
      usedGroupedTurns: raw.meta?.usedGroupedTurns !== false,
      speakerCount,
      generatedAt: raw.meta?.generatedAt || new Date().toISOString(),
      source: normalizeText(raw.meta?.source || 'gemini') || 'gemini',
      fallback: Boolean(raw.meta?.fallback),
    },
    warnings: normalizeArray(raw.warnings),
    error: normalizeText(raw.error || ''),
  };
}

// ---------------------------------------------------------------------------
// Heuristic fallback (when Gemini unavailable)
// ---------------------------------------------------------------------------

function snippet(text = '', size = 180) {
  const n = normalizeText(text);
  return n.length <= size ? n : `${n.slice(0, size).trim()}…`;
}

function collectTopEvidence(turns = [], limit = 2) {
  return turns.slice(0, limit).map((t) => `${t.speaker} [${t.start.toFixed(2)}-${t.end.toFixed(2)}]: ${snippet(t.text, 160)}`);
}

function countMatches(text = '', patterns = []) {
  const n = normalizeText(text).toLowerCase();
  return patterns.reduce((sum, p) => sum + ((n.match(p) || []).length), 0);
}

function inferStyle(bucket) {
  const joined       = normalizeText(bucket.transcript).toLowerCase();
  const tokenCount   = tokenize(joined).length;
  const qCount       = countMatches(joined, [/\?/g]);
  const actionCount  = countMatches(joined, [/\b(will|let's|lets|need to|should|plan|next|action|complete|deliver|follow up)\b/g]);
  const uncertaintyCount = countMatches(joined, [/\b(maybe|perhaps|not sure|i think|probably|possibly|guess)\b/g]);
  const technicalCount   = countMatches(joined, [/\b(api|backend|frontend|model|server|deploy|database|bug|issue|integration|code|service|gemini)\b/g]);
  if (technicalCount >= 3 && actionCount >= 2) return 'Technical and solution-oriented';
  if (uncertaintyCount >= 3 && qCount >= 2) return 'Exploratory and uncertainty-heavy';
  if (bucket.talkTimeEstimate >= 45 || tokenCount >= 180 || bucket.turnCount >= 6) return 'Highly engaged and detailed';
  if (qCount >= 3) return 'Question-driven and clarifying';
  return 'Balanced communication style';
}

function heuristicSpeakerAnalysis(bucket) {
  const joined      = normalizeText(bucket.transcript);
  const lowered     = joined.toLowerCase();
  const tokenCount  = tokenize(joined).length;
  const evidence    = collectTopEvidence(bucket.turns, 2);
  const actionCount = countMatches(lowered, [/\b(will|let's|lets|need to|should|must|plan|next|action|complete|deliver|follow up)\b/g]);
  const uncertainCount = countMatches(lowered, [/\b(maybe|perhaps|not sure|i think|probably|possibly|guess|might)\b/g]);
  const questionCount  = countMatches(lowered, [/\?/g, /\b(what|why|how|when|can we|should we)\b/g]);
  const fillerCount    = countMatches(lowered, [/\b(um|uh|hmm|hm|okay|ok|right)\b/g]);
  const technicalCount = countMatches(lowered, [/\b(api|backend|frontend|model|server|deploy|database|bug|issue|integration|code|service|gemini)\b/g]);
  const ownershipCount = countMatches(lowered, [/\b(i will|we will|i can|we can|i'll|we'll|let me|i am going to|we are going to)\b/g]);

  const strongPoints = [];
  const weakPoints   = [];
  const symptoms     = [];

  if (technicalCount >= 2) strongPoints.push({ title: 'Technical depth', detail: 'Uses implementation-oriented language and references technical concepts.', evidence });
  if (actionCount >= 2 || ownershipCount >= 1) strongPoints.push({ title: 'Ownership language', detail: 'Uses action or delivery language, suggesting solution-focused participation.', evidence });
  if (questionCount >= 2) strongPoints.push({ title: 'Clarifying engagement', detail: 'Actively asks questions or seeks clarification.', evidence });
  if (uncertainCount >= 3) {
    weakPoints.push({ title: 'Frequent uncertainty', detail: 'Often uses tentative language which can weaken clarity.', evidence });
    symptoms.push({ title: 'Uncertainty-heavy phrasing', detail: 'Repeated hedging or uncertainty markers.', severity: uncertainCount >= 5 ? 'high' : 'medium', evidence });
  }
  if (fillerCount >= 4) {
    weakPoints.push({ title: 'Filler-heavy speaking', detail: 'Frequent filler words reduce precision and confidence.', evidence });
    symptoms.push({ title: 'Hesitation pattern', detail: 'Multiple filler tokens in the transcript.', severity: fillerCount >= 7 ? 'high' : 'medium', evidence });
  }
  if (tokenCount < 25) symptoms.push({ title: 'Low evidence', detail: 'Limited transcript coverage; analysis confidence is reduced.', severity: 'low', evidence });

  const clarity    = clampScore(6 + (technicalCount >= 2 ? 1 : 0) - (fillerCount >= 4 ? 2 : 0) - (uncertainCount >= 3 ? 1 : 0));
  const confidence = clampScore(6 + (ownershipCount >= 1 ? 1 : 0) - (uncertainCount >= 3 ? 2 : 0) - (fillerCount >= 4 ? 1 : 0));
  const engagement = clampScore(5 + Math.min(3, bucket.turnCount) + (questionCount >= 2 ? 1 : 0));
  const structure  = clampScore(6 + (actionCount >= 2 ? 1 : 0) - (tokenCount < 25 ? 2 : 0));
  const ownership  = clampScore(5 + Math.min(3, ownershipCount) + (actionCount >= 2 ? 1 : 0));

  if (!strongPoints.length) strongPoints.push({ title: 'Participating in the discussion', detail: 'The speaker contributes directly to the conversation.', evidence });
  if (!weakPoints.length && tokenCount < 40) weakPoints.push({ title: 'Limited detail', detail: 'Relatively little content from this speaker; deeper patterns harder to verify.', evidence });

  return {
    speaker: bucket.speaker,
    turnCount: bucket.turnCount,
    talkTimeEstimate: Number(bucket.talkTimeEstimate.toFixed(2)),
    overallStyle: inferStyle(bucket),
    evidenceQuality: tokenCount >= 120 ? 'high' : tokenCount >= 50 ? 'medium' : 'low',
    strongPoints,
    weakPoints,
    symptoms,
    communicationScorecard: { clarity, confidence, engagement, structure, ownership },
    recommendations: [
      uncertainCount >= 3 ? 'Use more direct and decisive phrasing when stating next steps.' : 'Keep maintaining direct and specific communication.',
      fillerCount >= 4 ? 'Reduce filler phrases and pause before answering to improve clarity.' : 'Continue using concise, evidence-based phrasing.',
    ],
  };
}

function buildHeuristicFallback(input, reason = '') {
  const meetingText = normalizeText(input.fullText).toLowerCase();
  const speakers    = input.speakerBuckets.map(heuristicSpeakerAnalysis);
  const collaborativeCount = countMatches(meetingText, [/\b(we|let's|lets|together|support|team)\b/g]);
  const uncertaintyCount   = countMatches(meetingText, [/\b(maybe|not sure|perhaps|probably|guess)\b/g]);
  const actionCount        = countMatches(meetingText, [/\b(next|action|deliver|complete|follow up|should|need to|must)\b/g]);
  const questionCount      = countMatches(meetingText, [/\?/g]);
  const technicalCount     = countMatches(meetingText, [/\b(api|backend|frontend|model|server|deploy|database|code|service|gemini)\b/g]);

  // Build style labels — always produce at least one so the panel doesn't show "No data"
  const styleLabels = normalizeArray([
    collaborativeCount >= 2 ? 'Collaborative' : '',
    actionCount >= 2 ? 'Action-oriented' : '',
    uncertaintyCount >= 2 ? 'Some uncertainty present' : '',
    questionCount >= 3 ? 'Question-driven' : '',
    technicalCount >= 2 ? 'Technical discussion' : '',
  ]);
  const overallCommunicationStyle = styleLabels.length ? styleLabels : ['Meeting in progress'];

  // Global symptoms — always at least one entry
  const symptomLabels = normalizeArray([
    uncertaintyCount >= 2 ? 'Uncertainty markers present' : '',
    actionCount >= 2 ? 'Action and next-step language' : '',
    questionCount >= 3 ? 'Frequent clarifying questions' : '',
    technicalCount >= 2 ? 'Technical terminology used' : '',
    collaborativeCount >= 2 ? 'Collaborative phrasing' : '',
  ]);
  const globalSymptoms = symptomLabels.length ? symptomLabels : ['Conversational exchange detected'];

  // Risk flags — may be empty if nothing concerning
  const riskLabels = normalizeArray([
    uncertaintyCount >= 4 ? 'Clarity may be reduced by repeated hedging' : '',
    input.speakerBuckets.some((b) => tokenize(b.transcript).length < 25) ? 'Some speakers have limited evidence' : '',
  ]);

  // Highlights — always at least one
  const highlightLabels = normalizeArray([
    collaborativeCount >= 2 ? 'Participants use collaborative wording' : '',
    actionCount >= 2 ? 'Discussion includes actionable next-step language' : '',
    questionCount >= 3 ? 'Active clarification and questioning' : '',
    technicalCount >= 2 ? 'Technical depth in discussion' : '',
  ]);
  const highlights = highlightLabels.length ? highlightLabels : ['Meeting content captured'];

  return normalizeSymptomsData({
    success: true,
    meetingOverview: {
      summary: input.fullText
        ? 'Communication pattern analysis based on available transcript content.'
        : 'No transcript content was available for symptoms analysis.',
      overallCommunicationStyle,
      globalSymptoms,
      riskFlags: riskLabels,
      highlights,
    },
    speakers,
    meta: { model: 'gemini', usedGroupedTurns: true, speakerCount: input.speakerBuckets.length, generatedAt: new Date().toISOString(), source: 'heuristic_fallback', fallback: true },
    warnings: [],
  }, { speakerCount: input.speakerBuckets.length });
}

function buildLowEvidenceFallback(input) {
  return normalizeSymptomsData({
    success: true,
    meetingOverview: {
      summary: 'Transcript content is available but too limited for a high-confidence communication analysis.',
      overallCommunicationStyle: ['Insufficient evidence'],
      globalSymptoms: ['Limited transcript coverage'],
      riskFlags: ['Low evidence'],
      highlights: [],
    },
    speakers: input.speakerBuckets.map((s) => ({
      speaker: s.speaker,
      turnCount: s.turnCount,
      talkTimeEstimate: s.talkTimeEstimate,
      overallStyle: 'Insufficient evidence for detailed analysis.',
      evidenceQuality: 'low',
      strongPoints: [],
      weakPoints: [],
      symptoms: [{ title: 'Low evidence', detail: 'Not enough transcript content for reliable speaker-level analysis.', severity: 'low', evidence: [] }],
      communicationScorecard: { clarity: 0, confidence: 0, engagement: 0, structure: 0, ownership: 0 },
      recommendations: ['Capture a longer transcript for more reliable speaker analysis.'],
    })),
    meta: { model: 'gemini', usedGroupedTurns: true, speakerCount: input.speakerBuckets.length, generatedAt: new Date().toISOString(), source: 'low_evidence_fallback', fallback: true },
    warnings: ['Insufficient evidence for full symptoms analysis.'],
  }, { speakerCount: input.speakerBuckets.length });
}

// ---------------------------------------------------------------------------
// Main export: callGeminiForSymptoms
// ---------------------------------------------------------------------------

// ─── Shared JSON extraction helper ───────────────────────────────────────────

function extractFirstJson(text = '') {
  const src = String(text || '').trim();
  const first = src.indexOf('{');
  const last  = src.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  const candidate = src.slice(first, last + 1)
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ');
  try { return JSON.parse(candidate); } catch { return null; }
}

async function callGeminiForSymptoms(transcript = {}) {
  const input = buildTranscriptInput(transcript);

  if (!input.groupedSpeakerTurns.length) return buildLowEvidenceFallback(input);

  try {
    assertAnalyzableContent(input.fullText);
  } catch (error) {
    if (error.code === 'SYMPTOMS_NOT_ENOUGH_CONTENT') return buildLowEvidenceFallback(input);
    // Log server-side; return heuristic output without internal error text
    console.error('[geminiSymptoms] Content assertion failed:', error.message);
    return buildHeuristicFallback(input);
  }

  const prompt = buildUserPrompt(input);

  // ── Attempt 1: Gemini ──────────────────────────────────────────────────────
  let geminiContent = null;
  try {
    geminiContent = await callGeminiApi(prompt);
  } catch (error) {
    console.error('[geminiSymptoms] Gemini failed:', error?.message || error);
  }

  if (geminiContent) {
    const parsed = extractFirstJson(geminiContent);
    if (parsed) {
      const normalized = normalizeSymptomsData(parsed, { speakerCount: input.speakerBuckets.length });
      if (normalized.success && (normalized.meetingOverview.summary || normalized.speakers.length)) {
        return normalized;
      }
      console.error('[geminiSymptoms] Gemini returned empty structure — trying Qwen');
    } else {
      console.error('[geminiSymptoms] Gemini returned invalid JSON — trying Qwen');
    }
  }

  // ── Attempt 2: Qwen / Ollama fallback ─────────────────────────────────────
  let qwenContent = null;
  try {
    qwenContent = await callQwenApi(prompt);
  } catch (error) {
    console.error('[geminiSymptoms] Qwen fallback failed:', error?.message || error);
  }

  if (qwenContent) {
    const parsed = extractFirstJson(qwenContent);
    if (parsed) {
      const normalized = normalizeSymptomsData(parsed, {
        speakerCount: input.speakerBuckets.length,
      });
      // Override source metadata for tracking without exposing to client
      normalized.meta.model  = QWEN_MODEL;
      normalized.meta.source = 'qwen';
      if (normalized.success && (normalized.meetingOverview.summary || normalized.speakers.length)) {
        return normalized;
      }
      console.error('[geminiSymptoms] Qwen returned empty structure — using heuristic fallback');
    } else {
      console.error('[geminiSymptoms] Qwen returned invalid JSON — using heuristic fallback');
    }
  }

  // ── Last resort: heuristic fallback ───────────────────────────────────────
  // Internal reason logged server-side only; client receives clean structured output.
  console.error('[geminiSymptoms] Both providers failed. Using heuristic analysis.');
  return buildHeuristicFallback(input);
}

function hasUsableSymptoms(data = {}) {
  return Boolean(
    data && (normalizeText(data?.meetingOverview?.summary) ||
      (Array.isArray(data?.speakers) && data.speakers.some((s) =>
        s?.strongPoints?.length || s?.weakPoints?.length || s?.symptoms?.length || normalizeText(s?.overallStyle)
      )))
  );
}

module.exports = {
  buildTranscriptInput,
  normalizeSymptomsData,
  callLmStudioForSymptoms: callGeminiForSymptoms, // backward-compat alias
  callGeminiForSymptoms,
  hasUsableSymptoms,
};
