import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import api, { handleApiError } from '../../services/api';

const initialState = {
  items: [],
  currentMeeting: null,
  loading: false,
  error: null,
  filters: {
    status: '',
    source: '',
    deviceId: '',
    language: '',
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

const getMeetingKey = (meeting) => meeting?._id || meeting?.meetingId || null;

const sameMeeting = (meeting, idOrMeetingId) =>
  meeting?._id === idOrMeetingId || meeting?.meetingId === idOrMeetingId;

const normalizeMeetingsListPayload = (payload) => {
  if (Array.isArray(payload)) {
    return {
      items: payload,
      page: 1,
      limit: payload.length || 20,
      total: payload.length,
      totalPages: 1,
    };
  }

  if (payload && Array.isArray(payload.items)) {
    return {
      items: payload.items,
      page: Number(payload.page || 1),
      limit: Number(payload.limit || payload.items.length || 20),
      total: Number(payload.total || payload.items.length || 0),
      totalPages: Number(payload.totalPages || 1),
    };
  }

  if (payload && Array.isArray(payload.meetings)) {
    return {
      items: payload.meetings,
      page: Number(payload.page || 1),
      limit: Number(payload.limit || payload.meetings.length || 20),
      total: Number(payload.total || payload.meetings.length || 0),
      totalPages: Number(payload.totalPages || 1),
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

const upsertMeetingInList = (state, meeting) => {
  if (!meeting) return;

  const key = getMeetingKey(meeting);
  const index = state.items.findIndex((item) => sameMeeting(item, key));

  if (index === -1) {
    state.items.unshift(meeting);
  } else {
    state.items[index] = {
      ...state.items[index],
      ...meeting,
      stats: {
        ...(state.items[index]?.stats || {}),
        ...(meeting?.stats || {}),
      },
    };
  }
};

const updateMeetingEverywhere = (state, meetingId, updater) => {
  const item = state.items.find((m) => sameMeeting(m, meetingId));
  if (item) updater(item);

  if (state.currentMeeting && sameMeeting(state.currentMeeting, meetingId)) {
    updater(state.currentMeeting);
  }
};

export const fetchMeetings = createAsyncThunk(
  'meetings/fetchMeetings',
  async (params = {}, { rejectWithValue }) => {
    try {
      const response = await api.get('/meetings', { params });
      return normalizeMeetingsListPayload(response.data?.data);
    } catch (error) {
      return rejectWithValue(handleApiError(error, 'Failed to fetch meetings'));
    }
  }
);

export const fetchMeetingById = createAsyncThunk(
  'meetings/fetchMeetingById',
  async (id, { rejectWithValue }) => {
    try {
      if (!id || String(id) === 'undefined' || String(id) === 'null') {
        return null;
      }
      const response = await api.get(`/meetings/${id}`);
      return response.data?.data || null;
    } catch (error) {
      return rejectWithValue(handleApiError(error, 'Failed to fetch meeting'));
    }
  }
);

export const createMeeting = createAsyncThunk(
  'meetings/createMeeting',
  async (payload, { rejectWithValue }) => {
    try {
      const response = await api.post('/meetings/start', payload);
      return response.data?.data || null;
    } catch (error) {
      return rejectWithValue(handleApiError(error, 'Failed to create meeting'));
    }
  }
);

export const startMeeting = createAsyncThunk(
  'meetings/startMeeting',
  async (payload, thunkApi) => {
    return thunkApi.dispatch(createMeeting(payload)).unwrap();
  }
);

export const endMeeting = createAsyncThunk(
  'meetings/endMeeting',
  async (meetingId, { rejectWithValue }) => {
    try {
      const response = await api.post(`/meetings/${meetingId}/end`);
      return response.data?.data || null;
    } catch (error) {
      return rejectWithValue(handleApiError(error, 'Failed to end meeting'));
    }
  }
);

export const uploadChunk = createAsyncThunk(
  'meetings/uploadChunk',
  async ({ meetingId, formData, chunkIndex, blob, params = {} }, { rejectWithValue }) => {
    try {
      if (formData) {
        const response = await api.post(`/meetings/${meetingId}/chunks`, formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
          timeout: 10 * 60 * 1000,
        });
        return response.data?.data || null;
      }

      if (blob) {
        const response = await api.post(`/meetings/${meetingId}/chunks`, blob, {
          params,
          headers: {
            'Content-Type': blob?.type || 'audio/webm',
            'x-chunk-index': String(chunkIndex ?? 0),
            'x-duration-sec': String(params?.durationSec ?? 0),
            'x-upload-token': params?.uploadToken || `${meetingId}-${chunkIndex}-${Date.now()}`,
          },
          timeout: 10 * 60 * 1000,
        });
        return response.data?.data || null;
      }

      return rejectWithValue('No chunk payload provided');
    } catch (error) {
      return rejectWithValue(handleApiError(error, 'Failed to upload chunk'));
    }
  }
);

const meetingsSlice = createSlice({
  name: 'meetings',
  initialState,
  reducers: {
    setFilters: (state, action) => {
      state.filters = {
        ...state.filters,
        ...(action.payload || {}),
      };
      state.pagination.page = 1;
    },

    setPage: (state, action) => {
      state.pagination.page = Number(action.payload || 1);
    },

    clearCurrentMeeting: (state) => {
      state.currentMeeting = null;
    },

    updateMeetingStatus: (state, action) => {
      const {
        meetingId,
        status,
        startTime,
        endTime,
        source,
        deviceId,
        durationSec,
      } = action.payload || {};

      if (!meetingId) return;

      updateMeetingEverywhere(state, meetingId, (meeting) => {
        if (status !== undefined) meeting.status = status;
        if (startTime !== undefined) meeting.startTime = startTime;
        if (endTime !== undefined) meeting.endTime = endTime;
        if (source !== undefined) meeting.source = source;
        if (deviceId !== undefined) meeting.deviceId = deviceId;

        meeting.stats = {
          ...(meeting.stats || {}),
          ...(durationSec !== undefined ? { durationSec: Number(durationSec || 0) } : {}),
        };
      });
    },

    updateMeetingStats: (state, action) => {
      const { meetingId, stats = {} } = action.payload || {};
      if (!meetingId) return;

      updateMeetingEverywhere(state, meetingId, (meeting) => {
        meeting.stats = {
          ...(meeting.stats || {}),
          ...stats,
        };
      });
    },

    mergeLiveUpdate: (state, action) => {
      const payload = action.payload || {};
      const meetingId = payload.meetingId || payload._id;
      if (!meetingId) return;

      updateMeetingEverywhere(state, meetingId, (meeting) => {
        Object.assign(meeting, payload);
        meeting.stats = {
          ...(meeting.stats || {}),
          ...(payload.stats || {}),
        };
      });
    },

    mergeTranscriptLiveUpdate: (state, action) => {
      const { meetingId, transcript, stats } = action.payload || {};
      if (!meetingId) return;

      updateMeetingEverywhere(state, meetingId, (meeting) => {
        if (transcript !== undefined) {
          meeting.transcript = {
            ...(meeting.transcript || {}),
            ...(typeof transcript === 'object' ? transcript : { fullText: transcript }),
          };
        }

        if (stats) {
          meeting.stats = {
            ...(meeting.stats || {}),
            ...stats,
          };
        }
      });
    },
  },

  extraReducers: (builder) => {
    builder
      .addCase(fetchMeetings.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchMeetings.fulfilled, (state, action) => {
        state.loading = false;
        state.error = null;
        state.items = action.payload.items;
        state.pagination = {
          page: action.payload.page,
          limit: action.payload.limit,
          total: action.payload.total,
          totalPages: action.payload.totalPages,
        };
      })
      .addCase(fetchMeetings.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload || 'Failed to fetch meetings';
      })

      .addCase(fetchMeetingById.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchMeetingById.fulfilled, (state, action) => {
        state.loading = false;
        state.error = null;
        state.currentMeeting = action.payload;
        if (action.payload) upsertMeetingInList(state, action.payload);
      })
      .addCase(fetchMeetingById.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload || 'Failed to fetch meeting';
      })

      .addCase(createMeeting.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(createMeeting.fulfilled, (state, action) => {
        state.loading = false;
        state.error = null;
        if (action.payload) {
          upsertMeetingInList(state, action.payload);
          state.currentMeeting = action.payload;
        }
      })
      .addCase(createMeeting.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload || 'Failed to create meeting';
      })

      .addCase(startMeeting.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(startMeeting.fulfilled, (state, action) => {
        state.loading = false;
        state.error = null;
        if (action.payload) {
          upsertMeetingInList(state, action.payload);
          state.currentMeeting = action.payload;
        }
      })
      .addCase(startMeeting.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload || 'Failed to start meeting';
      })

      .addCase(endMeeting.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(endMeeting.fulfilled, (state, action) => {
        state.loading = false;
        state.error = null;
        if (action.payload) {
          upsertMeetingInList(state, action.payload);
          if (state.currentMeeting && sameMeeting(state.currentMeeting, getMeetingKey(action.payload))) {
            state.currentMeeting = {
              ...state.currentMeeting,
              ...action.payload,
              stats: {
                ...(state.currentMeeting?.stats || {}),
                ...(action.payload?.stats || {}),
              },
            };
          }
        }
      })
      .addCase(endMeeting.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload || 'Failed to end meeting';
      })

      .addCase(uploadChunk.pending, (state) => {
        state.error = null;
      })
      .addCase(uploadChunk.fulfilled, (state, action) => {
        const payload = action.payload || {};
        const meetingId = payload.meetingId;
        if (!meetingId) return;

        updateMeetingEverywhere(state, meetingId, (meeting) => {
          meeting.stats = {
            ...(meeting.stats || {}),
            ...(payload.chunksUploaded !== undefined
              ? { chunksUploaded: Number(payload.chunksUploaded || 0) }
              : {}),
            ...(payload.chunksTotal !== undefined
              ? { chunksTotal: Number(payload.chunksTotal || 0) }
              : {}),
            ...(payload.durationSecTotal !== undefined
              ? { durationSec: Number(payload.durationSecTotal || 0) }
              : {}),
          };
        });
      })
      .addCase(uploadChunk.rejected, (state, action) => {
        state.error = action.payload || 'Failed to upload chunk';
      });
  },
});

export const {
  setFilters,
  setPage,
  clearCurrentMeeting,
  updateMeetingStatus,
  updateMeetingStats,
  mergeLiveUpdate,
  mergeTranscriptLiveUpdate,
} = meetingsSlice.actions;

export default meetingsSlice.reducer;