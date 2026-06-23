/**
 * qa.routes.js  — VoiceMind v9.1
 * ================================
 * ROOT-CAUSE FIX (v9.1) — QA reliability & evidence accuracy:
 *   1. QA_TIMEOUT_MS raised 30s → 170s. The Python service's own provider
 *      chain (Gemini timeout + Qwen/Ollama fallback timeout) could already
 *      take ~150s worst case, so the old 30s Node-side timeout was firing
 *      first and silently downgrading every slow request (especially long
 *      "summarize in 2000 words" requests) to the dumb local fallback.
 *   2. Replaced every `segments.slice(0, 4)` / `slice(0, 5)` fallback with
 *      `pickRelevantSegments()` — a small Unicode-aware (EN/GU/HI) keyword
 *      overlap scorer — so even the emergency/offline fallback path picks
 *      question-relevant lines instead of always the opening lines.
 *   3. `questionLang` is now actually computed (script-based) and persisted;
 *      previously the schema/comment referenced it but nothing set it.
 *   4. `attachResponseMeta` now prefers the live computed `sources`/`mode`/
 *      `questionLang` over the persisted Mongoose document, so the response
 *      can't regress even if a schema field falls behind again.
 *   5. The real fix for "same 4 evidence lines for every question" lives in
 *      qa_service (retrieval.py: select_representative_evidence /
 *      select_top_scored) — this file's fallback scorer only covers the
 *      rare case where that service is unreachable or returns nothing.
 *
 * ROOT-CAUSE FIX (v8.0):
 *
 * The previous version used keyword tokenization (ASCII-only regex) to
 * select "relevant" transcript segments BEFORE sending them to the Python
 * QA service. For Gujarati/Hindi transcripts, the tokenizer produced an
 * empty score for every non-ASCII segment, so lines like
 *   "હું અદાણી યુનિવર્સિટીમાં છું"
 * were EXCLUDED from the context sent to Gemini. Gemini then correctly
 * said "I do not have enough information" — because it literally had no
 * evidence.
 *
 * v8.0 fix:
 *   1. ALWAYS send the FULL formatted transcript to the Python service.
 *      The Python service (main.py v8.0) does semantic embedding retrieval
 *      with intfloat/multilingual-e5-base, which handles GU/HI/EN natively.
 *   2. Remove the broken pre-filtering scoreText() / buildContextFromTranscript()
 *      for the main QA path. Keep it only for the rule-based fallback (which
 *      handles duration / speaker count / transcript existence queries locally).
 *   3. The validateServiceAnswer() threshold is relaxed — the Python service
 *      now returns well-grounded answers that contain non-ASCII characters
 *      which the old ASCII-only overlap check would reject.
 *   4. QAInteraction schema now stores `mode` and `questionLang` for debugging.
 */

const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const QAInteraction = require('../models/QAInteraction');
const Transcript = require('../models/Transcript');
const Meeting = require('../models/Meeting');
const { auth } = require('../middleware/auth');

const router = express.Router();

const QA_API_URL          = process.env.QA_API_URL          || 'http://127.0.0.1:8002';
// ROOT-CAUSE FIX: the Python QA service can legitimately take up to
// ~GEMINI_TIMEOUT (default 30s) + OLLAMA_TIMEOUT (default 120s) when Gemini
// fails/quota-errors and it falls back to local Qwen — call it 150s worst
// case, more for long "2000 word" generations. The old 30s default here
// meant Node gave up and fell back to a dumb local answer long before
// Python ever finished, which is the dominant cause of the "weak/repetitive
// summary" reports. Keep this comfortably above the Python-side worst case.
const QA_TIMEOUT_MS       = Number(process.env.QA_TIMEOUT_MS       || 170000);
const MAX_CONTEXT_CHARS   = Number(process.env.QA_CONTEXT_CHARS    || 32000); // generous
const GLOBAL_MEETING_LIMIT = Number(process.env.QA_GLOBAL_MEETING_LIMIT || 8);

// ─── Minimal stop-words (kept for local fallback only) ────────────────────────
const STOP_WORDS = new Set([
  'the','a','an','and','or','but','for','with','from','that','this','is','are',
  'was','were','will','would','should','could','can','may','might','have','has',
  'had','do','does','did','what','when','where','who','how','please','about',
  'tell','show','give','all','any','just','only','still','more','very',
]);

// ─── Local-fallback-only hint patterns ───────────────────────────────────────
const GREETING_HINTS = /^(hello|hi|hey|good morning|good afternoon|good evening)\??$/i;
const TRANSCRIPT_EXISTENCE_HINTS = /(is there any transcript|do we have transcript|is transcript available|any transcript|transcript available)/i;
const DURATION_HINTS = /(how long|duration|length|start time|end time|when did|when does|meeting time)/i;
const SPEAKER_COUNT_HINTS = /how many speakers/i;
const WORD_COUNT_HINTS = /how many words|word count/i;
const SHOW_TRANSCRIPT_HINTS = /show (the )?transcript|can you show transcript|repeat transcript|what does the transcript say/i;

// ─── Script ranges (mirrors qa_service/retrieval.py) ─────────────────────────
const GUJARATI_CHAR_RE   = /[\u0A80-\u0AFF]/;
const DEVANAGARI_CHAR_RE = /[\u0900-\u097F]/;
const GUJARATI_TOKEN_RE  = /[\u0A80-\u0AFF]+/g;
const DEVANAGARI_TOKEN_RE = /[\u0900-\u097F]+/g;
const LATIN_TOKEN_RE     = /[A-Za-z0-9']+/g;

/** Quick script-based language guess for the user's question text (not the transcript). */
function detectQuestionLang(question) {
  const text = String(question || '');
  if (GUJARATI_CHAR_RE.test(text)) return 'gu';
  if (DEVANAGARI_CHAR_RE.test(text)) return 'hi';
  return 'en';
}

function tokenizeForScoring(text) {
  const safe = String(text || '');
  const tokens = [];
  const gu = safe.match(GUJARATI_TOKEN_RE) || [];
  const dv = safe.match(DEVANAGARI_TOKEN_RE) || [];
  tokens.push(...gu, ...dv);
  const latin = (safe.toLowerCase().match(LATIN_TOKEN_RE) || [])
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
  tokens.push(...latin);
  return tokens;
}

/**
 * ROOT-CAUSE FIX (evidence): this is only used when the Python QA service is
 * unreachable or returns an unusable answer — the true emergency fallback.
 * The old code always used `segments.slice(0, 4)` here, which is why proof
 * cards looked identical no matter what was asked. This does a lightweight,
 * Unicode-aware (EN/GU/HI) keyword-overlap scoring pass instead, so even the
 * emergency fallback picks question-relevant lines.
 */
function pickRelevantSegments(question, segments, limit = 4) {
  if (!Array.isArray(segments) || !segments.length) return [];
  const qTokens = new Set(tokenizeForScoring(question));

  const scored = segments.map((seg) => {
    let score = 0;
    if (qTokens.size) {
      const segTokens = tokenizeForScoring(seg.text);
      for (const t of segTokens) {
        if (qTokens.has(t)) score += 1;
      }
    }
    return { seg, score };
  });

  const hasSignal = scored.some((s) => s.score > 0);
  const ranked = hasSignal
    ? scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score)
    : scored; // no keyword overlap at all — keep original order rather than guessing

  return ranked
    .slice(0, limit)
    .map((s) => s.seg)
    .sort((a, b) => Number(a.startMs || 0) - Number(b.startMs || 0));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const findMeetingByAnyId = async (id) => {
  if (mongoose.Types.ObjectId.isValid(id)) {
    return Meeting.findOne({ $or: [{ _id: id }, { meetingId: id }] });
  }
  return Meeting.findOne({ meetingId: id });
};

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sentenceCase(value) {
  const safe = normalizeText(value);
  if (!safe) return '';
  return safe.charAt(0).toUpperCase() + safe.slice(1);
}

function formatMs(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const hours   = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function dedupeSegments(segments = []) {
  const seen = new Set();
  return segments
    .map((segment, index) => {
      const text = normalizeText(segment?.text || segment?.rawText || '');
      if (!text) return null;
      const dedupeKey = `${text.toLowerCase()}::${Number(segment?.startMs || 0)}`;
      if (seen.has(dedupeKey)) return null;
      seen.add(dedupeKey);
      return {
        index,
        text,
        speaker: normalizeText(segment?.speaker || 'Speaker') || 'Speaker',
        startMs: Number(segment?.startMs || 0),
        endMs:   Number(segment?.endMs   || 0),
        confidence: Number(segment?.confidence || 0.7),
      };
    })
    .filter(Boolean);
}

function buildCleanTranscript(transcript) {
  const segments = dedupeSegments(Array.isArray(transcript?.segments) ? transcript.segments : []);
  const segmentText = segments.map((s) => s.text).join(' ');
  const fullText = normalizeText(segmentText || transcript?.fullText || '');
  const wordCount = fullText ? fullText.split(/\s+/).filter(Boolean).length : 0;
  const limitedContext = Boolean(fullText) && (wordCount <= 28 || segments.length <= 2);

  return {
    fullText,
    segments,
    wordCount,
    limitedContext,
    transcriptAvailable: Boolean(fullText),
    transcriptStatus: transcript?.processingStatus || 'pending',
  };
}

/**
 * buildFullTranscriptContext — v8.0
 *
 * Formats ALL segments as "[HH:MM:SS-HH:MM:SS] Speaker N: text" lines.
 * This is passed verbatim to the Python QA service which does its own
 * semantic retrieval. We do NOT pre-filter by keyword score here —
 * that was the bug.
 */
function buildFullTranscriptContext(segments) {
  return segments
    .map((seg) => {
      const start = formatMs(seg.startMs);
      const end   = formatMs(seg.endMs || seg.startMs);
      return `[${start}-${end}] ${seg.speaker}: ${seg.text}`;
    })
    .join('\n');
}

function buildSourcesFromSegments(segments = [], limit = 5) {
  return segments.slice(0, limit).map((segment) => ({
    startMs:     Number(segment.startMs || 0),
    endMs:       Number(segment.endMs   || 0),
    textSnippet: String(segment.text    || '').slice(0, 280),
    confidence:  Number(segment.confidence || 0.7),
    speaker:     segment.speaker || null,
  }));
}

// ─── Local fallback — handles computed/trivial questions without LLM ──────────
function buildLocalAnswer(question, clean) {
  const q = question.toLowerCase();
  const sources = buildSourcesFromSegments(clean.segments, 4);

  if (GREETING_HINTS.test(question.trim())) {
    return {
      answer: 'Hello! Ask me anything about this meeting transcript. I answer in your language — English, Gujarati, or Hindi.',
      confidence: 'high', sources, transcriptAvailable: true,
      limitedContext: false, status: 'fallback', processingTimeMs: 0,
    };
  }

  if (TRANSCRIPT_EXISTENCE_HINTS.test(q)) {
    return {
      answer: clean.transcriptAvailable
        ? 'Yes, transcript text is available for this meeting.'
        : 'No transcript is available yet.',
      confidence: 'high', sources, transcriptAvailable: clean.transcriptAvailable,
      limitedContext: clean.limitedContext, status: 'fallback', processingTimeMs: 0,
    };
  }

  if (SHOW_TRANSCRIPT_HINTS.test(q)) {
    return {
      answer: clean.fullText,
      confidence: 'high', sources, transcriptAvailable: true,
      limitedContext: clean.limitedContext, status: 'fallback', processingTimeMs: 0,
    };
  }

  // Duration / time queries — computed from timestamps
  if (DURATION_HINTS.test(q)) {
    const segs = clean.segments;
    if (segs && segs.length > 0) {
      const startMs = Math.min(...segs.map((s) => Number(s.startMs || 0)));
      const endMs   = Math.max(...segs.map((s) => Number(s.endMs   || s.startMs || 0)));
      const startFmt = formatMs(startMs);
      const endFmt   = formatMs(endMs);
      const totalSecs = Math.max(0, Math.floor((endMs - startMs) / 1000));
      const mins = Math.floor(totalSecs / 60);
      const secs = totalSecs % 60;

      if (/start time|when did.*start/i.test(q)) {
        return { answer: `The transcript starts at ${startFmt}.`, confidence: 'high', sources, transcriptAvailable: true, limitedContext: clean.limitedContext, status: 'success', processingTimeMs: 0 };
      }
      if (/end time|when did.*end/i.test(q)) {
        return { answer: `The transcript ends at ${endFmt}.`, confidence: 'high', sources, transcriptAvailable: true, limitedContext: clean.limitedContext, status: 'success', processingTimeMs: 0 };
      }
      const durationStr = secs > 0
        ? `${mins} minute${mins !== 1 ? 's' : ''} and ${secs} second${secs !== 1 ? 's' : ''}`
        : `${mins} minute${mins !== 1 ? 's' : ''}`;
      return { answer: `The transcript covers approximately ${durationStr} (from ${startFmt} to ${endFmt}).`, confidence: 'high', sources, transcriptAvailable: true, limitedContext: clean.limitedContext, status: 'success', processingTimeMs: 0 };
    }
    return null;
  }

  if (SPEAKER_COUNT_HINTS.test(q)) {
    const labels = [...new Set(clean.segments.map((s) => String(s.speaker || '').toLowerCase()).filter(Boolean))];
    return { answer: `The transcript contains ${labels.length} speaker label${labels.length === 1 ? '' : 's'}.`, confidence: 'medium', sources, transcriptAvailable: true, limitedContext: clean.limitedContext, status: 'fallback', processingTimeMs: 0 };
  }

  if (WORD_COUNT_HINTS.test(q)) {
    return { answer: `The current transcript has approximately ${clean.wordCount} words.`, confidence: 'medium', sources, transcriptAvailable: true, limitedContext: clean.limitedContext, status: 'fallback', processingTimeMs: 0 };
  }

  return null; // Not handled locally — delegate to Python QA service
}

// ─── Call Python QA service ───────────────────────────────────────────────────
async function askQaService({ question, context, meetingId, sources }) {
  const response = await axios.post(
    `${QA_API_URL}/qa`,
    {
      question,
      context,
      meetingId,
      sources,
      systemPrompt: null, // Let the Python service use its own calibrated prompt
    },
    { timeout: QA_TIMEOUT_MS }
  );

  return {
    answer:          normalizeText(response.data?.answer),
    sources:         Array.isArray(response.data?.sources) ? response.data.sources : [],
    processingTimeMs: Math.round(Number(response.data?.processingTime || 0) * 1000),
    confidence:      response.data?.confidence || 'medium',
    mode:            response.data?.mode       || 'gemini',
  };
}

/**
 * validateServiceAnswer — v8.0 (relaxed)
 *
 * The old 20% token-overlap check rejected correct Gujarati/Hindi answers
 * because none of the answer tokens (Unicode) appeared in the ASCII corpus.
 * v8.0: accept any non-empty answer that isn't a weak refusal.
 * We rely on the Python service's own confidence scoring instead.
 */
function validateServiceAnswer(answer) {
  if (!answer) return false;
  const lower = answer.toLowerCase();
  if (/(not enough information|transcript does not contain|i cannot identify|no information available)/i.test(answer)) {
    return false;
  }
  // Accept all non-empty, non-refusal answers
  return lower.length > 5;
}

async function saveInteraction({ meetingId, userId, question, answer, sources, status, processingTimeMs, confidence, limitedContext, transcriptAvailable, mode, questionLang }) {
  return QAInteraction.create({
    meetingId, userId, question, answer, sources, status, processingTimeMs,
    confidence, limitedContext, transcriptAvailable, mode, questionLang,
  });
}

function attachResponseMeta(interaction, extra = {}) {
  return {
    ...interaction.toObject(),
    // Prefer the freshly computed sources (full speaker/text detail) over
    // the persisted document — kept in sync once the QAInteraction schema
    // carries every source field, but this avoids ever regressing if the
    // schema falls behind again.
    sources: Array.isArray(extra.sources) && extra.sources.length ? extra.sources : interaction.sources,
    confidence: extra.confidence || interaction.confidence || 'medium',
    mode: extra.mode || interaction.mode || null,
    questionLang: extra.questionLang || interaction.questionLang || 'en',
    limitedContext: typeof extra.limitedContext === 'boolean' ? extra.limitedContext : interaction.limitedContext,
    transcriptAvailable: typeof extra.transcriptAvailable === 'boolean' ? extra.transcriptAvailable : interaction.transcriptAvailable,
  };
}

// ─── POST /meetings/:id/qa ────────────────────────────────────────────────────
router.post('/meetings/:id/qa', auth, async (req, res, next) => {
  try {
    const question = String(req.body.question || '').trim();
    if (!question) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Question is required' } });
    }
    const questionLang = detectQuestionLang(question);

    const meeting = await findMeetingByAnyId(req.params.id);
    if (!meeting) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Meeting not found' } });
    }

    const transcript = await Transcript.findOne({ meetingId: meeting.meetingId }).lean();
    const clean = buildCleanTranscript(transcript);

    if (!clean.transcriptAvailable) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'TRANSCRIPT_EMPTY',
          message: clean.transcriptStatus === 'processing'
            ? 'Transcript is still being processed.'
            : 'Transcript is not available yet for this meeting.',
        },
      });
    }

    // ── Step 1: Try local computation for trivial queries ────────────────────
    const localAnswer = buildLocalAnswer(question, clean);
    if (localAnswer) {
      const interaction = await saveInteraction({
        meetingId: meeting.meetingId, userId: req.user._id,
        question, answer: localAnswer.answer, sources: localAnswer.sources,
        status: localAnswer.status, processingTimeMs: 0,
        confidence: localAnswer.confidence, limitedContext: localAnswer.limitedContext,
        transcriptAvailable: localAnswer.transcriptAvailable, mode: 'local', questionLang,
      });
      return res.json({ success: true, data: attachResponseMeta(interaction, { ...localAnswer, questionLang }) });
    }

    // ── Step 2: Build FULL context and call Python QA service ────────────────
    //
    // CRITICAL v8.0: We send ALL segments formatted with timestamps and speaker
    // labels. The Python service does semantic retrieval — we must NOT pre-filter
    // here because keyword scoring cannot handle Gujarati/Hindi text.
    const fullContext = buildFullTranscriptContext(clean.segments).slice(0, MAX_CONTEXT_CHARS);
    // ROOT-CAUSE FIX: was `clean.segments.slice(0, 5)` — always the literal
    // opening lines. Used as a default-sources payload and as the fallback if
    // Python returns no sources, so it still needs to be question-relevant.
    const firstSources = buildSourcesFromSegments(pickRelevantSegments(question, clean.segments, 5));

    let qaResult;
    try {
      const serviceResult = await askQaService({
        question,
        context: fullContext,
        meetingId: meeting.meetingId,
        sources: firstSources,
      });

      if (!validateServiceAnswer(serviceResult.answer)) {
        // Service returned a weak refusal — use the best question-relevant
        // segments as best-effort (not just the first 4 in the transcript).
        const topSegs = pickRelevantSegments(question, clean.segments, 4);
        qaResult = {
          answer: topSegs.map((s) => sentenceCase(s.text)).join(' '),
          sources: buildSourcesFromSegments(topSegs),
          processingTimeMs: serviceResult.processingTimeMs,
          confidence: 'low',
          limitedContext: clean.limitedContext,
          transcriptAvailable: true,
          status: 'fallback',
          mode: 'fallback_rule_based',
        };
      } else {
        qaResult = {
          answer: serviceResult.answer,
          sources: serviceResult.sources.length ? serviceResult.sources : firstSources,
          processingTimeMs: serviceResult.processingTimeMs,
          confidence: serviceResult.confidence || (clean.limitedContext ? 'medium' : 'high'),
          limitedContext: clean.limitedContext,
          transcriptAvailable: true,
          status: /enough information in the transcript/i.test(serviceResult.answer) ? 'fallback' : 'success',
          mode: serviceResult.mode || 'gemini',
        };
      }
    } catch (serviceError) {
      // Service unreachable (or timed out) — fall back to question-relevant
      // segments rather than always the first 4 lines of the transcript.
      const topSegs = pickRelevantSegments(question, clean.segments, 4);
      qaResult = {
        answer: topSegs.length
          ? topSegs.map((s) => sentenceCase(s.text)).join(' ')
          : 'Unable to process — QA service is not reachable.',
        sources: buildSourcesFromSegments(topSegs),
        processingTimeMs: 0,
        confidence: 'low',
        limitedContext: clean.limitedContext,
        transcriptAvailable: true,
        status: 'fallback',
        mode: 'fallback_rule_based',
      };
    }

    const interaction = await saveInteraction({
      meetingId: meeting.meetingId, userId: req.user._id,
      question, answer: qaResult.answer, sources: qaResult.sources,
      status: qaResult.status || 'success', processingTimeMs: qaResult.processingTimeMs || 0,
      confidence: qaResult.confidence || 'medium', limitedContext: qaResult.limitedContext,
      transcriptAvailable: qaResult.transcriptAvailable, mode: qaResult.mode, questionLang,
    });

    return res.json({ success: true, data: attachResponseMeta(interaction, { ...qaResult, questionLang }) });

  } catch (error) {
    return next(error);
  }
});

// ─── GET /meetings/:id/qa ─────────────────────────────────────────────────────
router.get('/meetings/:id/qa', auth, async (req, res, next) => {
  try {
    const meeting = await findMeetingByAnyId(req.params.id);
    if (!meeting) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Meeting not found' } });
    }
    const items = await QAInteraction.find({ meetingId: meeting.meetingId })
      .sort({ createdAt: 1 }).lean();
    return res.json({ success: true, data: { meetingId: meeting.meetingId, items } });
  } catch (error) {
    return next(error);
  }
});

// ─── DELETE /meetings/:id/qa ─── clear ALL QA for a meeting ─────────────────
router.delete('/meetings/:id/qa', auth, async (req, res, next) => {
  try {
    const meeting = await findMeetingByAnyId(req.params.id);
    if (!meeting) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Meeting not found' } });
    }
    const result = await QAInteraction.deleteMany({ meetingId: meeting.meetingId });
    return res.json({ success: true, data: { deleted: result.deletedCount, meetingId: meeting.meetingId } });
  } catch (error) {
    return next(error);
  }
});

// ─── DELETE /qa/interactions/:interactionId ─── delete ONE QA item ───────────
router.delete('/qa/interactions/:interactionId', auth, async (req, res, next) => {
  try {
    const { interactionId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(interactionId)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid interaction ID' } });
    }
    const interaction = await QAInteraction.findOneAndDelete({
      _id: interactionId,
      userId: req.user._id,
    });
    if (!interaction) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'QA interaction not found or not owned by you' } });
    }
    return res.json({ success: true, data: { deleted: 1, interactionId } });
  } catch (error) {
    return next(error);
  }
});

// ─── GET /qa/global ───────────────────────────────────────────────────────────
router.get('/qa/global', auth, async (req, res, next) => {
  try {
    const items = await QAInteraction.find({ userId: req.user._id })
      .sort({ createdAt: 1 }).limit(100).lean();
    return res.json({ success: true, data: { items } });
  } catch (error) {
    return next(error);
  }
});

// ─── POST /qa/global ──────────────────────────────────────────────────────────
router.post('/qa/global', auth, async (req, res, next) => {
  try {
    const question = String(req.body.question || '').trim();
    if (!question) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Question is required' } });
    }
    const questionLang = detectQuestionLang(question);

    const meetings = await Meeting.find({ createdBy: req.user._id })
      .sort({ createdAt: -1 }).limit(GLOBAL_MEETING_LIMIT).lean();
    const meetingIds = meetings.map((m) => m.meetingId).filter(Boolean);

    const transcripts = await Transcript.find({
      meetingId: { $in: meetingIds },
      processingStatus: { $in: ['pending', 'processing', 'partial', 'completed'] },
    }).lean();

    const transcriptBlocks = transcripts
      .map((transcript) => {
        const clean = buildCleanTranscript(transcript);
        if (!clean.transcriptAvailable) return null;
        const meeting = meetings.find((m) => m.meetingId === transcript.meetingId);
        const title   = meeting?.title || transcript.meetingId;
        // Send full context per meeting — no keyword pre-filter
        const context = `Meeting: ${title}\n${buildFullTranscriptContext(clean.segments)}`;
        return {
          meetingId: transcript.meetingId,
          title,
          context,
          sources: buildSourcesFromSegments(clean.segments, 5).map((s) => ({ ...s, meetingId: transcript.meetingId })),
          limitedContext: clean.limitedContext,
          wordCount: clean.wordCount,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.wordCount - a.wordCount)
      .slice(0, GLOBAL_MEETING_LIMIT);

    if (!transcriptBlocks.length) {
      return res.status(400).json({ success: false, error: { code: 'TRANSCRIPT_EMPTY', message: 'No completed or partial meeting transcripts are available yet.' } });
    }

    const mergedContext  = transcriptBlocks.map((t) => t.context).join('\n\n---\n\n').slice(0, MAX_CONTEXT_CHARS);
    const mergedSources  = transcriptBlocks.flatMap((t) => t.sources).slice(0, 6);
    const limitedContext = transcriptBlocks.every((t) => t.limitedContext);

    let qaResult;
    try {
      const serviceResult = await askQaService({ question, context: mergedContext, meetingId: null, sources: mergedSources });
      if (!validateServiceAnswer(serviceResult.answer)) {
        qaResult = { answer: mergedSources.map((s) => s.textSnippet).join(' ') || 'No grounded answer found.', confidence: 'low', sources: mergedSources, transcriptAvailable: true, limitedContext, status: 'fallback', mode: 'fallback_rule_based', processingTimeMs: 0 };
      } else {
        qaResult = { answer: serviceResult.answer, sources: serviceResult.sources.length ? serviceResult.sources : mergedSources, processingTimeMs: serviceResult.processingTimeMs, confidence: serviceResult.confidence || (limitedContext ? 'medium' : 'high'), limitedContext, transcriptAvailable: true, status: 'success', mode: serviceResult.mode || 'gemini' };
      }
    } catch {
      qaResult = { answer: mergedSources.map((s) => s.textSnippet).join(' ') || 'QA service unreachable.', confidence: 'low', sources: mergedSources, transcriptAvailable: true, limitedContext, status: 'fallback', mode: 'fallback_rule_based', processingTimeMs: 0 };
    }

    const interaction = await saveInteraction({
      meetingId: null, userId: req.user._id,
      question, answer: qaResult.answer, sources: qaResult.sources,
      status: qaResult.status || 'success', processingTimeMs: qaResult.processingTimeMs || 0,
      confidence: qaResult.confidence || 'medium', limitedContext: qaResult.limitedContext,
      transcriptAvailable: qaResult.transcriptAvailable, mode: qaResult.mode, questionLang,
    });

    return res.json({ success: true, data: attachResponseMeta(interaction, { ...qaResult, questionLang }) });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
