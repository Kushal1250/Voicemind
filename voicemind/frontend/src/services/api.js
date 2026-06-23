import axios from 'axios';
import { toast } from 'react-toastify';

const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || 'http://localhost:5001/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 60000,
  headers: {
    'Content-Type': 'application/json',
  },
});

const TOAST_COOLDOWN_MS = 8000;
const toastSeen = new Map();

function canShowToast(key) {
  const now = Date.now();
  const last = toastSeen.get(key) || 0;
  if (now - last < TOAST_COOLDOWN_MS) return false;
  toastSeen.set(key, now);
  return true;
}

function showToastOnce(key, type, message) {
  const toastId = `voicemind-${key}`;
  if (!canShowToast(key) || toast.isActive(toastId)) return;
  toast[type](message, { toastId });
}


function emitGlobalNotification(payload) {
  if (typeof window === 'undefined' || !window.dispatchEvent) return;
  window.dispatchEvent(new CustomEvent('voicemind:notification', { detail: payload }));
}

function pushSystemNotification({ title, message, severity = 'warning', dedupeKey, link = null }) {
  emitGlobalNotification({
    type: 'system',
    severity,
    title,
    message,
    dedupeKey,
    createdAt: new Date().toISOString(),
    link,
  });
}

api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('voicemind_token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const { response, request, config } = error;
    const suppressGlobalErrorToast = Boolean(config?.suppressGlobalErrorToast);

    if (response) {
      const message =
        response?.data?.error?.message ||
        response?.data?.message ||
        `Request failed with status ${response.status}`;

      if (response.status === 401) {
        localStorage.removeItem('voicemind_token');
        localStorage.removeItem('voicemind_user');

        if (!suppressGlobalErrorToast) {
          showToastOnce('session-expired', 'error', 'Session expired. Please login again.');
          pushSystemNotification({
            title: 'Session expired',
            message: 'Your session expired. Please login again.',
            severity: 'warning',
            dedupeKey: 'session-expired',
          });
        }

        if (window.location.pathname !== '/login') {
          window.location.href = '/login';
        }
      } else if (response.status === 403 && !suppressGlobalErrorToast) {
        showToastOnce('forbidden', 'error', 'You do not have permission to do that.');
        pushSystemNotification({ title: 'Access denied', message: 'You do not have permission to do that.', severity: 'warning', dedupeKey: 'http-403' });
      } else if (response.status === 404 && !suppressGlobalErrorToast) {
        showToastOnce('not-found', 'error', 'Requested resource was not found.');
        pushSystemNotification({ title: 'Resource not found', message: message || 'Requested resource was not found.', severity: 'warning', dedupeKey: `http-404:${config?.url || 'unknown'}` });
      } else if (response.status === 429 && !suppressGlobalErrorToast) {
        showToastOnce('rate-limit', 'warning', 'Too many requests. Please slow down.');
        pushSystemNotification({ title: 'Rate limit reached', message: 'Too many requests. Please slow down.', severity: 'warning', dedupeKey: 'http-429' });
      } else if (response.status >= 500 && !suppressGlobalErrorToast) {
        showToastOnce(`server-${response.status}`, 'error', message);
        pushSystemNotification({ title: 'Server error', message, severity: 'critical', dedupeKey: `http-${response.status}:${config?.url || 'unknown'}`, link: { path: `/system-health?error=${encodeURIComponent(`http-${response.status}`)}`, label: 'View details' } });
      }
    } else if (request && !suppressGlobalErrorToast) {
      showToastOnce('network-error', 'error', 'Network error. Please check your connection.');
      pushSystemNotification({ title: 'Network error', message: 'Network error. Please check your connection.', severity: 'warning', dedupeKey: 'network-error' });
    }

    return Promise.reject(error);
  }
);

export default api;

export const silentRequestConfig = {
  suppressGlobalErrorToast: true,
};

export const handleApiError = (error, fallbackMessage = 'Something went wrong') =>
  error?.response?.data?.error?.message ||
  error?.response?.data?.message ||
  error?.message ||
  fallbackMessage;

export const downloadBlobFile = (blob, filename) => {
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.URL.revokeObjectURL(url);
};

const fakeSuccess = (data = {}) =>
  Promise.resolve({
    data: {
      success: true,
      data,
    },
  });

export const meetingsApi = {
  create: (payload) => api.post('/meetings', payload),
  list: (params = {}) => api.get('/meetings', { params }),
  getById: (meetingId) => api.get(`/meetings/${meetingId}`),

  updateStatus: async (meetingId, payload = {}) => {
    const status = String(payload?.status || '').toLowerCase();

    if (status === 'ended' || status === 'done' || status === 'completed') {
      return api.post(`/meetings/${meetingId}/end`, payload);
    }

    if (status === 'recording') {
      return fakeSuccess({
        meetingId,
        status: 'recording',
        ...payload,
      });
    }

    if (status === 'uploading' || status === 'processing' || !status) {
      return fakeSuccess({
        meetingId,
        ...payload,
      });
    }

    return fakeSuccess({
      meetingId,
      ...payload,
    });
  },

  uploadFinal: (meetingId, formData) =>
    api.post(`/meetings/${meetingId}/upload`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 10 * 60 * 1000,
    }),

  uploadChunk: async (meetingId, chunkIndex, blob, params = {}) => {
    const mimeType = blob?.type || 'audio/webm';
    const basePayload = {
      chunkIndex: Number(chunkIndex ?? 0),
      mimeType,
      durationSec: Number(params?.durationSec ?? 0),
      chunkStartSec: Number(params?.chunkStartSec ?? 0),
      chunkEndSec: Number(params?.chunkEndSec ?? params?.chunkStartSec ?? 0),
      isFinalPartialChunk: Boolean(params?.isFinalPartialChunk),
      sizeBytes: Number(blob?.size || params?.sizeBytes || 0),
      checksum: params?.checksum || '',
      clientCapturedAt: params?.clientCapturedAt || new Date().toISOString(),
      uploadToken: params?.uploadToken || `${meetingId}-${chunkIndex}-${Date.now()}`,
    };

    if (process.env.REACT_APP_AUDIO_UPLOAD_DRIVER === 'r2') {
      try {
        const presign = await api.post(`/meetings/${meetingId}/chunks/presign`, basePayload, { timeout: 30000 });
        const uploadUrl = presign?.data?.data?.uploadUrl;
        const headers = presign?.data?.data?.headers || { 'Content-Type': mimeType };
        const r2Key = presign?.data?.data?.r2Key;
        if (!uploadUrl || !r2Key) throw new Error('Backend did not return a valid R2 presigned URL');

        await axios.put(uploadUrl, blob, { headers, timeout: 10 * 60 * 1000 });
        return api.post(`/meetings/${meetingId}/chunks/complete`, {
          ...basePayload,
          r2Key,
          storageProvider: 'r2',
        }, { timeout: 180000 });
      } catch (error) {
        if (process.env.REACT_APP_R2_STRICT === 'true') throw error;
        console.warn('[VoiceMind] R2 upload failed; falling back to local chunk upload.', error?.message || error);
      }
    }

    return api.post(`/meetings/${meetingId}/chunks`, blob, {
      headers: {
        'Content-Type': mimeType,
        'x-chunk-index': String(chunkIndex ?? 0),
        'x-duration-sec': String(params?.durationSec ?? 0),
        'x-chunk-start-sec': String(Number(params?.chunkStartSec ?? 0).toFixed(3)),
        'x-chunk-end-sec': String(Number(params?.chunkEndSec ?? params?.chunkStartSec ?? 0).toFixed(3)),
        'x-is-final-partial-chunk': String(Boolean(params?.isFinalPartialChunk)),
        'x-client-captured-at': basePayload.clientCapturedAt,
        'x-upload-token': basePayload.uploadToken,
      },
      timeout: 10 * 60 * 1000,
    });
  },

  finalize: (meetingId, payload = {}) => api.post(`/meetings/${meetingId}/end`, payload),
  remove: (meetingId) => api.delete(`/meetings/${meetingId}`),
};

export const transcriptsApi = {
  list: (params = {}) => api.get('/transcripts', { params }),
  getByMeetingId: (meetingId) => api.get(`/transcripts/${meetingId}`),
  getPlainText: (meetingId) =>
    api.get(`/transcripts/${meetingId}/plain-text`, { responseType: 'text' }),
  exportSrt: (meetingId) =>
    api.get(`/transcripts/${meetingId}/export/srt`, { responseType: 'blob' }),
  updateSummary: (meetingId, payload) => api.patch(`/transcripts/${meetingId}/summary`, payload),
  getSummary: (meetingId) => api.get(`/transcripts/${meetingId}/summary`),
  generateSummary: (meetingId, force = false) => api.post(`/transcripts/${meetingId}/generate-summary`, { force }),
  rebuild: (meetingId) => api.post(`/transcripts/${meetingId}/rebuild-fulltext`),
};

export const devicesApi = {
  list: () => api.get('/devices'),
  getById: (deviceId) => api.get(`/devices/${deviceId}`),
};

export const systemApi = {
  status: () => api.get('/system/status'),
  health: () => api.get('/health'),
};

export const authApi = {
  login: (payload) => api.post('/auth/login', payload),
  signup: (payload) => api.post('/auth/signup', payload),
  me: () => api.get('/auth/me'),
};