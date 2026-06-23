import { useEffect, useRef, useCallback } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  addNotification,
  updateUnreadCount,
  applyRemoteCounts,
  setConnectionStatus,
  addSystemNotification,
} from '../store/slices/notificationsSlice';

const NOTIF_SSE_URL =
  process.env.REACT_APP_API_BASE_URL?.replace('/api', '') + '/api/notifications/stream' ||
  'http://localhost:5001/api/notifications/stream';

/**
 * useNotificationStream
 *
 * Opens a dedicated SSE connection to /api/notifications/stream so the bell
 * badge and notification panel update in real-time without polling.
 *
 * Events handled:
 *  • connected         — server confirms stream is open
 *  • notification_created — new notification pushed; adds it to Redux store
 *  • counts_updated    — badge counts refreshed after read/clear actions
 *
 * The connection is only opened when the user is authenticated.
 * It auto-reconnects with a 5 s delay on error / close.
 */
export const useNotificationStream = () => {
  const dispatch = useDispatch();
  const { isAuthenticated } = useSelector((state) => state.auth);
  const token = useSelector((state) => state.auth.token);
  // Read user's notification type preferences so SSE events are filtered before hitting Redux
  const notifPrefs = useSelector((state) => state.auth.user?.preferences?.notifications);

  const esRef = useRef(null);
  const reconnectRef = useRef(null);
  const mountedRef = useRef(true);
  // Track disconnect so we only fire one notification per outage and one recovery
  const wasDisconnectedRef = useRef(false);

  const close = useCallback(() => {
    if (esRef.current) {
      try { esRef.current.close(); } catch (_) {}
      esRef.current = null;
    }
    if (reconnectRef.current) {
      clearTimeout(reconnectRef.current);
      reconnectRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;
    if (esRef.current) return; // already open

    // Append token as query param because EventSource doesn't support headers
    const url = `${NOTIF_SSE_URL}?token=${encodeURIComponent(token || '')}`;

    try {
      const es = new EventSource(url);
      esRef.current = es;

      es.addEventListener('connected', () => {
        dispatch(setConnectionStatus('connected'));
        // If we had previously disconnected, notify the user the backend is back
        if (wasDisconnectedRef.current) {
          wasDisconnectedRef.current = false;
          dispatch(addSystemNotification('Backend connection restored. Live updates are active again.', {
            title: 'Backend online',
            severity: 'info',
            dedupeKey: 'backend-online',
          }));
        }
      });

      es.addEventListener('notification_created', (event) => {
        try {
          const data = JSON.parse(event.data);
          // Only dispatch if user has this notification type enabled (default: on)
          const prefs = notifPrefs || {};
          const typeEnabled = prefs[data.type] !== false;
          if (typeEnabled) {
            dispatch(addNotification(data));
          }
        } catch (_) {}
      });

      es.addEventListener('counts_updated', (event) => {
        try {
          const data = JSON.parse(event.data);
          if (typeof data.unreadCount === 'number') {
            dispatch(updateUnreadCount(data.unreadCount));
          }
          if (data?.countsByType) {
            dispatch(applyRemoteCounts(data));
          }
        } catch (_) {}
      });

      es.onerror = () => {
        close();
        if (!mountedRef.current) return;
        // Only fire one notification per outage
        if (!wasDisconnectedRef.current) {
          wasDisconnectedRef.current = true;
          dispatch(setConnectionStatus('disconnected'));
          dispatch(addSystemNotification('Lost connection to the backend. Live updates are paused — attempting to reconnect…', {
            title: 'Backend offline',
            severity: 'warning',
            dedupeKey: 'backend-offline',
          }));
        }
        // Reconnect after 5 s
        reconnectRef.current = setTimeout(() => {
          if (mountedRef.current) connect();
        }, 5000);
      };
    } catch (_) {
      // EventSource creation failed (e.g. bad URL) — retry after 5 s
      reconnectRef.current = setTimeout(() => {
        if (mountedRef.current) connect();
      }, 5000);
    }
  }, [dispatch, token, close, notifPrefs]);

  useEffect(() => {
    mountedRef.current = true;

    if (isAuthenticated && token) {
      connect();
    } else {
      close();
    }

    return () => {
      mountedRef.current = false;
      close();
    };
  }, [isAuthenticated, token, connect, close]);
};

export default useNotificationStream;