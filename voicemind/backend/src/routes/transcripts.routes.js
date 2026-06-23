const express = require('express');
const mongoose = require('mongoose');
const Transcript = require('../models/Transcript');
const { normalizeMeetingLanguage } = require('../utils/languageSupport');
const { buildSpeakerTurns } = require('../utils/transcriptGrouping');
const Meeting = require('../models/Meeting');
const { auth } = require('../middleware/auth');
const {
  generateStructuredSummary,
  hasUsableSummary,
  normalizeSummaryData,
} = require('../services/geminiSummary.service');
const {
  callGeminiForSymptoms,
  hasUsableSymptoms,
  normalizeSymptomsData,
} = require('../services/geminiSymptoms.service');

// Alias for backward-compat with any code that still calls callLmStudioForSymptoms
const callLmStudioForSymptoms = callGeminiForSymptoms;

const router = express.Router();

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeSummaryForResponse(transcript = {}) {
  const existingSummaryData = transcript?.summaryData && typeof transcript.summaryData === 'object'
    ? transcript.summaryData
    : {};

  const normalized = normalizeSummaryData(
    {
      executiveSummary: existingSummaryData.executiveSummary?.length
        ? existingSummaryData.executiveSummary
        : (transcript.summary ? [transcript.summary] : []),
      participants: existingSummaryData.participants,
      keyPoints: existingSummaryData.keyPoints?.length
        ? existingSummaryData.keyPoints
        : transcript.keyPoints,
      decisions: existingSummaryData.decisions,
      actionItems: existingSummaryData.actionItems?.length
        ? existingSummaryData.actionItems
        : transcript.actionItems,
      risks: existingSummaryData.risks,
      openQuestions: existingSummaryData.openQuestions,
      importantNotes: existingSummaryData.importantNotes,
      topics: existingSummaryData.topics,
      confidenceNotes: existingSummaryData.confidenceNotes,
      fallback: existingSummaryData.fallback,
    },
    {
      model: existingSummaryData.model || '',
      source: existingSummaryData.source || '',
      transcriptExcerptChars: existingSummaryData.transcriptExcerptChars || 0,
    }
  );

  if (existingSummaryData.generatedAt) {
    normalized.generatedAt = existingSummaryData.generatedAt;
  }

  return normalized;
}


function normalizeSymptomsForResponse(transcript = {}) {
  const existingSymptomsData = transcript?.symptomsData && typeof transcript.symptomsData === 'object'
    ? transcript.symptomsData
    : {};

  return normalizeSymptomsData(existingSymptomsData, {
    speakerCount: existingSymptomsData?.meta?.speakerCount || transcript?.speakerCount || 0,
  });
}

function hydrateTranscriptForResponse(transcript = {}, meeting = null) {
  const rawSegments = Array.isArray(transcript?.segments) ? transcript.segments : [];
  const groupedSpeakerTurns = Array.isArray(transcript?.groupedSpeakerTurns) && transcript.groupedSpeakerTurns.length
    ? transcript.groupedSpeakerTurns
    : buildSpeakerTurns(rawSegments);
  const summaryData = normalizeSummaryForResponse(transcript);
  const symptomsData = normalizeSymptomsForResponse(transcript);

  return {
    ...transcript,
    meetingId: transcript?.meetingId || meeting?.meetingId || '',
    conversation_text: transcript?.conversation_text || transcript?.fullText || '',
    normalizedTranscript: transcript?.normalizedTranscript || transcript?.rawTranscriptNormalized || '',
    rawTranscript: transcript?.rawTranscript || transcript?.rawFullText || '',
    language: normalizeMeetingLanguage(transcript?.language || meeting?.language),
    segments: rawSegments,
    groupedSpeakerTurns,
    summaryData,
    symptomsData,
    summary: normalizeText(transcript?.summary || summaryData.executiveSummary.join(' ')),
    keyPoints: Array.isArray(transcript?.keyPoints) && transcript.keyPoints.length
      ? transcript.keyPoints
      : summaryData.keyPoints,
    actionItems: Array.isArray(transcript?.actionItems) && transcript.actionItems.length
      ? transcript.actionItems
      : summaryData.actionItems,
    speakerCount: groupedSpeakerTurns.length
      ? new Set(groupedSpeakerTurns.map((turn) => turn.speaker)).size
      : new Set(rawSegments.map((segment) => segment.speaker)).size,
  };
}

function buildEmptyTranscript(meeting = null, meetingId = '') {
  return {
    meeting,
    transcript: {
      meetingId: meeting?.meetingId || meetingId,
      language: normalizeMeetingLanguage(meeting?.language),
      fullText: '',
      conversation_text: '',
      normalizedTranscript: '',
      rawTranscript: '',
      rawFullText: '',
      cleanEnglish: '',
      rawTranscriptNormalized: '',
      uncertainTerms: [],
      confidenceNotes: '',
      segments: [],
      groupedSpeakerTurns: [],
      diarization: { requested: false, eligible: false, skipped: true, applied: false, reason: 'not_available_yet', warnings: [] },
      diagnostics: {},
      processingStatus: meeting?.status === 'recording' ? 'processing' : 'pending',
      summary: '',
      keyPoints: [],
      actionItems: [],
      summaryData: normalizeSummaryData({}),
      symptomsData: normalizeSymptomsData({}, { speakerCount: 0 }),
      lastError: null,
      createdAt: meeting?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
}


function escapeHtml(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderHtmlList(items = [], emptyText = 'No confirmed items extracted for this section.') {
  if (!Array.isArray(items) || !items.length) {
    return `<p class="empty">${escapeHtml(emptyText)}</p>`;
  }

  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function renderSummaryPrintHtml({ title, meetingId, meetingDate, summary = {} }) {
  const participants = Array.isArray(summary.participants) ? summary.participants : [];
  const keyPoints = Array.isArray(summary.keyPoints) ? summary.keyPoints : [];
  const actionItems = Array.isArray(summary.actionItems) ? summary.actionItems : [];
  const topics = Array.isArray(summary.topics) ? summary.topics : [];

  const participantBlocks = participants.length
    ? participants.map((participant) => `
      <div class="card">
        <h3>${escapeHtml(participant.speaker || 'Speaker')}</h3>
        <p><strong>Name:</strong> ${escapeHtml(participant.name || '—')}</p>
        <p><strong>Role:</strong> ${escapeHtml(participant.role || '—')}</p>
        <p><strong>Organization:</strong> ${escapeHtml(participant.organization || '—')}</p>
        <p><strong>Education:</strong> ${escapeHtml(participant.education || '—')}</p>
        <p><strong>Project Association:</strong> ${escapeHtml((participant.projectAssociation || []).join(', ') || '—')}</p>
        <p><strong>Key Contributions:</strong> ${escapeHtml((participant.keyContributions || []).join(' • ') || '—')}</p>
      </div>
    `).join('')
    : '<p class="empty">No confirmed items extracted for this section.</p>';

  const keyPointsHtml = keyPoints.length
    ? keyPoints.map((item) => `
      <div class="card">
        <p>${escapeHtml(typeof item === 'string' ? item : item?.point || '')}</p>
      </div>
    `).join('')
    : '<p class="empty">No confirmed items extracted for this section.</p>';

  const actionItemsHtml = actionItems.length
    ? `
      <table>
        <thead>
          <tr>
            <th>Task</th>
            <th>Owner</th>
            <th>Deadline</th>
            <th>Priority</th>
            <th>Status</th>
            <th>Supporting Speaker</th>
          </tr>
        </thead>
        <tbody>
          ${actionItems.map((item) => `
            <tr>
              <td>${escapeHtml(item.task)}</td>
              <td>${escapeHtml(item.owner || '—')}</td>
              <td>${escapeHtml(item.deadline || '—')}</td>
              <td>${escapeHtml(item.priority || '—')}</td>
              <td>${escapeHtml(item.status || 'open')}</td>
              <td>${escapeHtml(item.supportingSpeaker || '—')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `
    : '<p class="empty">No confirmed items extracted for this section.</p>';

  const topicsHtml = topics.length
    ? topics.map((topic) => `
      <div class="card">
        <h3>${escapeHtml(topic.title || 'Topic')}</h3>
        <p>${escapeHtml(topic.summary || '')}</p>
      </div>
    `).join('')
    : '<p class="empty">No confirmed items extracted for this section.</p>';

  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>${escapeHtml(title)} - Meeting Summary</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 0; padding: 32px; color: #0f172a; background: #ffffff; }
          h1 { margin: 0 0 8px; font-size: 28px; }
          h2 { margin: 28px 0 12px; font-size: 20px; border-bottom: 1px solid #cbd5e1; padding-bottom: 8px; page-break-after: avoid; }
          h3 { margin: 0 0 8px; font-size: 16px; }
          p, li, td, th, span { font-size: 14px; line-height: 1.5; }
          ul { margin: 0; padding-left: 20px; }
          .muted { color: #475569; margin: 4px 0; }
          .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
          .card { border: 1px solid #dbeafe; background: #f8fafc; border-radius: 12px; padding: 14px; page-break-inside: avoid; }
          .empty { color: #64748b; }
          .badge { display: inline-block; border: 1px solid #bfdbfe; background: #eff6ff; border-radius: 999px; padding: 2px 10px; font-size: 12px; text-transform: capitalize; }
          .meta-row { display: flex; gap: 10px; align-items: center; margin-bottom: 8px; color: #334155; flex-wrap: wrap; }
          table { width: 100%; border-collapse: collapse; page-break-inside: avoid; }
          th, td { border: 1px solid #cbd5e1; padding: 10px; text-align: left; vertical-align: top; }
          thead { background: #f8fafc; }
          .section { page-break-inside: avoid; }
          @media print {
            body { padding: 20px; }
            .page-break { page-break-before: always; }
          }
        </style>
      </head>
      <body>
        <h1>Meeting Summary</h1>
        <p class="muted"><strong>Meeting:</strong> ${escapeHtml(title || 'Untitled meeting')}</p>
        <p class="muted"><strong>Meeting ID:</strong> ${escapeHtml(meetingId || '—')}</p>
        <p class="muted"><strong>Created:</strong> ${escapeHtml(meetingDate || '—')}</p>
        <p class="muted"><strong>Generated:</strong> ${escapeHtml(summary.generatedAt ? new Date(summary.generatedAt).toLocaleString() : '—')}</p>

        <section class="section">
          <h2>Executive Summary</h2>
          ${renderHtmlList(summary.executiveSummary)}
        </section>

        <section class="section">
          <h2>Participants</h2>
          <div class="grid">${participantBlocks}</div>
        </section>

        <section class="section">
          <h2>Key Points</h2>
          <div class="grid">${keyPointsHtml}</div>
        </section>

        <section class="section">
          <h2>Decisions Made</h2>
          ${renderHtmlList(summary.decisions)}
        </section>

        <section class="section">
          <h2>Action Items</h2>
          ${actionItemsHtml}
        </section>

        <section class="section">
          <h2>Risks / Blockers</h2>
          ${renderHtmlList(summary.risks)}
        </section>

        <section class="section">
          <h2>Open Questions</h2>
          ${renderHtmlList(summary.openQuestions)}
        </section>

        <section class="section">
          <h2>Important Notes</h2>
          ${renderHtmlList(summary.importantNotes)}
        </section>

        <section class="section">
          <h2>Topics Discussed</h2>
          <div class="grid">${topicsHtml}</div>
        </section>

        <section class="section">
          <h2>Confidence Notes</h2>
          ${renderHtmlList(summary.confidenceNotes)}
        </section>
      </body>
    </html>
  `;
}

async function syncMeetingSummary(meetingId, transcript) {
  await Meeting.findOneAndUpdate(
    { meetingId },
    {
      $set: {
        summary: transcript.summary || '',
        keyPoints: transcript.keyPoints || [],
        actionItems: transcript.actionItems || [],
        'stats.transcriptUpdatedAt': new Date(),
      },
    }
  );
}

router.get('/', auth, async (req, res) => {
  try {
    const {
      language,
      multilingual,
      status,
      processingStatus,
      meetingId,
      source,
      q = '',
      page = 1,
      limit = 20,
    } = req.query;

    const transcriptFilter = {};
    if (meetingId) transcriptFilter.meetingId = String(meetingId);
    if (language) transcriptFilter.languages = normalizeMeetingLanguage(language);
    if (status || processingStatus) transcriptFilter.processingStatus = String(processingStatus || status);
    if (multilingual === 'true') transcriptFilter.isMultilingual = true;
    if (multilingual === 'false') transcriptFilter.isMultilingual = false;
    if (q) transcriptFilter.$text = { $search: String(q) };

    const meetingFilter = {};
    if (meetingId) meetingFilter.meetingId = String(meetingId);
    if (source) meetingFilter.source = String(source);

    if (source) {
      const sourceMeetingIds = await Meeting.find(meetingFilter).distinct('meetingId');
      transcriptFilter.meetingId = transcriptFilter.meetingId
        ? transcriptFilter.meetingId
        : { $in: sourceMeetingIds };
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const skip = (pageNum - 1) * limitNum;

    const [items, total] = await Promise.all([
      Transcript.find(transcriptFilter)
        .sort(q ? { score: { $meta: 'textScore' }, updatedAt: -1 } : { updatedAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Transcript.countDocuments(transcriptFilter),
    ]);

    const meetingIds = items.map((item) => item.meetingId).filter(Boolean);
    const meetings = await Meeting.find({ meetingId: { $in: meetingIds } })
      .select('meetingId title source createdAt updatedAt stats status language')
      .lean();

    const meetingMap = new Map(meetings.map((meeting) => [meeting.meetingId, meeting]));

    const normalizedItems = items.map((item) => {
      const meeting = meetingMap.get(item.meetingId) || {};
      const hydratedTranscript = hydrateTranscriptForResponse(item, meeting);
      return {
        ...hydratedTranscript,
        title: meeting.title || 'Untitled meeting',
        source: meeting.source || '',
        createdAt: meeting.createdAt || item.createdAt || item.updatedAt,
        updatedAt: item.updatedAt || meeting.updatedAt,
        preview: normalizeText(
          hydratedTranscript.summary
          || hydratedTranscript.summaryData?.executiveSummary?.join(' ')
          || item.cleanEnglish
          || item.fullText
          || item.rawFullText
          || ''
        ).slice(0, 220),
        stats: {
          ...(meeting.stats || {}),
        },
      };
    });

    res.json({
      success: true,
      data: {
        items: normalizedItems,
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum) || 1,
      },
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'FETCH_TRANSCRIPTS_FAILED',
        message: error.message,
      },
    });
  }
});


async function resolveMeetingAndTranscript(identifier) {
  const raw = String(identifier || '').trim();
  const meetingQuery = [{ meetingId: raw }];
  if (mongoose.Types.ObjectId.isValid(raw)) {
    meetingQuery.push({ _id: raw });
  }
  const meeting = await Meeting.findOne({ $or: meetingQuery }).lean();
  const canonicalMeetingId = meeting?.meetingId || raw;
  const transcriptQuery = [{ meetingId: canonicalMeetingId }, { meetingId: raw }];
  if (mongoose.Types.ObjectId.isValid(raw)) {
    transcriptQuery.push({ _id: raw });
  }
  const transcript = await Transcript.findOne({ $or: transcriptQuery }).lean();
  return { meeting, transcript, meetingId: transcript?.meetingId || canonicalMeetingId };
}

router.get('/:meetingId', auth, async (req, res) => {
  try {
    const requestedId = String(req.params.meetingId || '');
    const { transcript, meeting, meetingId } = await resolveMeetingAndTranscript(requestedId);

    if (!transcript) {
      return res.json({
        success: true,
        data: buildEmptyTranscript(meeting, meetingId || requestedId),
      });
    }

    res.json({
      success: true,
      data: {
        meeting,
        transcript: hydrateTranscriptForResponse(transcript, meeting),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'FETCH_TRANSCRIPT_FAILED',
        message: error.message,
      },
    });
  }
});

router.get('/:meetingId/summary', auth, async (req, res) => {
  try {
    const meetingId = String(req.params.meetingId || '');
    const [transcript, meeting] = await Promise.all([
      Transcript.findOne({ meetingId }).lean(),
      Meeting.findOne({ meetingId }).lean(),
    ]);

    if (!transcript) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'TRANSCRIPT_NOT_FOUND',
          message: 'Transcript not found',
        },
      });
    }

    const hydratedTranscript = hydrateTranscriptForResponse(transcript, meeting);
    const summaryData = hydratedTranscript.summaryData;

    if (!hasUsableSummary(summaryData)) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'SUMMARY_NOT_FOUND',
          message: 'Summary not found for this transcript',
        },
      });
    }

    res.json({
      success: true,
      data: {
        meeting,
        meetingId,
        title: meeting?.title || 'Untitled meeting',
        processingStatus: hydratedTranscript.processingStatus,
        summary: summaryData,
        transcript: {
          meetingId: hydratedTranscript.meetingId,
          summary: hydratedTranscript.summary,
          keyPoints: hydratedTranscript.keyPoints,
          actionItems: hydratedTranscript.actionItems,
          updatedAt: hydratedTranscript.updatedAt,
        },
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'FETCH_SUMMARY_FAILED',
        message: error.message,
      },
    });
  }
});


router.get('/:meetingId/export/summary', auth, async (req, res) => {
  try {
    const meetingId = String(req.params.meetingId || '');
    const [transcript, meeting] = await Promise.all([
      Transcript.findOne({ meetingId }).lean(),
      Meeting.findOne({ meetingId }).lean(),
    ]);

    if (!transcript) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'TRANSCRIPT_NOT_FOUND',
          message: 'Transcript not found',
        },
      });
    }

    const hydratedTranscript = hydrateTranscriptForResponse(transcript, meeting);
    const summaryData = hydratedTranscript.summaryData;

    if (!hasUsableSummary(summaryData)) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'SUMMARY_NOT_FOUND',
          message: 'No summary available for export',
        },
      });
    }

    const html = renderSummaryPrintHtml({
      title: meeting?.title || 'Untitled meeting',
      meetingId,
      meetingDate: meeting?.createdAt ? new Date(meeting.createdAt).toLocaleString() : '',
      summary: summaryData,
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="${meetingId}-summary.html"`);
    res.send(html);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'EXPORT_SUMMARY_FAILED',
        message: error.message || 'Summary export failed',
      },
    });
  }
});

router.get('/:meetingId/plain-text', auth, async (req, res) => {
  try {
    const transcript = await Transcript.findOne({ meetingId: req.params.meetingId }).lean();
    if (!transcript) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'TRANSCRIPT_NOT_FOUND',
          message: 'Transcript not found',
        },
      });
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(transcript.cleanEnglish || transcript.fullText || transcript.rawFullText || '');
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'FETCH_TRANSCRIPT_TEXT_FAILED',
        message: error.message,
      },
    });
  }
});

router.get('/:meetingId/export/srt', auth, async (req, res) => {
  try {
    const transcript = await Transcript.findOne({ meetingId: req.params.meetingId }).lean();
    if (!transcript) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'TRANSCRIPT_NOT_FOUND',
          message: 'Transcript not found',
        },
      });
    }

    const turns = hydrateTranscriptForResponse(transcript).groupedSpeakerTurns;

    const formatTime = (seconds) => {
      const totalMs = Math.max(0, Math.round(Number(seconds || 0) * 1000));
      const hours = Math.floor(totalMs / 3600000);
      const minutes = Math.floor((totalMs % 3600000) / 60000);
      const secs = Math.floor((totalMs % 60000) / 1000);
      const ms = totalMs % 1000;
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
    };

    const lines = [];
    turns.forEach((turn, index) => {
      lines.push(String(index + 1));
      lines.push(`${formatTime(turn.start)} --> ${formatTime(turn.end)}`);
      lines.push(`${turn.speaker}: ${normalizeText(turn.text)}`);
      lines.push('');
    });

    res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.meetingId}.srt"`);
    res.send(lines.join('\n'));
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'EXPORT_SRT_FAILED',
        message: error.message,
      },
    });
  }
});

router.post('/:meetingId/generate-summary', auth, async (req, res) => {
  try {
    const meetingId = String(req.params.meetingId || '');
    const force = String(req.body?.force || req.query?.force || 'false').toLowerCase() === 'true';

    const [transcript, meeting] = await Promise.all([
      Transcript.findOne({ meetingId }),
      Meeting.findOne({ meetingId }).lean(),
    ]);

    if (!transcript) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'TRANSCRIPT_NOT_FOUND',
          message: 'Transcript not found',
        },
      });
    }

    const hydratedExisting = hydrateTranscriptForResponse(transcript.toObject(), meeting);
    if (!force && hasUsableSummary(hydratedExisting.summaryData)) {
      return res.json({
        success: true,
        data: {
          meeting,
          meetingId,
          title: meeting?.title || 'Untitled meeting',
          summary: hydratedExisting.summaryData,
          transcript: hydratedExisting,
          reused: true,
        },
      });
    }

    const summaryData = await generateStructuredSummary(hydratedExisting);

    transcript.summaryData = summaryData;
    transcript.summary = normalizeText(summaryData.executiveSummary.join(' '));
    transcript.keyPoints = summaryData.keyPoints.map((item) => (typeof item === 'string' ? item : item?.point)).filter(Boolean);
    transcript.actionItems = summaryData.actionItems;
    transcript.updatedAt = new Date();
    await transcript.save();
    await syncMeetingSummary(meetingId, transcript);

    const hydratedTranscript = hydrateTranscriptForResponse(transcript.toObject(), meeting);

    res.json({
      success: true,
      data: {
        meeting,
        meetingId,
        title: meeting?.title || 'Untitled meeting',
        summary: hydratedTranscript.summaryData,
        transcript: hydratedTranscript,
        reused: false,
      },
    });
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({
      success: false,
      error: {
        code: error.code || 'GENERATE_SUMMARY_FAILED',
        message: error.message || 'Failed to generate summary',
      },
    });
  }
});

router.patch('/:meetingId/summary', auth, async (req, res) => {
  try {
    const { summary = '', keyPoints = [], actionItems = [], summaryData = null } = req.body;

    const transcript = await Transcript.findOne({ meetingId: req.params.meetingId });
    if (!transcript) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'TRANSCRIPT_NOT_FOUND',
          message: 'Transcript not found',
        },
      });
    }

    const normalizedSummaryData = summaryData
      ? normalizeSummaryData(summaryData, {
        model: summaryData?.model,
        source: summaryData?.source || 'manual',
        transcriptExcerptChars: summaryData?.transcriptExcerptChars,
      })
      : normalizeSummaryData({
        executiveSummary: summary ? [summary] : transcript.summaryData?.executiveSummary,
        participants: transcript.summaryData?.participants,
        keyPoints,
        actionItems,
        decisions: transcript.summaryData?.decisions,
        risks: transcript.summaryData?.risks,
        openQuestions: transcript.summaryData?.openQuestions,
        importantNotes: transcript.summaryData?.importantNotes,
        topics: transcript.summaryData?.topics,
        confidenceNotes: transcript.summaryData?.confidenceNotes,
        fallback: transcript.summaryData?.fallback,
      }, {
        model: transcript.summaryData?.model,
        source: transcript.summaryData?.source || 'manual',
        transcriptExcerptChars: transcript.summaryData?.transcriptExcerptChars,
      });

    if (transcript.summaryData?.generatedAt && !normalizedSummaryData.generatedAt) {
      normalizedSummaryData.generatedAt = transcript.summaryData.generatedAt;
    }

    transcript.summaryData = normalizedSummaryData;
    transcript.summary = normalizeText(summary || normalizedSummaryData.executiveSummary.join(' '));
    transcript.keyPoints = normalizedSummaryData.keyPoints.map((item) => item.point);
    transcript.actionItems = normalizedSummaryData.actionItems;
    transcript.updatedAt = new Date();
    await transcript.save();
    await syncMeetingSummary(req.params.meetingId, transcript);

    res.json({
      success: true,
      data: hydrateTranscriptForResponse(transcript.toObject()),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'UPDATE_SUMMARY_FAILED',
        message: error.message,
      },
    });
  }
});


router.get('/:meetingId/symptoms', auth, async (req, res) => {
  try {
    const meetingId = String(req.params.meetingId || '').trim();
    const transcript = await Transcript.findOne({ meetingId }).lean();
    const meeting = await Meeting.findOne({ meetingId }).lean();

    if (!transcript && !meeting) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'TRANSCRIPT_NOT_FOUND',
          message: 'Transcript not found',
        },
      });
    }

    const hydratedTranscript = transcript
      ? hydrateTranscriptForResponse(transcript, meeting)
      : buildEmptyTranscript(meeting, meetingId).transcript;

    const symptomsData = normalizeSymptomsForResponse(hydratedTranscript);
    if (!hasUsableSymptoms(symptomsData)) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'SYMPTOMS_NOT_FOUND',
          message: 'Symptoms analysis not generated yet',
        },
      });
    }

    res.json({
      success: true,
      data: {
        meetingId,
        title: meeting?.title || hydratedTranscript?.title || 'Untitled meeting',
        processingStatus: hydratedTranscript.processingStatus || 'completed',
        symptoms: symptomsData,
        transcript: hydratedTranscript,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'FETCH_SYMPTOMS_FAILED',
        message: error.message || 'Failed to fetch symptoms analysis',
      },
    });
  }
});

router.post('/:meetingId/generate-symptoms', auth, async (req, res) => {
  try {
    const meetingId = String(req.params.meetingId || '').trim();
    const { force = false } = req.body || {};

    const transcript = await Transcript.findOne({ meetingId });
    const meeting = await Meeting.findOne({ meetingId }).lean();

    if (!transcript) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'TRANSCRIPT_NOT_FOUND',
          message: 'Transcript not found',
        },
      });
    }

    const hydratedTranscript = hydrateTranscriptForResponse(transcript.toObject(), meeting);

    if (!force && hasUsableSymptoms(hydratedTranscript.symptomsData)) {
      return res.json({
        success: true,
        data: {
          meetingId,
          title: meeting?.title || hydratedTranscript.title || 'Untitled meeting',
          processingStatus: hydratedTranscript.processingStatus || 'completed',
          symptoms: hydratedTranscript.symptomsData,
          transcript: hydratedTranscript,
          reused: true,
        },
      });
    }

    const symptomsData = await callLmStudioForSymptoms(hydratedTranscript);
    transcript.symptomsData = symptomsData;
    transcript.updatedAt = new Date();
    await transcript.save();

    const refreshedTranscript = hydrateTranscriptForResponse(transcript.toObject(), meeting);

    res.json({
      success: true,
      data: {
        meetingId,
        title: meeting?.title || refreshedTranscript.title || 'Untitled meeting',
        processingStatus: refreshedTranscript.processingStatus || 'completed',
        symptoms: refreshedTranscript.symptomsData,
        transcript: refreshedTranscript,
        reused: false,
      },
    });
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({
      success: false,
      error: {
        code: error.code || 'GENERATE_SYMPTOMS_FAILED',
        message: error.message || 'Failed to generate symptoms analysis',
      },
    });
  }
});

router.post('/:meetingId/rebuild-fulltext', auth, async (req, res) => {
  try {
    const transcript = await Transcript.findOne({ meetingId: req.params.meetingId });
    if (!transcript) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'TRANSCRIPT_NOT_FOUND',
          message: 'Transcript not found',
        },
      });
    }

    const segments = Array.isArray(transcript.segments) ? transcript.segments : [];
    const groupedSpeakerTurns = buildSpeakerTurns(segments);

    transcript.groupedSpeakerTurns = groupedSpeakerTurns;
    transcript.fullText = groupedSpeakerTurns.length
      ? groupedSpeakerTurns.map((turn) => normalizeText(turn.text)).filter(Boolean).join('\n')
      : segments.map((segment) => normalizeText(segment.text)).filter(Boolean).join('\n');
    transcript.updatedAt = new Date();
    await transcript.save();

    res.json({
      success: true,
      data: hydrateTranscriptForResponse(transcript.toObject()),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'REBUILD_TRANSCRIPT_FAILED',
        message: error.message,
      },
    });
  }
});

module.exports = router;
