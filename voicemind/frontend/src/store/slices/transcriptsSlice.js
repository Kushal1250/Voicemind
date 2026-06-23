import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import api, { handleApiError, silentRequestConfig } from '../../services/api';
import { selectDisplayTranscript, chooseBestTranscriptText } from '../../utils/transcriptTurns';

const emptySummary = {
  executiveSummary: [],
  participants: [],
  keyPoints: [],
  decisions: [],
  actionItems: [],
  risks: [],
  openQuestions: [],
  importantNotes: [],
  topics: [],
  confidenceNotes: [],
  generatedAt: null,
  model: '',
  source: '',
  fallback: false,
  transcriptExcerptChars: 0,
};


const emptySymptoms = {
  success: false,
  meetingOverview: {
    summary: '',
    overallCommunicationStyle: [],
    globalSymptoms: [],
    riskFlags: [],
    highlights: [],
  },
  speakers: [],
  meta: {
    model: 'lm_studio',
    usedGroupedTurns: true,
    speakerCount: 0,
    generatedAt: null,
    source: '',
    fallback: false,
  },
  warnings: [],
  error: '',
};

const initialState = {
  items: [],
  currentTranscript: null,
  currentSummary: null,
  currentSymptoms: null,
  loading: false,
  summaryLoading: false,
  symptomsLoading: false,
  error: null,
  summaryError: null,
  symptomsError: null,
  filters: {
    deviceId: '',
    language: '',
    status: '',
    from: '',
    to: '',
    search: '',
  },
  pagination: {
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 0,
  },
};

const numberOr = (value, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const normalizeStringArray = (value) => (
  Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean)
    : []
);

const normalizeParticipant = (item = {}, index = 0) => ({
  speaker: String(item?.speaker || `Speaker ${index + 1}`).trim(),
  name: item?.name ? String(item.name).trim() : null,
  role: item?.role ? String(item.role).trim() : null,
  organization: item?.organization ? String(item.organization).trim() : null,
  education: item?.education ? String(item.education).trim() : null,
  projectAssociation: normalizeStringArray(item?.projectAssociation),
  keyContributions: normalizeStringArray(item?.keyContributions),
});

const parseStructuredKeyPoint = (value = '') => {
  const raw = String(value || '').trim();
  if (!raw) {
    return {
      raw: '',
      point: '',
      value: '',
      speaker: null,
      label: null,
      type: 'other',
      displayText: '',
    };
  }

  const match = raw.match(/^(speaker\s+\d+)\s*-\s*\(([^)]+)\)\s*:\s*(.+)$/i);
  if (!match) {
    return {
      raw,
      point: raw,
      value: raw,
      speaker: null,
      label: null,
      type: inferKeyPointType(raw),
      displayText: raw,
    };
  }

  const [, speaker, label, parsedValue] = match;
  return {
    raw,
    point: String(parsedValue || '').trim(),
    value: String(parsedValue || '').trim(),
    speaker: String(speaker || '').trim(),
    label: String(label || '').trim(),
    type: inferKeyPointType(label),
    displayText: raw,
  };
};

const normalizeKeyPoint = (item = {}) => {
  if (typeof item === 'string') {
    return parseStructuredKeyPoint(item);
  }

  const speaker = item?.speaker ? String(item.speaker).trim() : null;
  const point = String(item?.point || item?.value || '').trim();
  const label = item?.label ? String(item.label).trim() : null;
  const type = item?.type ? String(item.type).trim().toLowerCase() : inferKeyPointType(label || point);
  const displayText = speaker && label && point
    ? `${speaker} - (${label}) : ${point}`
    : point;

  return {
    raw: displayText,
    point,
    value: point,
    speaker,
    label,
    type,
    displayText,
  };
};

const normalizeActionItem = (item = {}) => ({
  task: String(item?.task || '').trim(),
  owner: item?.owner ? String(item.owner).trim() : null,
  deadline: item?.deadline ? String(item.deadline).trim() : null,
  priority: item?.priority ? String(item.priority).trim().toLowerCase() : null,
  status: item?.status ? String(item.status).trim().toLowerCase() : 'open',
  supportingSpeaker: item?.supportingSpeaker ? String(item.supportingSpeaker).trim() : null,
});

const normalizeTopic = (item = {}) => ({
  title: String(item?.title || '').trim(),
  summary: String(item?.summary || '').trim(),
});

const inferKeyPointType = (point = '') => {
  const normalized = String(point || '').trim().toLowerCase();

  if (!normalized) return 'other';
  if (normalized === 'project' || /^(project|product)\s*:/.test(normalized)) return 'project';
  if (['developer', 'role', 'name', 'speaker', 'participant', 'owner'].includes(normalized) || /^(developer|name|speaker|participant|owner)\s*:/.test(normalized)) return 'role';
  if (['company', 'organization', 'client', 'context'].includes(normalized) || /^(company|organization|client)\s*:/.test(normalized)) return 'context';
  if (normalized === 'language' || /^(language|translation|gujarati|hindi|english)\b/.test(normalized)) return 'language';
  if (/^(deadline|timeline|plan|planning|next step)\b/.test(normalized)) return 'planning';
  if (/^(technical|api|backend|frontend|integration|bug|issue)\b/.test(normalized)) return 'technical';
  if (/^(requirement|need|must|should)\b/.test(normalized)) return 'requirement';
  return 'other';
};

const collectTranscriptSpeakers = (transcript = {}) => {
  const turnSpeakers = Array.isArray(transcript?.groupedSpeakerTurns)
    ? transcript.groupedSpeakerTurns.map((item) => String(item?.speaker || '').trim()).filter(Boolean)
    : [];
  const segmentSpeakers = Array.isArray(transcript?.segments)
    ? transcript.segments.map((item) => String(item?.speaker || '').trim()).filter(Boolean)
    : [];

  return [...new Set([...turnSpeakers, ...segmentSpeakers])];
};

const resolveDefaultSpeaker = (participants = [], transcript = {}) => {
  if (participants.length === 1) {
    return participants[0].speaker || null;
  }

  const transcriptSpeakers = collectTranscriptSpeakers(transcript);
  if (transcriptSpeakers.length === 1) {
    return transcriptSpeakers[0];
  }

  return null;
};

const enrichKeyPoint = (item = {}, participants = [], transcript = {}) => {
  const normalized = normalizeKeyPoint(item);
  const defaultSpeaker = resolveDefaultSpeaker(participants, transcript);

  if (!normalized.speaker && defaultSpeaker && normalized.point && !normalized.displayText) {
    normalized.speaker = defaultSpeaker;
    normalized.displayText = normalized.label
      ? `${defaultSpeaker} - (${normalized.label}) : ${normalized.point}`
      : normalized.point;
  }

  return normalized;
};

const normalizeSummary = (summary = {}, transcript = {}) => {
  const participants = Array.isArray(summary?.participants)
    ? summary.participants.map(normalizeParticipant).filter((item) => item.speaker || item.name || item.role)
    : [];

  const rawKeyPoints = Array.isArray(summary?.keyPoints)
    ? summary.keyPoints
    : (Array.isArray(transcript.keyPoints) ? transcript.keyPoints : []);

  return {
    ...emptySummary,
    executiveSummary: Array.isArray(summary?.executiveSummary)
      ? normalizeStringArray(summary.executiveSummary)
      : (transcript.summary ? [String(transcript.summary).trim()].filter(Boolean) : []),
    participants,
    keyPoints: rawKeyPoints.map((item) => enrichKeyPoint(item, participants, transcript)).filter((item) => item.point),
    decisions: normalizeStringArray(summary?.decisions),
    actionItems: Array.isArray(summary?.actionItems)
      ? summary.actionItems.map(normalizeActionItem).filter((item) => item.task)
      : (Array.isArray(transcript.actionItems) ? transcript.actionItems.map(normalizeActionItem).filter((item) => item.task) : []),
    risks: normalizeStringArray(summary?.risks),
    openQuestions: normalizeStringArray(summary?.openQuestions),
    importantNotes: normalizeStringArray(summary?.importantNotes),
    topics: Array.isArray(summary?.topics)
      ? summary.topics.map(normalizeTopic).filter((item) => item.title || item.summary)
      : [],
    confidenceNotes: normalizeStringArray(summary?.confidenceNotes),
    generatedAt: summary?.generatedAt || null,
    model: summary?.model || '',
    source: summary?.source || '',
    fallback: Boolean(summary?.fallback),
    transcriptExcerptChars: numberOr(summary?.transcriptExcerptChars, 0),
  };
};


const normalizeTranscriptPayload = (item = {}) => {
  const finalValidatedText = selectDisplayTranscript(item, '');
  const validatedEnglishText = chooseBestTranscriptText(
    item.validatedEnglishText,
    item.translatedEnglish,
    item.cleanEnglish,
  );
  const validatedSourceText = chooseBestTranscriptText(
    item.validatedSourceText,
    item.sourceFullText,
    item.normalizedSourceFullText,
    item.rawTranscriptNormalized,
    item.rawFullText,
  );

  return {
    ...item,
    meetingId: item.meetingId || item.meeting?.meetingId || item._id || null,
    finalValidatedText,
    fullText: finalValidatedText,
    displayText: finalValidatedText,
    validatedEnglishText,
    translatedEnglish: validatedEnglishText,
    cleanEnglish: validatedEnglishText,
    validatedSourceText,
    sourceFullText: validatedSourceText,
    rawFullText:
      item.rawFullText ||
      item.sourceFullText ||
      item.rawTranscriptNormalized ||
      validatedSourceText ||
      '',
    rawTranscriptNormalized:
      item.rawTranscriptNormalized ||
      item.sourceFullText ||
      item.rawFullText ||
      validatedSourceText ||
      '',
    warnings: normalizeStringArray(item.warnings),
    translationWarnings: normalizeStringArray(item.translationWarnings),
    uncertainTerms: normalizeStringArray(item.uncertainTerms),
    groupedSpeakerTurns: Array.isArray(item.groupedSpeakerTurns) ? item.groupedSpeakerTurns : [],
    segments: Array.isArray(item.segments) ? item.segments : [],
    quality: item.quality || {},
    fallbackReason: item.fallbackReason || item.quality?.fallbackReason || '',
    symptomsData: normalizeSymptoms(item.symptomsData),
    // Script drift: Gujarati speech transcribed in Hindi Devanagari script
    // Passed through from Python service for frontend warning display
    scriptDriftDetected: Boolean(item.scriptDriftDetected),
    scriptDriftSegments: Number(item.scriptDriftSegments || 0),
  };
};

const normalizeTranscriptListItem = (item = {}) => ({
  ...item,
  meetingId: item.meetingId || item.meeting?.meetingId || item._id || null,
  title: item.title || item.meeting?.title || 'Untitled meeting',
  source: item.source || item.meeting?.source || '',
  createdAt:
    item.createdAt ||
    item.meeting?.createdAt ||
    item.updatedAt ||
    new Date().toISOString(),
  updatedAt:
    item.updatedAt ||
    item.meeting?.updatedAt ||
    item.createdAt ||
    new Date().toISOString(),
  processingStatus: item.processingStatus || 'pending',
  preview:
    item.preview ||
    item.summary ||
    item.cleanEnglish ||
    item.fullText ||
    item.rawFullText ||
    String(item.fullText || item.cleanEnglish || item.rawFullText || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 220),
  summaryData: normalizeSummary(item.summaryData, item),
  stats: {
    ...(item.stats || {}),
    durationSec: numberOr(item.stats?.durationSec ?? item.meeting?.stats?.durationSec, 0),
    chunksUploaded: numberOr(item.stats?.chunksUploaded ?? item.meeting?.stats?.chunksUploaded, 0),
    chunksCompleted30s: numberOr(
      item.stats?.chunksCompleted30s ?? item.meeting?.stats?.chunksCompleted30s,
      0,
    ),
    hasFinalPartialChunk: Boolean(
      item.stats?.hasFinalPartialChunk ?? item.meeting?.stats?.hasFinalPartialChunk,
    ),
  },
});

const normalizeTranscriptsListPayload = (payload) => {
  if (Array.isArray(payload)) {
    const items = payload.map(normalizeTranscriptListItem);
    return {
      items,
      page: 1,
      limit: items.length || 20,
      total: items.length,
      totalPages: 1,
    };
  }

  if (payload && Array.isArray(payload.items)) {
    const items = payload.items.map(normalizeTranscriptListItem);
    const total = numberOr(payload.total ?? payload.pagination?.total ?? items.length, 0);
    const limit = numberOr(payload.limit ?? payload.pagination?.limit ?? items.length ?? 20, 20);
    const page = numberOr(payload.page ?? payload.pagination?.page ?? 1, 1);

    return {
      items,
      page,
      limit,
      total,
      totalPages: numberOr(
        payload.totalPages ??
          payload.pagination?.pages ??
          Math.max(1, Math.ceil(total / Math.max(limit, 1))),
        1,
      ),
    };
  }

  if (payload && Array.isArray(payload.data)) {
    const items = payload.data.map(normalizeTranscriptListItem);
    const total = numberOr(payload.pagination?.total ?? items.length, 0);
    const limit = numberOr(payload.pagination?.limit ?? items.length ?? 20, 20);
    const page = numberOr(payload.pagination?.page ?? 1, 1);

    return {
      items,
      page,
      limit,
      total,
      totalPages: numberOr(
        payload.pagination?.pages ?? Math.max(1, Math.ceil(total / Math.max(limit, 1))),
        1,
      ),
    };
  }

  return {
    items: [],
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 0,
  };
};

const normalizeTranscriptDetailPayload = (payload) => {
  if (!payload) return null;

  if (payload.transcript) {
    const transcript = {
      ...payload.transcript,
      meeting: payload.meeting || null,
      meetingId: payload.transcript.meetingId || payload.meeting?.meetingId || null,
      title: payload.meeting?.title || payload.transcript.title || 'Untitled meeting',
      source: payload.meeting?.source || payload.transcript.source || '',
      createdAt:
        payload.meeting?.createdAt ||
        payload.transcript.createdAt ||
        payload.transcript.updatedAt,
      stats: {
        ...(payload.transcript.stats || {}),
        ...(payload.meeting?.stats || {}),
      },
    };

    const normalizedTranscript = normalizeTranscriptPayload(transcript);
    normalizedTranscript.summaryData = normalizeSummary(payload.transcript.summaryData, normalizedTranscript);
    return normalizedTranscript;
  }

  return normalizeTranscriptPayload(normalizeTranscriptListItem(payload));
};

const normalizeSummaryPayload = (payload) => {
  if (!payload) return null;

  const transcript = payload.transcript || {};
  return {
    meeting: payload.meeting || null,
    meetingId: payload.meetingId || transcript.meetingId || payload.meeting?.meetingId || null,
    title: payload.title || payload.meeting?.title || transcript.title || 'Untitled meeting',
    processingStatus: payload.processingStatus || transcript.processingStatus || 'completed',
    summary: normalizeSummary(payload.summary, transcript),
    transcript,
  };
};


const normalizeSymptomsEvidenceItem = (item = {}, withSeverity = false) => {
  const normalized = {
    title: String(item?.title || '').trim(),
    detail: String(item?.detail || '').trim(),
    evidence: normalizeStringArray(item?.evidence),
  };

  if (withSeverity) {
    const severity = String(item?.severity || '').trim().toLowerCase();
    normalized.severity = ['low', 'medium', 'high'].includes(severity) ? severity : 'low';
  }

  return normalized;
};

const normalizeSymptoms = (symptoms = {}) => ({
  ...emptySymptoms,
  success: symptoms?.success === true,
  meetingOverview: {
    summary: String(symptoms?.meetingOverview?.summary || '').trim(),
    overallCommunicationStyle: normalizeStringArray(symptoms?.meetingOverview?.overallCommunicationStyle),
    globalSymptoms: normalizeStringArray(symptoms?.meetingOverview?.globalSymptoms),
    riskFlags: normalizeStringArray(symptoms?.meetingOverview?.riskFlags),
    highlights: normalizeStringArray(symptoms?.meetingOverview?.highlights),
  },
  speakers: Array.isArray(symptoms?.speakers)
    ? symptoms.speakers.map((speaker = {}, index) => ({
      speaker: String(speaker?.speaker || `Speaker ${index + 1}`).trim(),
      turnCount: numberOr(speaker?.turnCount, 0),
      talkTimeEstimate: numberOr(speaker?.talkTimeEstimate, 0),
      overallStyle: String(speaker?.overallStyle || '').trim(),
      evidenceQuality: String(speaker?.evidenceQuality || 'medium').trim().toLowerCase(),
      strongPoints: Array.isArray(speaker?.strongPoints)
        ? speaker.strongPoints.map((item) => normalizeSymptomsEvidenceItem(item, false)).filter((item) => item.title || item.detail || item.evidence.length)
        : [],
      weakPoints: Array.isArray(speaker?.weakPoints)
        ? speaker.weakPoints.map((item) => normalizeSymptomsEvidenceItem(item, false)).filter((item) => item.title || item.detail || item.evidence.length)
        : [],
      symptoms: Array.isArray(speaker?.symptoms)
        ? speaker.symptoms.map((item) => normalizeSymptomsEvidenceItem(item, true)).filter((item) => item.title || item.detail || item.evidence.length)
        : [],
      communicationScorecard: {
        clarity: numberOr(speaker?.communicationScorecard?.clarity, 0),
        confidence: numberOr(speaker?.communicationScorecard?.confidence, 0),
        engagement: numberOr(speaker?.communicationScorecard?.engagement, 0),
        structure: numberOr(speaker?.communicationScorecard?.structure, 0),
        ownership: numberOr(speaker?.communicationScorecard?.ownership, 0),
      },
      recommendations: normalizeStringArray(speaker?.recommendations),
    }))
    : [],
  meta: {
    model: String(symptoms?.meta?.model || 'lm_studio').trim(),
    usedGroupedTurns: symptoms?.meta?.usedGroupedTurns !== false,
    speakerCount: numberOr(symptoms?.meta?.speakerCount, 0),
    generatedAt: symptoms?.meta?.generatedAt || null,
    source: String(symptoms?.meta?.source || '').trim(),
    fallback: Boolean(symptoms?.meta?.fallback),
  },
  warnings: normalizeStringArray(symptoms?.warnings),
  error: String(symptoms?.error || '').trim(),
});

const normalizeSymptomsPayload = (payload) => {
  if (!payload) return null;
  return {
    meeting: payload.meeting || null,
    meetingId: payload.meetingId || payload.transcript?.meetingId || payload.meeting?.meetingId || null,
    title: payload.title || payload.meeting?.title || payload.transcript?.title || 'Untitled meeting',
    processingStatus: payload.processingStatus || payload.transcript?.processingStatus || 'completed',
    symptoms: normalizeSymptoms(payload.symptoms),
    transcript: payload.transcript || null,
    reused: Boolean(payload.reused),
  };
};

export const fetchTranscripts = createAsyncThunk(
  'transcripts/fetchTranscripts',
  async (params = {}, { rejectWithValue }) => {
    try {
      const response = await api.get('/transcripts', { params });
      return normalizeTranscriptsListPayload(response.data?.data || response.data);
    } catch (error) {
      return rejectWithValue(handleApiError(error, 'Failed to fetch transcripts'));
    }
  },
);

export const fetchTranscriptByMeetingId = createAsyncThunk(
  'transcripts/fetchTranscriptByMeetingId',
  async (meetingId, { rejectWithValue }) => {
    try {
      if (!meetingId || String(meetingId) === 'undefined' || String(meetingId) === 'null') {
        return {
          meetingId: null,
          fullText: '',
          rawFullText: '',
          cleanEnglish: '',
          rawTranscriptNormalized: '',
          uncertainTerms: [],
          confidenceNotes: '',
          segments: [],
          groupedSpeakerTurns: [],
          processingStatus: 'pending',
          summary: '',
          keyPoints: [],
          actionItems: [],
          summaryData: { ...emptySummary },
          lastError: null,
          stats: {
            durationSec: 0,
            chunksUploaded: 0,
            chunksCompleted30s: 0,
            hasFinalPartialChunk: false,
          },
        };
      }

      const response = await api.get(`/transcripts/${meetingId}`, silentRequestConfig);
      return normalizeTranscriptPayload(normalizeTranscriptDetailPayload(response.data?.data || response.data));
    } catch (error) {
      if (error?.response?.status === 404) {
        return {
          meetingId,
          fullText: '',
          rawFullText: '',
          cleanEnglish: '',
          rawTranscriptNormalized: '',
          uncertainTerms: [],
          confidenceNotes: '',
          segments: [],
          groupedSpeakerTurns: [],
          processingStatus: 'pending',
          summary: '',
          keyPoints: [],
          actionItems: [],
          summaryData: { ...emptySummary },
          lastError: null,
          stats: {
            durationSec: 0,
            chunksUploaded: 0,
            chunksCompleted30s: 0,
            hasFinalPartialChunk: false,
          },
        };
      }

      return rejectWithValue(handleApiError(error, 'Failed to fetch transcript'));
    }
  },
);

export const fetchTranscriptSummary = createAsyncThunk(
  'transcripts/fetchTranscriptSummary',
  async (meetingId, { rejectWithValue }) => {
    try {
      const response = await api.get(`/transcripts/${meetingId}/summary`, silentRequestConfig);
      return normalizeSummaryPayload(response.data?.data || response.data);
    } catch (error) {
      return rejectWithValue(handleApiError(error, 'Failed to fetch summary'));
    }
  },
);

export const generateTranscriptSummary = createAsyncThunk(
  'transcripts/generateTranscriptSummary',
  async ({ meetingId, force = false }, { rejectWithValue }) => {
    try {
      const response = await api.post(`/transcripts/${meetingId}/generate-summary`, { force });
      return normalizeSummaryPayload(response.data?.data || response.data);
    } catch (error) {
      return rejectWithValue(handleApiError(error, 'Failed to generate summary'));
    }
  },
);


export const fetchTranscriptSymptoms = createAsyncThunk(
  'transcripts/fetchTranscriptSymptoms',
  async (meetingId, { rejectWithValue }) => {
    try {
      const response = await api.get(`/transcripts/${meetingId}/symptoms`, silentRequestConfig);
      return normalizeSymptomsPayload(response.data?.data || response.data);
    } catch (error) {
      return rejectWithValue(handleApiError(error, 'Failed to fetch symptoms analysis'));
    }
  },
);

export const generateTranscriptSymptoms = createAsyncThunk(
  'transcripts/generateTranscriptSymptoms',
  async ({ meetingId, force = false }, { rejectWithValue }) => {
    try {
      const response = await api.post(`/transcripts/${meetingId}/generate-symptoms`, { force });
      return normalizeSymptomsPayload(response.data?.data || response.data);
    } catch (error) {
      return rejectWithValue(handleApiError(error, 'Failed to generate symptoms analysis'));
    }
  },
);

export const exportTranscript = createAsyncThunk(
  'transcripts/exportTranscript',
  async ({ meetingId, format }, { rejectWithValue }) => {
    try {
      const response = await api.get(`/meetings/${meetingId}/transcript.${format}`, {
        responseType: 'blob',
      });
      return response.data;
    } catch (error) {
      return rejectWithValue(handleApiError(error, 'Export failed'));
    }
  },
);

const transcriptsSlice = createSlice({
  name: 'transcripts',
  initialState,
  reducers: {
    setFilters: (state, action) => {
      state.filters = { ...state.filters, ...(action.payload || {}) };
      state.pagination.page = 1;
    },
    setPage: (state, action) => {
      state.pagination.page = Number(action.payload || 1);
    },
    clearCurrentTranscript: (state) => {
      state.currentTranscript = null;
      state.currentSummary = null;
      state.currentSymptoms = null;
      state.summaryError = null;
      state.symptomsError = null;
    },
    clearCurrentSummary: (state) => {
      state.currentSummary = null;
      state.summaryError = null;
    },
    clearCurrentSymptoms: (state) => {
      state.currentSymptoms = null;
      state.symptomsError = null;
    },
    updateTranscript: (state, action) => {
      const {
        meetingId,
        text,
        segments,
        groupedSpeakerTurns,
        rawFullText,
        cleanEnglish,
        rawTranscriptNormalized,
        uncertainTerms,
        confidenceNotes,
        processingStatus,
        durationSecTotal,
        chunksUploaded,
        chunksCompleted30s,
        hasFinalPartialChunk,
      } = action.payload || {};

      if (state.currentTranscript?.meetingId !== meetingId) {
        return;
      }

      state.currentTranscript.finalValidatedText = text || cleanEnglish || rawFullText || state.currentTranscript.finalValidatedText || '';
      state.currentTranscript.fullText = state.currentTranscript.finalValidatedText;
      state.currentTranscript.displayText = state.currentTranscript.finalValidatedText;

      if (typeof rawFullText === 'string') state.currentTranscript.rawFullText = rawFullText;
      if (typeof cleanEnglish === 'string') state.currentTranscript.cleanEnglish = cleanEnglish;
      if (typeof cleanEnglish === 'string') state.currentTranscript.translatedEnglish = cleanEnglish;
      if (typeof cleanEnglish === 'string') state.currentTranscript.validatedEnglishText = cleanEnglish;
      if (typeof rawTranscriptNormalized === 'string') state.currentTranscript.rawTranscriptNormalized = rawTranscriptNormalized;
      if (typeof rawTranscriptNormalized === 'string') state.currentTranscript.sourceFullText = rawTranscriptNormalized;
      if (typeof rawTranscriptNormalized === 'string') state.currentTranscript.validatedSourceText = rawTranscriptNormalized;
      if (Array.isArray(uncertainTerms)) state.currentTranscript.uncertainTerms = uncertainTerms;
      if (typeof confidenceNotes === 'string') state.currentTranscript.confidenceNotes = confidenceNotes;
      if (typeof processingStatus === 'string') state.currentTranscript.processingStatus = processingStatus;
      if (Array.isArray(segments)) state.currentTranscript.segments = segments;
      if (Array.isArray(groupedSpeakerTurns)) state.currentTranscript.groupedSpeakerTurns = groupedSpeakerTurns;

      const currentStats = state.currentTranscript.stats || {};
      state.currentTranscript.stats = {
        ...currentStats,
        durationSec: numberOr(durationSecTotal ?? currentStats.durationSec ?? 0, 0),
        chunksUploaded: numberOr(chunksUploaded ?? currentStats.chunksUploaded ?? 0, 0),
        chunksCompleted30s: numberOr(chunksCompleted30s ?? currentStats.chunksCompleted30s ?? 0, 0),
        hasFinalPartialChunk: Boolean(hasFinalPartialChunk ?? currentStats.hasFinalPartialChunk ?? false),
      };

      state.currentTranscript.updatedAt = new Date().toISOString();
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchTranscripts.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchTranscripts.fulfilled, (state, action) => {
        state.loading = false;
        state.items = Array.isArray(action.payload?.items) ? action.payload.items : [];
        state.pagination = {
          page: numberOr(action.payload?.page, 1),
          limit: numberOr(action.payload?.limit, 20),
          total: numberOr(action.payload?.total, 0),
          totalPages: numberOr(action.payload?.totalPages, 0),
        };
      })
      .addCase(fetchTranscripts.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload || action.error?.message || 'Failed to fetch transcripts';
      })
      .addCase(fetchTranscriptByMeetingId.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchTranscriptByMeetingId.fulfilled, (state, action) => {
        state.loading = false;
        state.currentTranscript = action.payload ? normalizeTranscriptPayload(action.payload) : null;
        if (action.payload?.symptomsData?.success) {
          state.currentSymptoms = {
            meeting: action.payload?.meeting || null,
            meetingId: action.payload.meetingId,
            title: action.payload.title || 'Untitled meeting',
            processingStatus: action.payload.processingStatus || 'completed',
            symptoms: normalizeSymptoms(action.payload.symptomsData),
            transcript: action.payload,
            reused: true,
          };
        }
        if (action.payload?.summaryData) {
          state.currentSummary = {
            meeting: action.payload?.meeting || null,
            meetingId: action.payload.meetingId,
            title: action.payload.title || 'Untitled meeting',
            processingStatus: action.payload.processingStatus || 'completed',
            summary: normalizeSummary(action.payload.summaryData, action.payload),
            transcript: action.payload,
          };
        }
      })
      .addCase(fetchTranscriptByMeetingId.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload || action.error?.message || 'Failed to fetch transcript';
      })
      .addCase(fetchTranscriptSummary.pending, (state) => {
        state.summaryLoading = true;
        state.summaryError = null;
      })
      .addCase(fetchTranscriptSummary.fulfilled, (state, action) => {
        state.summaryLoading = false;
        state.currentSummary = action.payload || null;
        state.summaryError = null;
      })
      .addCase(fetchTranscriptSummary.rejected, (state, action) => {
        state.summaryLoading = false;
        state.summaryError = action.payload || action.error?.message || 'Failed to fetch summary';
      })
      .addCase(generateTranscriptSummary.pending, (state) => {
        state.summaryLoading = true;
        state.summaryError = null;
      })
      .addCase(generateTranscriptSummary.fulfilled, (state, action) => {
        state.summaryLoading = false;
        state.currentSummary = action.payload || null;
        state.summaryError = null;

        if (state.currentTranscript && action.payload?.summary) {
          state.currentTranscript.summaryData = normalizeSummary(action.payload.summary, state.currentTranscript);
          state.currentTranscript.summary = action.payload.summary.executiveSummary?.join(' ') || '';
          state.currentTranscript.keyPoints = action.payload.summary.keyPoints || [];
          state.currentTranscript.actionItems = action.payload.summary.actionItems || [];
        }
      })
      .addCase(generateTranscriptSummary.rejected, (state, action) => {
        state.summaryLoading = false;
        state.summaryError = action.payload || action.error?.message || 'Failed to generate summary';
      })
      .addCase(fetchTranscriptSymptoms.pending, (state) => {
        state.symptomsLoading = true;
        state.symptomsError = null;
      })
      .addCase(fetchTranscriptSymptoms.fulfilled, (state, action) => {
        state.symptomsLoading = false;
        state.symptomsError = null;
        state.currentSymptoms = action.payload || null;
        if (state.currentTranscript && action.payload?.symptoms) {
          state.currentTranscript.symptomsData = normalizeSymptoms(action.payload.symptoms);
        }
      })
      .addCase(fetchTranscriptSymptoms.rejected, (state, action) => {
        state.symptomsLoading = false;
        state.symptomsError = action.payload || action.error?.message || 'Failed to fetch symptoms analysis';
      })
      .addCase(generateTranscriptSymptoms.pending, (state) => {
        state.symptomsLoading = true;
        state.symptomsError = null;
      })
      .addCase(generateTranscriptSymptoms.fulfilled, (state, action) => {
        state.symptomsLoading = false;
        state.symptomsError = null;
        state.currentSymptoms = action.payload || null;
        if (action.payload?.transcript) {
          state.currentTranscript = normalizeTranscriptPayload(action.payload.transcript);
        } else if (state.currentTranscript && action.payload?.symptoms) {
          state.currentTranscript.symptomsData = normalizeSymptoms(action.payload.symptoms);
        }
      })
      .addCase(generateTranscriptSymptoms.rejected, (state, action) => {
        state.symptomsLoading = false;
        state.symptomsError = action.payload || action.error?.message || 'Failed to generate symptoms analysis';
      });
  },
});

export const {
  setFilters,
  setPage,
  clearCurrentTranscript,
  clearCurrentSummary,
  clearCurrentSymptoms,
  updateTranscript,
} = transcriptsSlice.actions;

export default transcriptsSlice.reducer;