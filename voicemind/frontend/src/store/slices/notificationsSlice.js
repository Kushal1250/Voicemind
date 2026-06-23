import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import api, { silentRequestConfig } from '../../services/api';

const STORAGE_KEY = 'voicemind_notifications_state_v4';
const VISIBLE_LIMIT = 300;
const CATEGORIES = ['all', 'system', 'device', 'meeting', 'qa', 'transcript'];

const DEFAULT_COUNTS = {
  all: 0,
  system: 0,
  device: 0,
  meeting: 0,
  qa: 0,
  transcript: 0,
};

const isMongoObjectId = (value) => /^[a-f\d]{24}$/i.test(String(value || ''));

const isCategory = (value) => CATEGORIES.includes(String(value || '').toLowerCase());

const normalizeCategory = (value) => {
  const candidate = String(value || '').trim().toLowerCase();
  return isCategory(candidate) && candidate !== 'all' ? candidate : 'system';
};

const normalizeSeverity = (value) => {
  const candidate = String(value || '').trim().toLowerCase();
  if (['success', 'info', 'warning', 'error', 'critical'].includes(candidate)) {
    return candidate;
  }
  return 'info';
};

const readStorage = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {
        items: [],
        unreadCount: 0,
        dismissedIds: [],
        countsByType: { ...DEFAULT_COUNTS },
        selectedNotificationId: null,
      };
    }

    const parsed = JSON.parse(raw);
    return {
      items: Array.isArray(parsed.items) ? parsed.items : [],
      unreadCount: Number(parsed.unreadCount || 0),
      dismissedIds: Array.isArray(parsed.dismissedIds) ? parsed.dismissedIds : [],
      countsByType: {
        ...DEFAULT_COUNTS,
        ...(parsed.countsByType || {}),
      },
      selectedNotificationId: parsed.selectedNotificationId || null,
    };
  } catch {
    return {
      items: [],
      unreadCount: 0,
      dismissedIds: [],
      countsByType: { ...DEFAULT_COUNTS },
      selectedNotificationId: null,
    };
  }
};

const persistStorage = (state) => {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        items: state.items,
        unreadCount: state.unreadCount,
        dismissedIds: state.dismissedIds,
        countsByType: state.countsByType,
        selectedNotificationId: state.selectedNotificationId,
      })
    );
  } catch {
    // ignore storage write failures
  }
};

const safeEncode = (value) => {
  try {
    return btoa(unescape(encodeURIComponent(String(value || '')))).replace(/=+$/g, '');
  } catch {
    return String(value || '')
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 160);
  }
};

const makeNotificationFingerprint = (notification = {}) => {
  if (notification._id) return `db:${String(notification._id)}`;
  if (notification.id) return `db:${String(notification.id)}`;
  if (notification.localId && !String(notification.localId).startsWith('local_')) {
    return String(notification.localId);
  }
  if (notification.dedupeKey) {
    return `dedupe:${String(notification.dedupeKey)}`;
  }

  const base = [
    normalizeCategory(notification.type || notification.category),
    normalizeSeverity(notification.severity),
    notification.meetingId || '',
    notification.deviceId || '',
    notification.service || '',
    notification.source || '',
    notification.title || '',
    notification.message || '',
    notification.link?.path || '',
  ].join('|');

  return `fingerprint:${safeEncode(base)}`;
};

const makeNotificationId = (notification = {}) => {
  if (notification._id) return String(notification._id);
  if (notification.id) return String(notification.id);
  return makeNotificationFingerprint(notification);
};

export const isNotificationRead = (notification) => {
  return Array.isArray(notification?.readBy) && notification.readBy.length > 0;
};

export const normalizeNotification = (notification = {}) => {
  const createdAt =
    notification.createdAt ||
    notification.at ||
    notification.timestamp ||
    notification.updatedAt ||
    new Date().toISOString();

  const type = normalizeCategory(notification.type || notification.category);
  const severity = normalizeSeverity(notification.severity);
  const readBy = Array.isArray(notification.readBy) ? notification.readBy : [];
  const localId = makeNotificationId({ ...notification, createdAt, type, severity });

  return {
    ...notification,
    _id: notification._id || null,
    localId,
    fingerprint: makeNotificationFingerprint({ ...notification, createdAt, type, severity }),
    type,
    category: type,
    severity,
    service: notification.service || null,
    source: notification.source || notification.service || type,
    title: notification.title || 'Notification',
    message: notification.message || '',
    createdAt,
    readBy,
    meta: notification.meta && typeof notification.meta === 'object' ? notification.meta : {},
    dismissed: Boolean(notification.dismissed),
    link: notification.link || null,
  };
};

const sortNotifications = (items = []) => {
  return [...items].sort((a, b) => {
    const aTime = new Date(a.createdAt || 0).getTime() || 0;
    const bTime = new Date(b.createdAt || 0).getTime() || 0;
    return bTime - aTime;
  });
};

const recomputeUnreadCount = (items = [], dismissedIds = []) => {
  const dismissedSet = new Set(dismissedIds);
  return items.filter(
    (item) => !dismissedSet.has(item.localId) && !item.dismissed && !isNotificationRead(item)
  ).length;
};

const recomputeCountsByType = (items = [], dismissedIds = []) => {
  const dismissedSet = new Set(dismissedIds);
  const visibleItems = items.filter((item) => !dismissedSet.has(item.localId) && !item.dismissed);

  const counts = { ...DEFAULT_COUNTS, all: visibleItems.length };
  visibleItems.forEach((item) => {
    const type = normalizeCategory(item.type);
    counts[type] = Number(counts[type] || 0) + 1;
  });

  return counts;
};

const mergeNotifications = (existing = [], incoming = [], dismissedIds = []) => {
  const map = new Map();

  existing.forEach((item) => {
    const normalized = normalizeNotification(item);
    map.set(normalized.localId, normalized);
  });

  incoming.forEach((item) => {
    const normalized = normalizeNotification(item);
    const previous =
      map.get(normalized.localId) ||
      Array.from(map.values()).find(
        (candidate) =>
          candidate.localId === normalized.localId ||
          candidate.fingerprint === normalized.fingerprint ||
          (normalized.dedupeKey && candidate.dedupeKey === normalized.dedupeKey)
      );

    const merged = {
      ...(previous || {}),
      ...normalized,
      createdAt: normalized.createdAt || previous?.createdAt || new Date().toISOString(),
      readBy:
        Array.isArray(previous?.readBy) && previous.readBy.length > 0
          ? previous.readBy
          : normalized.readBy,
      dismissed:
        Boolean(previous?.dismissed) ||
        Boolean(normalized.dismissed) ||
        dismissedIds.includes(normalized.localId),
    };

    map.set(merged.localId, merged);
  });

  return sortNotifications(Array.from(map.values())).slice(0, VISIBLE_LIMIT);
};

const persisted = typeof window !== 'undefined' ? readStorage() : null;
const hydratedDismissedIds = Array.from(new Set((persisted?.dismissedIds || []).map((id) => String(id))));
const hydratedItems = mergeNotifications([], persisted?.items || [], hydratedDismissedIds);

const initialState = {
  items: hydratedItems,
  unreadCount: recomputeUnreadCount(hydratedItems, hydratedDismissedIds),
  countsByType: recomputeCountsByType(hydratedItems, hydratedDismissedIds),
  loading: false,
  hasFetchedOnce: false,
  error: null,
  filter: 'all',
  connectionStatus: 'disconnected',
  dedupeCache: {},
  selectedNotificationId: persisted?.selectedNotificationId || null,
  dismissedIds: hydratedDismissedIds,
};

export const fetchNotifications = createAsyncThunk(
  'notifications/fetchNotifications',
  async (params, { rejectWithValue }) => {
    try {
      const response = await api.get('/notifications', {
        params,
        ...silentRequestConfig,
      });
      return response.data.data;
    } catch (error) {
      return rejectWithValue(
        error.response?.data?.error?.message || error.message || 'Failed to fetch notifications'
      );
    }
  }
);

export const markAsRead = createAsyncThunk(
  'notifications/markAsRead',
  async (id, { rejectWithValue }) => {
    try {
      if (!id) return null;
      if (!isMongoObjectId(id)) {
        return { id, localOnly: true };
      }
      await api.post(`/notifications/${id}/read`, {}, silentRequestConfig);
      return { id, localOnly: false };
    } catch (error) {
      return rejectWithValue(
        error.response?.data?.error?.message || error.message || 'Failed to mark as read'
      );
    }
  }
);

export const markAllAsRead = createAsyncThunk(
  'notifications/markAllAsRead',
  async (_, { rejectWithValue }) => {
    try {
     await api.post('/notifications/read-all', {}, silentRequestConfig);   
      return true;
    } catch (error) {
      return rejectWithValue(
        error.response?.data?.error?.message || error.message || 'Failed to mark all as read'
      );
    }
  }
);

export const clearAllNotificationsRemote = createAsyncThunk(
  'notifications/clearAllNotificationsRemote',
  async (filter = 'all', { rejectWithValue }) => {
    try {
      await api.post('/notifications/clear-all', { filter }, silentRequestConfig);
      return filter;
    } catch (error) {
      return rejectWithValue(
        error.response?.data?.error?.message || error.message || 'Failed to clear notifications'
      );
    }
  }
);

export const buildSystemNotification = (message, extra = {}) =>
  normalizeNotification({
    type: extra.type || 'system',
    severity: extra.severity || 'warning',
    title: extra.title || 'Notification Center',
    message,
    source: extra.source || 'frontend',
    service: extra.service || null,
    dedupeKey: extra.dedupeKey || `${extra.type || 'system'}:${message}`,
    createdAt: extra.createdAt || new Date().toISOString(),
    link: extra.link || null,
    meta: extra.meta || {},
  });

const notificationsSlice = createSlice({
  name: 'notifications',
  initialState,
  reducers: {
    setFilter: (state, action) => {
      const nextFilter = String(action.payload || 'all').toLowerCase();
      state.filter = isCategory(nextFilter) ? nextFilter : 'all';
      persistStorage(state);
    },

    addNotification: (state, action) => {
      const notification = normalizeNotification(action.payload || {});

      if (notification.dedupeKey && state.dedupeCache[notification.dedupeKey]) {
        const lastTime = state.dedupeCache[notification.dedupeKey];
        if (Date.now() - lastTime < 15000) {
          return;
        }
      }

      if (state.dismissedIds.includes(notification.localId)) {
        return;
      }

      const existingIndex = state.items.findIndex(
        (item) =>
          item.localId === notification.localId ||
          item.fingerprint === notification.fingerprint ||
          (notification.dedupeKey && item.dedupeKey === notification.dedupeKey)
      );

      if (existingIndex >= 0) {
        const previous = state.items[existingIndex];
        state.items[existingIndex] = {
          ...previous,
          ...notification,
          createdAt: notification.createdAt || previous.createdAt,
          readBy: previous.readBy?.length > 0 ? previous.readBy : notification.readBy,
          dismissed: Boolean(previous.dismissed),
        };
      } else {
        state.items.unshift(notification);
      }

      state.items = sortNotifications(state.items).slice(0, VISIBLE_LIMIT);
      state.unreadCount = recomputeUnreadCount(state.items, state.dismissedIds);
      state.countsByType = recomputeCountsByType(state.items, state.dismissedIds);

      if (notification.dedupeKey) {
        state.dedupeCache[notification.dedupeKey] = Date.now();
      }

      persistStorage(state);
    },

    markLocalAsRead: (state, action) => {
      const id = action.payload;
      const notification = state.items.find((item) => item.localId === id || item._id === id);

      if (notification && !isNotificationRead(notification)) {
        notification.readBy = ['local-read'];
      }

      state.unreadCount = recomputeUnreadCount(state.items, state.dismissedIds);
      persistStorage(state);
    },

    dismissNotification: (state, action) => {
      const id = action.payload;
      const notification = state.items.find((item) => item.localId === id || item._id === id);

      if (notification) {
        notification.dismissed = true;
        if (!state.dismissedIds.includes(notification.localId)) {
          state.dismissedIds.push(notification.localId);
        }
      }

      if (state.selectedNotificationId === id) {
        state.selectedNotificationId = null;
      }

      state.unreadCount = recomputeUnreadCount(state.items, state.dismissedIds);
      state.countsByType = recomputeCountsByType(state.items, state.dismissedIds);
      persistStorage(state);
    },

    clearAllNotificationsLocal: (state, action) => {
      const filter = String(action.payload || 'all').toLowerCase();
      state.items.forEach((item) => {
        if (filter !== 'all' && item.type !== filter) {
          return;
        }
        item.dismissed = true;
        if (!state.dismissedIds.includes(item.localId)) {
          state.dismissedIds.push(item.localId);
        }
      });

      state.selectedNotificationId = null;
      state.unreadCount = recomputeUnreadCount(state.items, state.dismissedIds);
      state.countsByType = recomputeCountsByType(state.items, state.dismissedIds);
      persistStorage(state);
    },

    selectNotification: (state, action) => {
      state.selectedNotificationId = action.payload || null;
      persistStorage(state);
    },

    setConnectionStatus: (state, action) => {
      state.connectionStatus = action.payload;
      persistStorage(state);
    },

    clearDedupeCache: (state) => {
      state.dedupeCache = {};
      persistStorage(state);
    },

    updateUnreadCount: (state, action) => {
      state.unreadCount = Number(action.payload || 0);
      persistStorage(state);
    },

    applyRemoteCounts: (state, action) => {
      state.unreadCount = Number(action.payload?.unreadCount || 0);
      state.countsByType = { ...DEFAULT_COUNTS, ...(action.payload?.countsByType || {}) };
      persistStorage(state);
    },
  },

  extraReducers: (builder) => {
    builder
      .addCase(fetchNotifications.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchNotifications.fulfilled, (state, action) => {
        state.loading = false;
        state.hasFetchedOnce = true;

        const incomingItems = Array.isArray(action.payload?.items) ? action.payload.items : [];
        state.items = mergeNotifications(state.items, incomingItems, state.dismissedIds);
        state.unreadCount =
          typeof action.payload?.unreadCount === 'number'
            ? action.payload.unreadCount
            : recomputeUnreadCount(state.items, state.dismissedIds);
        state.countsByType = { ...DEFAULT_COUNTS, ...(action.payload?.countsByType || recomputeCountsByType(state.items, state.dismissedIds)) };
        persistStorage(state);
      })
      .addCase(fetchNotifications.rejected, (state, action) => {
        state.loading = false;
        state.hasFetchedOnce = true;
        state.error = action.payload || 'Failed to fetch notifications';

        const fallbackMessage =
          typeof state.error === 'string' ? state.error : 'Unable to load notifications.';
        const networkNotification = buildSystemNotification(fallbackMessage, {
          title: 'Notification Center Offline',
          dedupeKey: 'notification-center-offline',
          severity: 'warning',
        });

        const existingIndex = state.items.findIndex(
          (item) =>
            item.localId === networkNotification.localId ||
            item.dedupeKey === networkNotification.dedupeKey
        );

        if (existingIndex >= 0) {
          state.items[existingIndex] = {
            ...state.items[existingIndex],
            ...networkNotification,
            readBy: state.items[existingIndex].readBy || [],
            dismissed: Boolean(state.items[existingIndex].dismissed),
          };
        } else if (!state.dismissedIds.includes(networkNotification.localId)) {
          state.items.unshift(networkNotification);
        }

        state.items = sortNotifications(state.items).slice(0, VISIBLE_LIMIT);
        state.unreadCount = recomputeUnreadCount(state.items, state.dismissedIds);
        state.countsByType = recomputeCountsByType(state.items, state.dismissedIds);
        persistStorage(state);
      })
      .addCase(markAsRead.fulfilled, (state, action) => {
        const payload = action.payload;
        if (!payload?.id) return;

        const notification = state.items.find((n) => n._id === payload.id || n.localId === payload.id);
        if (notification && !isNotificationRead(notification)) {
          notification.readBy = [payload.localOnly ? 'local-read' : 'server-read'];
        }

        state.unreadCount = recomputeUnreadCount(state.items, state.dismissedIds);
        persistStorage(state);
      })
      .addCase(markAllAsRead.fulfilled, (state) => {
        state.items.forEach((item) => {
          if (!item.dismissed) {
            item.readBy = ['server-read'];
          }
        });
        state.unreadCount = 0;
        persistStorage(state);
      })
      .addCase(clearAllNotificationsRemote.fulfilled, (state, action) => {
        const filter = String(action.payload || 'all').toLowerCase();
        state.items.forEach((item) => {
          if (filter !== 'all' && item.type !== filter) {
            return;
          }
          item.dismissed = true;
          if (!state.dismissedIds.includes(item.localId)) {
            state.dismissedIds.push(item.localId);
          }
        });
        state.selectedNotificationId = null;
        state.unreadCount = recomputeUnreadCount(state.items, state.dismissedIds);
        state.countsByType = recomputeCountsByType(state.items, state.dismissedIds);
        persistStorage(state);
      });
  },
});

export const {
  setFilter,
  addNotification,
  markLocalAsRead,
  dismissNotification,
  clearAllNotificationsLocal,
  selectNotification,
  setConnectionStatus,
  clearDedupeCache,
  updateUnreadCount,
  applyRemoteCounts,
} = notificationsSlice.actions;

export const addSystemNotification = (message, extra = {}) => (dispatch) => {
  dispatch(addNotification(buildSystemNotification(message, extra)));
};

export default notificationsSlice.reducer;
