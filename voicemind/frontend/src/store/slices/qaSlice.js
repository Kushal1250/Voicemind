/**
 * qaSlice.js — v8.0
 * =================
 * Changes from v7:
 *  - normalizeInteraction now preserves `mode` field (gemini / lm_studio / fallback_rule_based / local)
 *  - normalizeInteraction now preserves `questionLang` field (en / gu / hi)
 *    so QAAnswerCard can show the language badge
 */

import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import api from '../../services/api';
import { normalizeSources } from '../../utils/qa';

const initialState = {
  interactions:        [],
  currentInteraction:  null,
  loading:             false,
  error:               null,
  globalMode:          false,
  lastAskedQuestion:   '',
};

const normalizeInteraction = (payload = {}) => {
  if (!payload || typeof payload !== 'object') return null;

  return {
    ...payload,
    _id:     payload._id || payload.id || `${payload.meetingId || 'qa'}-${payload.createdAt || Date.now()}`,
    answer:  String(payload.answer   || '').trim(),
    question: String(payload.question || '').trim(),
    createdAt: payload.createdAt || payload.updatedAt || new Date().toISOString(),
    sources:   normalizeSources(payload.sources),
    confidence: String(payload.confidence || payload.meta?.confidence || 'medium').toLowerCase(),
    limitedContext: Boolean(payload.limitedContext || payload.meta?.limitedContext),
    transcriptAvailable:
      typeof payload.transcriptAvailable === 'boolean'
        ? payload.transcriptAvailable
        : !(payload.meta?.transcriptAvailable === false),
    // v8.0 — AI backend that answered
    mode: payload.mode || null,
    // v8.0 — detected question language (en / gu / hi)
    questionLang: payload.questionLang || 'en',
  };
};

const sortByCreatedAtAsc = (items = []) =>
  [...items].sort((a, b) => new Date(a?.createdAt || 0).getTime() - new Date(b?.createdAt || 0).getTime());

const dedupeInteractions = (items = []) => {
  const seen   = new Set();
  const result = [];
  for (const item of items) {
    const key = item?._id || `${item?.question}-${item?.createdAt}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
};

const normalizeInteractionList = (payload) => {
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.items)
      ? payload.items
      : Array.isArray(payload?.interactions)
        ? payload.interactions
        : [];
  return sortByCreatedAtAsc(dedupeInteractions(raw.map(normalizeInteraction).filter(Boolean)));
};

export const askQuestion = createAsyncThunk(
  'qa/askQuestion',
  async ({ meetingId, question }, { rejectWithValue }) => {
    try {
      const endpoint = meetingId ? `/meetings/${meetingId}/qa` : '/qa/global';
      // ROOT-CAUSE FIX: the shared `api` client defaults to a 60s timeout,
      // which is shorter than the backend's own QA_TIMEOUT_MS (now ~170s to
      // cover Gemini + local Qwen fallback for long summaries). Without this
      // override the frontend aborted the request and showed a generic
      // error before the backend ever finished — even after the backend fix.
      const response = await api.post(endpoint, { question }, { timeout: 175000 });
      return normalizeInteraction(response.data.data);
    } catch (error) {
      return rejectWithValue(error.response?.data?.error?.message || 'Failed to get answer');
    }
  }
);

export const fetchQAHistory = createAsyncThunk(
  'qa/fetchQAHistory',
  async (meetingId, { rejectWithValue }) => {
    try {
      const response = await api.get(`/meetings/${meetingId}/qa`);
      return normalizeInteractionList(response.data.data);
    } catch (error) {
      return rejectWithValue(error.response?.data?.error?.message || 'Failed to fetch Q&A history');
    }
  }
);

export const fetchGlobalQA = createAsyncThunk(
  'qa/fetchGlobalQA',
  async (_, { rejectWithValue }) => {
    try {
      const response = await api.get('/qa/global');
      return normalizeInteractionList(response.data.data);
    } catch (error) {
      return rejectWithValue(error.response?.data?.error?.message || 'Failed to fetch global Q&A');
    }
  }
);

const qaSlice = createSlice({
  name: 'qa',
  initialState,
  reducers: {
    setGlobalMode: (state, action) => {
      state.globalMode = action.payload;
    },
    clearCurrentInteraction: (state) => {
      state.currentInteraction = null;
    },
    addInteraction: (state, action) => {
      const normalized = normalizeInteraction(action.payload);
      if (normalized) {
        state.interactions = normalizeInteractionList([...state.interactions, normalized]);
      }
    },
    clearQaError: (state) => {
      state.error = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(askQuestion.pending, (state, action) => {
        state.loading             = true;
        state.error               = null;
        state.lastAskedQuestion   = String(action.meta.arg?.question || '').trim();
      })
      .addCase(askQuestion.fulfilled, (state, action) => {
        state.loading            = false;
        state.currentInteraction = action.payload;
        state.interactions       = normalizeInteractionList([...state.interactions, action.payload]);
      })
      .addCase(askQuestion.rejected, (state, action) => {
        state.loading = false;
        state.error   = action.payload;
      })
      .addCase(fetchQAHistory.pending, (state) => {
        state.loading = true;
        state.error   = null;
      })
      .addCase(fetchQAHistory.fulfilled, (state, action) => {
        state.loading      = false;
        state.interactions = normalizeInteractionList(action.payload);
      })
      .addCase(fetchQAHistory.rejected, (state, action) => {
        state.loading      = false;
        state.error        = action.payload;
        state.interactions = [];
      })
      .addCase(fetchGlobalQA.pending, (state) => {
        state.loading = true;
        state.error   = null;
      })
      .addCase(fetchGlobalQA.fulfilled, (state, action) => {
        state.loading      = false;
        state.interactions = normalizeInteractionList(action.payload);
      })
      .addCase(fetchGlobalQA.rejected, (state, action) => {
        state.loading      = false;
        state.error        = action.payload;
        state.interactions = [];
      });
  },
});

export const { setGlobalMode, clearCurrentInteraction, addInteraction, clearQaError } = qaSlice.actions;
export default qaSlice.reducer;
