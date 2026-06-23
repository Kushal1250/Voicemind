import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import api from '../../services/api';

const initialState = {
  items: [],
  currentDevice: null,
  loading: false,
  error: null,
};

export const fetchDevices = createAsyncThunk(
  'devices/fetchDevices',
  async (_, { rejectWithValue }) => {
    try {
      const response = await api.get('/devices');
      return response.data.data;
    } catch (error) {
      return rejectWithValue(error.response?.data?.error?.message || 'Failed to fetch devices');
    }
  }
);

export const fetchDeviceById = createAsyncThunk(
  'devices/fetchDeviceById',
  async (id, { rejectWithValue }) => {
    try {
      const response = await api.get(`/devices/${id}`);
      return response.data.data;
    } catch (error) {
      return rejectWithValue(error.response?.data?.error?.message || 'Failed to fetch device');
    }
  }
);

export const fetchDeviceStatus = createAsyncThunk(
  'devices/fetchDeviceStatus',
  async (id, { rejectWithValue }) => {
    try {
      const response = await api.get(`/devices/${id}/status`);
      return response.data.data;
    } catch (error) {
      return rejectWithValue(error.response?.data?.error?.message || 'Failed to fetch device status');
    }
  }
);

const devicesSlice = createSlice({
  name: 'devices',
  initialState,
  reducers: {
    updateDeviceStatus: (state, action) => {
      const { deviceId, status, telemetry } = action.payload;
      const device = state.items.find(d => d.deviceId === deviceId);
      if (device) {
        device.status = status;
        if (telemetry) {
          device.telemetry = { ...device.telemetry, ...telemetry };
        }
        device.lastSeenAt = new Date().toISOString();
      }
      if (state.currentDevice?.deviceId === deviceId) {
        state.currentDevice.status = status;
        if (telemetry) {
          state.currentDevice.telemetry = { ...state.currentDevice.telemetry, ...telemetry };
        }
        state.currentDevice.lastSeenAt = new Date().toISOString();
      }
    },
    setCurrentDeviceMeeting: (state, action) => {
      const { deviceId, meetingId } = action.payload;
      const device = state.items.find(d => d.deviceId === deviceId);
      if (device) {
        device.currentMeetingId = meetingId;
      }
      if (state.currentDevice?.deviceId === deviceId) {
        state.currentDevice.currentMeetingId = meetingId;
      }
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchDevices.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchDevices.fulfilled, (state, action) => {
        state.loading = false;
        state.items = action.payload;
      })
      .addCase(fetchDevices.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      })
      .addCase(fetchDeviceById.fulfilled, (state, action) => {
        state.currentDevice = action.payload;
      })
      .addCase(fetchDeviceStatus.fulfilled, (state, action) => {
        if (state.currentDevice?.deviceId === action.payload.deviceId) {
          state.currentDevice = { ...state.currentDevice, ...action.payload };
        }
      });
  },
});

export const { updateDeviceStatus, setCurrentDeviceMeeting } = devicesSlice.actions;
export default devicesSlice.reducer;
