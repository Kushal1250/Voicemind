import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import api from '../../services/api';

const initialState = {
  overview: null,
  timeseries: [],
  qaTrend: [],
  loading: false,
  error: null,
  filters: {
    from: '',
    to: '',
    deviceId: '',
    status: '',
  },
};

export const fetchOverview = createAsyncThunk(
  'analytics/fetchOverview',
  async (params, { rejectWithValue }) => {
    try {
      const response = await api.get('/analytics/overview', { params });
      return response.data.data;
    } catch (error) {
      return rejectWithValue(error.response?.data?.error?.message || 'Failed to fetch overview');
    }
  }
);

export const fetchMeetingsTimeseries = createAsyncThunk(
  'analytics/fetchMeetingsTimeseries',
  async (params, { rejectWithValue }) => {
    try {
      const response = await api.get('/analytics/meetings-timeseries', { params });
      return response.data.data;
    } catch (error) {
      return rejectWithValue(error.response?.data?.error?.message || 'Failed to fetch timeseries');
    }
  }
);

export const fetchQATrend = createAsyncThunk(
  'analytics/fetchQATrend',
  async (params, { rejectWithValue }) => {
    try {
      const response = await api.get('/analytics/qa', { params });
      return response.data.data;
    } catch (error) {
      return rejectWithValue(error.response?.data?.error?.message || 'Failed to fetch Q&A trend');
    }
  }
);

export const exportMetrics = createAsyncThunk(
  'analytics/exportMetrics',
  async (params, { rejectWithValue }) => {
    try {
      const response = await api.get('/analytics/export', { params, responseType: 'blob' });
      return response.data;
    } catch (error) {
      return rejectWithValue(error.response?.data?.error?.message || 'Export failed');
    }
  }
);

const analyticsSlice = createSlice({
  name: 'analytics',
  initialState,
  reducers: {
    setFilters: (state, action) => {
      state.filters = { ...state.filters, ...action.payload };
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchOverview.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchOverview.fulfilled, (state, action) => {
        state.loading = false;
        state.overview = action.payload;
      })
      .addCase(fetchOverview.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      })
      .addCase(fetchMeetingsTimeseries.fulfilled, (state, action) => {
        state.timeseries = action.payload;
      })
      .addCase(fetchQATrend.fulfilled, (state, action) => {
        state.qaTrend = action.payload;
      });
  },
});

export const { setFilters } = analyticsSlice.actions;
export default analyticsSlice.reducer;
