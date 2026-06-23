const Notification = require('../models/Notification');
const eventBus = require('./eventBus');

let initialized = false;
const RECENT_WINDOW_MS = 60 * 1000;

function isRecent(dateValue) {
  const time = new Date(dateValue).getTime();
  if (!time) return false;
  return Date.now() - time < RECENT_WINDOW_MS;
}

/**
 * After saving a notification, push it to every connected SSE client.
 * Respects each user's notification type preferences — if a user has disabled
 * the notification type, we skip the push entirely for that user.
 * We lazy-require the routes file to avoid circular dependency at startup.
 */
async function broadcastNotification(doc) {
  try {
    const notifRoutes = require('../routes/notifications.routes');
    const { pushNotificationCreated, sseClients } = notifRoutes;
    const User = require('../models/User');

    if (typeof pushNotificationCreated !== 'function' || !sseClients) return;

    for (const userId of sseClients.keys()) {
      try {
        // Check if this user has this notification type enabled
        const userDoc = await User.findById(userId).select('preferences').lean();
        const notifPrefs = userDoc?.preferences?.notifications || {};
        if (notifPrefs[doc.type] === false) {
          // Type disabled — still push updated counts so badge stays accurate
          const { pushCounts } = notifRoutes;
          if (typeof pushCounts === 'function') {
            await pushCounts(userId, userDoc?.preferences);
          }
          continue;
        }
        await pushNotificationCreated(userId, doc);
      } catch (_) {
        // Skip this user on error — don't break other users
      }
    }
  } catch (_) {
    // Non-fatal — SSE broadcast failure must never break the main flow
  }
}

async function createUniqueNotification(payload) {
  try {
    if (!payload?.title || !payload?.message || !payload?.type) return;

    const dedupeKey = payload.dedupeKey || null;

    if (dedupeKey) {
      const existing = await Notification.findOne({ dedupeKey }).sort({ createdAt: -1 }).lean();
      if (existing && isRecent(existing.createdAt)) return;
    }

    const doc = await Notification.create({
      type: payload.type,
      severity: payload.severity || 'info',
      title: payload.title,
      message: payload.message,
      meetingId: payload.meetingId || null,
      deviceId: payload.deviceId || null,
      link: payload.link || { path: null, label: null },
      dedupeKey,
      readBy: [],
      clearedBy: [],
    });

    // Push live to all connected SSE clients
    await broadcastNotification(doc.toObject ? doc.toObject() : doc);
  } catch (error) {
    console.error('❌ Failed to create notification:', error.message);
  }
}

function initNotificationPublisher() {
  if (initialized) return;
  initialized = true;

  eventBus.on('device_online', async (data = {}) => {
    await createUniqueNotification({
      type: 'device', severity: 'info',
      title: 'Device connected',
      message: `Device ${data.deviceId || 'Unknown device'} is online.`,
      deviceId: data.deviceId || null,
      dedupeKey: `device_online:${data.deviceId || 'unknown'}`,
      link: data.deviceId ? { path: `/devices/${data.deviceId}`, label: 'View device' } : undefined,
    });
  });

  eventBus.on('device_offline', async (data = {}) => {
    await createUniqueNotification({
      type: 'device', severity: 'warning',
      title: 'Device offline',
      message: `Device ${data.deviceId || 'Unknown device'} went offline.`,
      deviceId: data.deviceId || null,
      dedupeKey: `device_offline:${data.deviceId || 'unknown'}`,
      link: data.deviceId ? { path: `/devices/${data.deviceId}`, label: 'View device' } : undefined,
    });
  });

  eventBus.on('recording_started', async (data = {}) => {
    await createUniqueNotification({
      type: 'meeting', severity: 'info',
      title: 'Meeting started',
      message: `Recording started for meeting ${data.meetingId || 'Unknown'}.`,
      meetingId: data.meetingId || null, deviceId: data.deviceId || null,
      dedupeKey: `recording_started:${data.meetingId || 'unknown'}`,
      link: data.meetingId ? { path: `/meetings/${data.meetingId}`, label: 'Open meeting' } : undefined,
    });
  });

  eventBus.on('recording_stopped', async (data = {}) => {
    await createUniqueNotification({
      type: 'meeting',
      severity: data.reason === 'device_offline' ? 'warning' : 'info',
      title: data.reason === 'device_offline' ? 'Meeting stopped unexpectedly' : 'Meeting stopped',
      message: data.reason === 'device_offline'
        ? `Meeting ${data.meetingId || 'Unknown'} stopped because the device went offline.`
        : `Recording stopped for meeting ${data.meetingId || 'Unknown'}.`,
      meetingId: data.meetingId || null, deviceId: data.deviceId || null,
      dedupeKey: `recording_stopped:${data.meetingId || 'unknown'}:${data.reason || 'manual'}`,
      link: data.meetingId ? { path: `/meetings/${data.meetingId}`, label: 'Open meeting' } : undefined,
    });
  });

  eventBus.on('meeting_status_changed', async (data = {}) => {
    const status = String(data.status || '').toLowerCase();
    if (!['processing', 'done', 'completed', 'error', 'failed'].includes(status)) return;

    let title = 'Meeting updated';
    let severity = 'info';
    let message = `Meeting ${data.meetingId || 'Unknown'} status changed to ${status}.`;

    if (status === 'processing') { title = 'Transcript processing'; message = `Transcript processing started for meeting ${data.meetingId || 'Unknown'}.`; }
    else if (status === 'done' || status === 'completed') { title = 'Transcript ready'; message = `Transcript is ready for meeting ${data.meetingId || 'Unknown'}.`; }
    else if (status === 'error' || status === 'failed') { title = 'Meeting failed'; severity = 'critical'; message = `Meeting ${data.meetingId || 'Unknown'} failed during processing.`; }

    await createUniqueNotification({
      type: 'meeting', severity, title, message,
      meetingId: data.meetingId || null, deviceId: data.deviceId || null,
      dedupeKey: `meeting_status:${data.meetingId || 'unknown'}:${status}`,
      link: data.meetingId ? { path: `/meetings/${data.meetingId}`, label: 'Open meeting' } : undefined,
    });
  });

  // ── Backend connectivity system notifications ──────────────────────────
  eventBus.on('backend_offline', async (data = {}) => {
    await createUniqueNotification({
      type: 'system',
      severity: 'warning',
      title: 'Backend offline',
      message: data.message || 'The backend service is unreachable. Live updates are paused.',
      dedupeKey: 'backend-offline',
      link: null,
    });
  });

  eventBus.on('backend_online', async (data = {}) => {
    await createUniqueNotification({
      type: 'system',
      severity: 'info',
      title: 'Backend online',
      message: data.message || 'Backend connection restored. Live updates are active.',
      dedupeKey: 'backend-online',
      link: null,
    });
  });

  eventBus.on('chunk_failed', async (data = {}) => {
    await createUniqueNotification({
      type: 'meeting',
      severity: 'warning',
      title: 'Chunk upload failed',
      message: data.error || `Chunk ${data.chunkIndex ?? ''} failed to upload for meeting ${data.meetingId || 'Unknown'}.`,
      meetingId: data.meetingId || null,
      deviceId: data.deviceId || null,
      dedupeKey: `chunk_failed:${data.meetingId || 'unknown'}:${data.chunkIndex || 0}`,
      link: data.meetingId ? { path: `/meetings/${data.meetingId}`, label: 'Open meeting' } : undefined,
    });
  });

  eventBus.on('system_warning', async (data = {}) => {
    await createUniqueNotification({
      type: 'system',
      severity: 'warning',
      title: data.title || 'System warning',
      message: data.message || 'System warning detected.',
      dedupeKey: data.dedupeKey || `system_warning:${data.code || Date.now()}`,
      link: { path: `/system-health?error=${encodeURIComponent(data.code || 'system-warning')}`, label: 'View details' },
    });
  });

  eventBus.on('system_error', async (data = {}) => {
    await createUniqueNotification({
      type: 'system',
      severity: 'critical',
      title: data.title || 'System error',
      message: data.message || 'System error detected.',
      dedupeKey: data.dedupeKey || `system_error:${data.code || Date.now()}`,
      link: { path: `/system-health?error=${encodeURIComponent(data.code || 'system-error')}`, label: 'View details' },
    });
  });

  // ── API / Server error system notifications (emitted from error handler) ──
  eventBus.on('server_error', async (data = {}) => {
    await createUniqueNotification({
      type: 'system',
      severity: 'critical',
      title: data.title || 'Server error',
      message: data.message || 'An unexpected server error occurred.',
      dedupeKey: data.dedupeKey || `server-error-${Date.now()}`,
      link: { path: `/system-health?error=${encodeURIComponent(data.code || 'server-error')}`, label: 'View details' },
    });
  });

  console.log('🔔 Notification publisher initialized');
}

module.exports = { initNotificationPublisher };