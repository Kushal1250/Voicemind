import { configureStore } from '@reduxjs/toolkit';
import authReducer from './slices/authSlice';
import meetingsReducer from './slices/meetingsSlice';
import devicesReducer from './slices/devicesSlice';
import liveStatusReducer from './slices/liveStatusSlice';
import transcriptsReducer from './slices/transcriptsSlice';
import qaReducer from './slices/qaSlice';
import analyticsReducer from './slices/analyticsSlice';
import notificationsReducer from './slices/notificationsSlice';
import uiReducer from './slices/uiSlice';

export const store = configureStore({
  reducer: {
    auth: authReducer,
    meetings: meetingsReducer,
    devices: devicesReducer,
    liveStatus: liveStatusReducer,
    transcripts: transcriptsReducer,
    qa: qaReducer,
    analytics: analyticsReducer,
    notifications: notificationsReducer,
    ui: uiReducer,
  },
});

export default store;