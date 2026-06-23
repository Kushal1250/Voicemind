import { createSlice } from '@reduxjs/toolkit';
import { normalizeTranscriptEventPayload } from '../../utils/transcriptTurns';

const ACTIVE_STATUSES = new Set(['recording', 'uploading', 'processing', 'pending', 'partial']);
const FINISHED_STATUSES = new Set(['completed', 'done', 'ended', 'failed', 'cancelled']);

const toNumber = (value, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const toNullableNumber = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const firstFiniteNumber = (...values) => {
  for (const value of values) {
    const numeric = toNullableNumber(value);
    if (numeric !== null) return numeric;
  }
  return null;
};

const normalizeMeetingStatus = (value) => String(value || '').trim().toLowerCase();

const isMeetingLiveOrRecoverable = (status) => {
  const normalized = normalizeMeetingStatus(status);
  return ACTIVE_STATUSES.has(normalized);
};

const isMeetingFinished = (status) => {
  const normalized = normalizeMeetingStatus(status);
  return FINISHED_STATUSES.has(normalized);
};

export const deriveChunkProgress = (input = {}) => {
  const stats = input.stats || {};
  const transcriptStats = input.transcriptStats || {};
  const telemetry = input.telemetry || {};
  const status = normalizeMeetingStatus(input.status || input.processingStatus);

  const uploaded = Math.max(
    0,
    toNumber(
      firstFiniteNumber(
        input.uploaded,
        input.chunksUploaded,
        input.totalUploaded,
        stats.chunksUploaded,
        stats.uploadedChunks,
        stats.chunkCount,
        stats.uploaded,
        transcriptStats.chunksUploaded,
        transcriptStats.uploadedChunks,
        telemetry.chunksUploaded,
        telemetry.totalUploaded,
      ),
      0,
    ),
  );

  const processed = Math.max(
    0,
    toNumber(
      firstFiniteNumber(
        input.processed,
        input.chunksProcessed,
        input.processedChunks,
        stats.chunksProcessed,
        stats.processedChunks,
        stats.completedChunkCount,
        transcriptStats.chunksProcessed,
        transcriptStats.processedChunks,
      ),
      0,
    ),
  );

  const completed30s = Math.max(
    0,
    toNumber(
      firstFiniteNumber(
        input.completed30s,
        input.chunksCompleted30s,
        stats.chunksCompleted30s,
        transcriptStats.chunksCompleted30s,
      ),
      0,
    ),
  );

  const failed = Math.max(
    0,
    toNumber(
      firstFiniteNumber(
        input.failed,
        input.failedCount,
        input.failedChunkCount,
        input.chunksFailed,
        stats.failedChunkCount,
        stats.chunksFailed,
        transcriptStats.failedChunkCount,
      ),
      0,
    ),
  );

  const hasFinalPartialChunk = Boolean(
    input.hasFinalPartialChunk ??
      stats.hasFinalPartialChunk ??
      transcriptStats.hasFinalPartialChunk ??
      false,
  );

  const totalCandidates = [
    firstFiniteNumber(
      input.total,
      input.totalChunks,
      input.chunksTotal,
      input.expectedChunks,
      input.totalExpected,
      stats.chunksTotal,
      stats.totalChunks,
      stats.expectedChunks,
      stats.totalExpected,
      stats.displayTotal,
      transcriptStats.chunksTotal,
      transcriptStats.totalChunks,
      telemetry.chunksTotal,
    ),
    uploaded,
    completed30s + failed + (hasFinalPartialChunk ? 1 : 0),
    processed,
  ].filter((value) => value !== null && Number.isFinite(value));

  const explicitTotal = toNumber(totalCandidates[0], 0);
  const derivedTotal = Math.max(0, ...totalCandidates.map((value) => toNumber(value, 0)));
  const displayTotal = derivedTotal;
  const displayCurrent = Math.max(uploaded, completed30s, processed);
  const safeRatioBase = displayTotal > 0 ? displayTotal : displayCurrent > 0 ? displayCurrent : 0;
  const progressPercent = safeRatioBase > 0 ? Math.min(100, (displayCurrent / safeRatioBase) * 100) : 0;
  const isTotalExplicit = explicitTotal > 0;
  const hasAnyStats = displayCurrent > 0 || displayTotal > 0 || failed > 0 || hasFinalPartialChunk;

  return {
    uploaded,
    processed,
    completed30s,
    failed,
    total: explicitTotal,
    derivedTotal,
    displayCurrent,
    displayTotal,
    progressPercent,
    hasFinalPartialChunk,
    isTotalExplicit,
    hasAnyStats,
    status,
  };
};

const createEmptyChunkProgress = () => ({
  total: 0,
  derivedTotal: 0,
  uploaded: 0,
  processed: 0,
  completed30s: 0,
  failed: 0,
  displayCurrent: 0,
  displayTotal: 0,
  progressPercent: 0,
  hasFinalPartialChunk: false,
  isTotalExplicit: false,
  hasAnyStats: false,
  status: '',
});

const createEmptyDashboardLiveSession = () => ({
  isTracking: false,
  startedAt: null,
  meetingId: null,
  source: null,
  chunkProgress: createEmptyChunkProgress(),
  lastUpdatedAt: null,
});

const initialState = {
  activeDeviceStatus: null,
  activeMeetingStatus: null,
  activeMeetingId: null,
  liveTranscript: '',
  liveTranscriptData: {
    meetingId: null,
    fullText: '',
    rawFullText: '',
    cleanEnglish: '',
    rawTranscriptNormalized: '',
    groupedSpeakerTurns: [],
    segments: [],
    processingStatus: 'pending',
    chunksUploaded: 0,
    chunksCompleted30s: 0,
    hasFinalPartialChunk: false,
    durationSecTotal: 0,
    updatedAt: null,
  },
  liveTimeline: [],
  lastUpdatedAt: null,
  connectionMode: 'polling',
  isConnected: false,
  recordingStartTime: null,
  chunksProgress: createEmptyChunkProgress(),
  dashboardLiveSession: createEmptyDashboardLiveSession(),
};

const syncDashboardChunkProgressFromPayload = (state, payload = {}, options = {}) => {
  const session = state.dashboardLiveSession || createEmptyDashboardLiveSession();
  const payloadMeetingId = payload?.meetingId || payload?._id || null;
  const sessionMeetingId = session.meetingId || null;
  const allowWithoutMeetingId = Boolean(options.allowWithoutMeetingId);

  if (!session.isTracking || !sessionMeetingId) {
    return;
  }

  if (!allowWithoutMeetingId && payloadMeetingId && payloadMeetingId !== sessionMeetingId) {
    return;
  }

  if (!allowWithoutMeetingId && !payloadMeetingId) {
    return;
  }

  const nextProgress = deriveChunkProgress({
    ...session.chunkProgress,
    ...(payload || {}),
    status: payload?.status || state.activeMeetingStatus?.status || session.chunkProgress.status,
  });

  state.dashboardLiveSession = {
    ...session,
    chunkProgress: nextProgress,
    lastUpdatedAt: new Date().toISOString(),
  };
};

const applyMeetingSnapshot = (state, meeting = null, options = {}) => {
  const activeMeeting = meeting || null;
  const devices = Array.isArray(options.devices) ? options.devices : [];

  const activeDevice =
    devices.find(
      (device) =>
        device.currentMeetingId &&
        device.currentMeetingId === activeMeeting?.meetingId,
    ) ||
    devices.find((device) => device.status === 'online') ||
    devices[0] ||
    state.activeDeviceStatus ||
    null;

  state.activeDeviceStatus = activeDevice
    ? {
        ...(state.activeDeviceStatus || {}),
        deviceId: activeDevice.deviceId,
        name: activeDevice.name,
        status: activeDevice.status,
        telemetry: activeDevice.telemetry || {},
        lastSeenAt: activeDevice.lastSeenAt || null,
        currentMeetingId: activeDevice.currentMeetingId || activeMeeting?.meetingId || null,
      }
    : null;

  if (!activeMeeting) {
    state.activeMeetingStatus = null;
    state.activeMeetingId = null;
    state.recordingStartTime = null;
    state.chunksProgress = createEmptyChunkProgress();
    state.liveTranscript = '';
    state.liveTranscriptData = { ...initialState.liveTranscriptData };
    state.lastUpdatedAt = new Date().toISOString();
    return;
  }

  const transcriptPayload = normalizeTranscriptEventPayload(activeMeeting?.transcript || {});
  const chunkProgress = deriveChunkProgress({
    ...(activeMeeting || {}),
    stats: activeMeeting?.stats || {},
    transcriptStats: transcriptPayload?.stats || activeMeeting?.transcript?.stats || {},
    telemetry: state.activeDeviceStatus?.telemetry || {},
    processingStatus: transcriptPayload?.processingStatus,
  });

  state.activeMeetingStatus = {
    ...(state.activeMeetingStatus || {}),
    meetingId: activeMeeting.meetingId,
    deviceId: activeMeeting.deviceId,
    source: activeMeeting.source,
    status: activeMeeting.status,
    startTime: activeMeeting.startTime || activeMeeting.createdAt || null,
    endTime: activeMeeting.endTime || null,
    durationSec: Number(activeMeeting?.stats?.durationSec || 0),
  };
  state.activeMeetingId = activeMeeting.meetingId || null;

  state.liveTranscript = transcriptPayload.fullText;
  state.liveTranscriptData = {
    ...state.liveTranscriptData,
    ...transcriptPayload,
  };

  state.recordingStartTime =
    activeMeeting?.startTime || activeMeeting?.createdAt || state.recordingStartTime || null;

  state.chunksProgress = {
    ...state.chunksProgress,
    ...chunkProgress,
  };

  if (
    state.dashboardLiveSession?.isTracking &&
    state.dashboardLiveSession?.meetingId &&
    state.dashboardLiveSession.meetingId === activeMeeting.meetingId
  ) {
    syncDashboardChunkProgressFromPayload(
      state,
      {
        ...(activeMeeting || {}),
        stats: activeMeeting?.stats || {},
        transcriptStats: transcriptPayload?.stats || activeMeeting?.transcript?.stats || {},
        telemetry: state.activeDeviceStatus?.telemetry || {},
        processingStatus: transcriptPayload?.processingStatus,
      },
      { allowWithoutMeetingId: true },
    );
  }

  if (isMeetingFinished(activeMeeting.status) && !chunkProgress.hasAnyStats) {
    state.activeMeetingId = null;
  }

  state.lastUpdatedAt = new Date().toISOString();
};

const liveStatusSlice = createSlice({
  name: 'liveStatus',
  initialState,
  reducers: {
    setConnectionMode: (state, action) => {
      state.connectionMode = action.payload;
    },

    setConnected: (state, action) => {
      state.isConnected = Boolean(action.payload);
      state.lastUpdatedAt = new Date().toISOString();
    },

    updateDeviceStatus: (state, action) => {
      state.activeDeviceStatus = {
        ...(state.activeDeviceStatus || {}),
        ...action.payload,
      };
      state.lastUpdatedAt = new Date().toISOString();
    },

    updateMeetingStatus: (state, action) => {
      state.activeMeetingStatus = {
        ...(state.activeMeetingStatus || {}),
        ...action.payload,
      };

      state.activeMeetingId =
        action.payload?.meetingId || state.activeMeetingStatus?.meetingId || state.activeMeetingId || null;

      if (action.payload?.startTime) {
        state.recordingStartTime = action.payload.startTime;
      }

      if (action.payload?.status) {
        state.chunksProgress.status = normalizeMeetingStatus(action.payload.status);
      }

      state.lastUpdatedAt = new Date().toISOString();
    },

    appendTranscript: (state, action) => {
      state.liveTranscript = `${state.liveTranscript || ''}${action.payload || ''}`;
      state.liveTranscriptData.fullText = state.liveTranscript;
      state.lastUpdatedAt = new Date().toISOString();
    },

    setTranscript: (state, action) => {
      const payload = normalizeTranscriptEventPayload(action.payload || { fullText: action.payload || '' });
      // ROMANIZE MODE: prefer finalText (roman) over fullText if available
      state.liveTranscript = payload.finalText || payload.fullText;
      state.liveTranscriptData = {
        ...state.liveTranscriptData,
        ...payload,
      };

      state.chunksProgress = {
        ...state.chunksProgress,
        ...deriveChunkProgress({
          stats: state.chunksProgress,
          transcriptStats: payload?.stats || {},
          chunksUploaded: payload?.chunksUploaded,
          chunksCompleted30s: payload?.chunksCompleted30s,
          hasFinalPartialChunk: payload?.hasFinalPartialChunk,
          processingStatus: payload?.processingStatus,
        }),
      };

      if (
        state.dashboardLiveSession?.isTracking &&
        state.dashboardLiveSession?.meetingId &&
        payload?.meetingId &&
        payload.meetingId === state.dashboardLiveSession.meetingId
      ) {
        syncDashboardChunkProgressFromPayload(state, {
          meetingId: payload.meetingId,
          transcriptStats: payload?.stats || {},
          chunksUploaded: payload?.chunksUploaded,
          chunksCompleted30s: payload?.chunksCompleted30s,
          hasFinalPartialChunk: payload?.hasFinalPartialChunk,
          processingStatus: payload?.processingStatus,
        });
      }

      state.lastUpdatedAt = new Date().toISOString();
    },

    addTimelineEvent: (state, action) => {
      state.liveTimeline.unshift({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: action.payload?.timestamp || new Date().toISOString(),
        ...action.payload,
      });

      if (state.liveTimeline.length > 50) {
        state.liveTimeline = state.liveTimeline.slice(0, 50);
      }

      state.lastUpdatedAt = new Date().toISOString();
    },

    setRecordingStartTime: (state, action) => {
      state.recordingStartTime = action.payload || null;
      state.lastUpdatedAt = new Date().toISOString();
    },

    updateChunksProgress: (state, action) => {
      state.chunksProgress = {
        ...state.chunksProgress,
        ...deriveChunkProgress({
          ...state.chunksProgress,
          ...(action.payload || {}),
          status: action.payload?.status || state.activeMeetingStatus?.status || state.chunksProgress.status,
        }),
      };

      syncDashboardChunkProgressFromPayload(state, action.payload || {});
      state.lastUpdatedAt = new Date().toISOString();
    },

    hydrateLiveSnapshot: (state, action) => {
      const snapshot = action.payload || {};
      applyMeetingSnapshot(state, snapshot.activeMeeting || null, {
        devices: snapshot.devices,
      });
    },

    hydrateActiveMeeting: (state, action) => {
      applyMeetingSnapshot(state, action.payload?.meeting || action.payload || null, {
        devices: action.payload?.devices,
      });
    },

    beginDashboardLiveSession: (state, action) => {
      const meetingId = action.payload?.meetingId || action.payload?._id || null;
      state.dashboardLiveSession = {
        isTracking: Boolean(meetingId),
        meetingId,
        source: action.payload?.source || null,
        startedAt: action.payload?.startedAt || action.payload?.startTime || new Date().toISOString(),
        chunkProgress: createEmptyChunkProgress(),
        lastUpdatedAt: new Date().toISOString(),
      };
    },

    clearDashboardLiveSession: (state) => {
      state.dashboardLiveSession = createEmptyDashboardLiveSession();
    },

    clearActiveMeeting: (state) => {
      state.activeMeetingStatus = null;
      state.activeMeetingId = null;
      state.recordingStartTime = null;
      state.chunksProgress = createEmptyChunkProgress();
      state.liveTranscript = '';
      state.liveTranscriptData = { ...initialState.liveTranscriptData };
      state.lastUpdatedAt = new Date().toISOString();
    },

    resetLiveStatus: (state) => {
      state.activeDeviceStatus = null;
      state.activeMeetingStatus = null;
      state.activeMeetingId = null;
      state.liveTranscript = '';
      state.liveTranscriptData = { ...initialState.liveTranscriptData };
      state.liveTimeline = [];
      state.recordingStartTime = null;
      state.chunksProgress = createEmptyChunkProgress();
      state.dashboardLiveSession = createEmptyDashboardLiveSession();
      state.lastUpdatedAt = null;
    },

    clearConnection: (state) => {
      state.isConnected = false;
      state.connectionMode = 'polling';
    },
  },
});

export const {
  setConnectionMode,
  setConnected,
  updateDeviceStatus,
  updateMeetingStatus,
  appendTranscript,
  setTranscript,
  addTimelineEvent,
  setRecordingStartTime,
  updateChunksProgress,
  hydrateLiveSnapshot,
  hydrateActiveMeeting,
  beginDashboardLiveSession,
  clearDashboardLiveSession,
  clearActiveMeeting,
  resetLiveStatus,
  clearConnection,
} = liveStatusSlice.actions;

export { isMeetingFinished, isMeetingLiveOrRecoverable, normalizeMeetingStatus };

export default liveStatusSlice.reducer;