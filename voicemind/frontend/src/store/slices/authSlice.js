import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import api from '../../services/api';
import { getDisplayName } from '../../utils/userDisplay';

const USER_STORAGE_KEY = 'voicemind_user';
const TOKEN_STORAGE_KEY = 'voicemind_token';

const readStoredUser = () => {
  try {
    const raw = localStorage.getItem(USER_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const normalizeUser = (user) => {
  if (!user || typeof user !== 'object') return null;

  const displayName = getDisplayName(user);

  return {
    ...user,
    displayName,
    name: user.name || displayName,
    fullName: user.fullName || displayName,
    username: user.username || (typeof user.email === 'string' ? user.email.split('@')[0] : displayName),
  };
};

const persistAuth = ({ token, user }) => {
  if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
  if (user) localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(normalizeUser(user)));
};

const clearPersistedAuth = () => {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  localStorage.removeItem(USER_STORAGE_KEY);
};

const initialState = {
  user: normalizeUser(readStoredUser()),
  token: localStorage.getItem(TOKEN_STORAGE_KEY) || null,
  isAuthenticated: !!localStorage.getItem(TOKEN_STORAGE_KEY),
  loading: false,
  error: null,
  initialized: false,
};

export const login = createAsyncThunk(
  'auth/login',
  async (credentials, { rejectWithValue }) => {
    try {
      const response = await api.post('/auth/login', credentials);
      const { token, user } = response.data.data;
      const normalizedUser = normalizeUser(user);
      persistAuth({ token, user: normalizedUser });
      return { token, user: normalizedUser };
    } catch (error) {
      return rejectWithValue(error.response?.data?.error?.message || 'Login failed');
    }
  }
);

export const signup = createAsyncThunk(
  'auth/signup',
  async (userData, { rejectWithValue }) => {
    try {
      const response = await api.post('/auth/signup', userData);
      const { token, user } = response.data.data;
      const normalizedUser = normalizeUser(user);
      persistAuth({ token, user: normalizedUser });
      return { token, user: normalizedUser };
    } catch (error) {
      return rejectWithValue(error.response?.data?.error?.message || 'Signup failed');
    }
  }
);

export const fetchMe = createAsyncThunk(
  'auth/fetchMe',
  async (_, { rejectWithValue }) => {
    try {
      const response = await api.get('/auth/me');
      return normalizeUser(response.data.data);
    } catch (error) {
      return rejectWithValue(error.response?.data?.error?.message || 'Failed to fetch user');
    }
  }
);

export const updateProfile = createAsyncThunk(
  'auth/updateProfile',
  async (profileData, { rejectWithValue }) => {
    try {
      const response = await api.put('/auth/me', profileData);
      return normalizeUser(response.data.data);
    } catch (error) {
      return rejectWithValue(error.response?.data?.error?.message || 'Update failed');
    }
  }
);

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    logout: (state) => {
      state.user = null;
      state.token = null;
      state.isAuthenticated = false;
      state.initialized = true;
      clearPersistedAuth();
    },
    clearError: (state) => {
      state.error = null;
    },
    hydrateUserFromStorage: (state) => {
      state.user = normalizeUser(readStoredUser());
      state.token = localStorage.getItem(TOKEN_STORAGE_KEY) || null;
      state.isAuthenticated = !!state.token;
      state.initialized = true;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(login.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(login.fulfilled, (state, action) => {
        state.loading = false;
        state.user = action.payload.user;
        state.token = action.payload.token;
        state.isAuthenticated = true;
        state.initialized = true;
      })
      .addCase(login.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
        state.initialized = true;
      })
      .addCase(signup.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(signup.fulfilled, (state, action) => {
        state.loading = false;
        state.user = action.payload.user;
        state.token = action.payload.token;
        state.isAuthenticated = true;
        state.initialized = true;
      })
      .addCase(signup.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
        state.initialized = true;
      })
      .addCase(fetchMe.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchMe.fulfilled, (state, action) => {
        state.loading = false;
        state.user = action.payload;
        state.isAuthenticated = true;
        state.initialized = true;
        persistAuth({ token: state.token, user: action.payload });
      })
      .addCase(fetchMe.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
        state.initialized = true;
      })
      .addCase(updateProfile.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(updateProfile.fulfilled, (state, action) => {
        state.loading = false;
        state.user = action.payload;
        state.initialized = true;
        persistAuth({ token: state.token, user: action.payload });
      })
      .addCase(updateProfile.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
        state.initialized = true;
      });
  },
});

export const { logout, clearError, hydrateUserFromStorage } = authSlice.actions;
export default authSlice.reducer;
