const express = require('express');
const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const { auth } = require('../middleware/auth');

const router = express.Router();
const NOTIFICATION_TYPES = ['system', 'device', 'meeting', 'qa', 'transcript'];

// ---------------------------------------------------------------------------
// SSE client registry  { userId (string) -> Set<res> }
// ---------------------------------------------------------------------------
const sseClients = new Map();

function addSseClient(userId, res) {
  if (!sseClients.has(userId)) sseClients.set(userId, new Set());
  sseClients.get(userId).add(res);
}

function removeSseClient(userId, res) {
  sseClients.get(userId)?.delete(res);
}

function pushToUser(userId, event, data) {
  const clients = sseClients.get(String(userId));
  if (!clients || clients.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch (_) { clients.delete(res); }
  }
}

async function pushCounts(userId, userPrefs) {
  try {
    const uid = String(userId);
    // Determine which types this user has enabled (default all on)
    const prefs = userPrefs?.notifications || {};
    const enabledTypes = NOTIFICATION_TYPES.filter((t) => prefs[t] !== false);

    // Build a type filter for enabled types only
    const typeFilter = enabledTypes.length < 3 ? { type: { $in: enabledTypes } } : {};

    const baseQuery = { clearedBy: { $ne: uid } };
    const [unread, all, ...typeCounts] = await Promise.all([
      Notification.countDocuments({ ...baseQuery, readBy: { $ne: uid }, ...typeFilter }),
      Notification.countDocuments({ ...baseQuery, ...typeFilter }),
      ...NOTIFICATION_TYPES.map((type) => Notification.countDocuments({ ...baseQuery, type })),
    ]);
    const countsByType = { all };
    NOTIFICATION_TYPES.forEach((type, index) => {
      countsByType[type] = prefs[type] !== false ? typeCounts[index] : 0;
    });
    pushToUser(uid, 'counts_updated', { unreadCount: unread, countsByType });
  } catch (_) {}
}

async function pushNotificationCreated(userId, notification) {
  pushToUser(String(userId), 'notification_created', notification);
  await pushCounts(String(userId));
}

// Exports needed by notificationPublisher.service.js
module.exports.pushNotificationCreated = pushNotificationCreated;
module.exports.pushCounts = pushCounts;
module.exports.sseClients = sseClients;

// ---------------------------------------------------------------------------
// GET /api/notifications/stream  — per-user SSE stream
//
// The frontend EventSource passes the JWT as ?token= because browsers don't
// support custom headers with EventSource.
// ---------------------------------------------------------------------------
router.get('/stream', async (req, res) => {
  // Authenticate via query param token (EventSource can't send headers)
  const token = req.query.token;
  if (!token) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Token required' } });
  }

  let userId;
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    userId = String(decoded.id);
  } catch (_) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid token' } });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Confirm connection
  res.write('event: connected\ndata: {}\n\n');

  addSseClient(userId, res);

  // Load user preferences so pushCounts filters by enabled notification types
  try {
    const User = require('../models/User');
    const userDoc = await User.findById(userId).select('preferences').lean();
    pushCounts(userId, userDoc?.preferences);
  } catch (_) {
    pushCounts(userId);
  }

  // Keep-alive heartbeat every 25 s
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (_) { clearInterval(heartbeat); }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeSseClient(userId, res);
  });
});

// ---------------------------------------------------------------------------
// GET /api/notifications/counts  — lightweight badge-only endpoint
// ---------------------------------------------------------------------------
router.get('/counts', auth, async (req, res, next) => {
  try {
    const uid = req.user._id;
    const notifPrefs = req.user.preferences?.notifications || {};
    const enabledTypes = NOTIFICATION_TYPES.filter((t) => notifPrefs[t] !== false);
    const prefTypeFilter = enabledTypes.length < 3 ? { type: { $in: enabledTypes } } : {};

    const baseQuery = { clearedBy: { $ne: uid } };
    const [unread, all, ...typeCounts] = await Promise.all([
      Notification.countDocuments({ ...baseQuery, readBy: { $ne: uid }, ...prefTypeFilter }),
      Notification.countDocuments({ ...baseQuery, ...prefTypeFilter }),
      ...NOTIFICATION_TYPES.map((type) => Notification.countDocuments({ ...baseQuery, type })),
    ]);
    const countsByType = { all };
    NOTIFICATION_TYPES.forEach((type, index) => {
      countsByType[type] = notifPrefs[type] !== false ? typeCounts[index] : 0;
    });
    res.json({ success: true, data: { unreadCount: unread, countsByType } });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
const buildBaseQuery = (userId, filter, unread) => {
  const query = { clearedBy: { $ne: userId } };
  if (filter && filter !== 'all') query.type = filter;
  if (unread === 'true') query.readBy = { $ne: userId };
  return query;
};

// GET /api/notifications
router.get('/', auth, async (req, res, next) => {
  try {
    const { filter = 'all', unread, page = 1, limit = 20 } = req.query;
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.max(parseInt(limit, 10) || 20, 1);
    const skip = (safePage - 1) * safeLimit;

    // Respect user's notification type preferences
    const notifPrefs = req.user.preferences?.notifications || {};
    const enabledTypes = NOTIFICATION_TYPES.filter((t) => notifPrefs[t] !== false);
    const prefTypeFilter = enabledTypes.length < 3 ? { type: { $in: enabledTypes } } : {};

    // If user requests a specific filter tab for a disabled type, return empty
    if (filter !== 'all' && notifPrefs[filter] === false) {
      return res.json({
        success: true,
        data: {
          items: [],
          unreadCount: 0,
          countsByType: { all: 0, system: 0, device: 0, meeting: 0, qa: 0, transcript: 0 },
          page: safePage, limit: safeLimit, total: 0,
        },
      });
    }

    const query = { ...buildBaseQuery(req.user._id, filter, unread), ...prefTypeFilter };

    const baseQuery = { clearedBy: { $ne: req.user._id } };
    const [notifications, total, unreadCount, allCount, ...typeCounts] =
      await Promise.all([
        Notification.find(query).sort({ createdAt: -1 }).skip(skip).limit(safeLimit).lean(),
        Notification.countDocuments(query),
        Notification.countDocuments({ ...baseQuery, readBy: { $ne: req.user._id }, ...prefTypeFilter }),
        Notification.countDocuments({ ...baseQuery, ...prefTypeFilter }),
        ...NOTIFICATION_TYPES.map((type) => Notification.countDocuments({ ...baseQuery, type })),
      ]);

    const countsByType = { all: allCount };
    NOTIFICATION_TYPES.forEach((type, index) => {
      countsByType[type] = notifPrefs[type] !== false ? typeCounts[index] : 0;
    });

    res.json({
      success: true,
      data: {
        items: notifications,
        unreadCount,
        countsByType,
        page: safePage,
        limit: safeLimit,
        total,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/notifications/:id
router.get('/:id', auth, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_NOTIFICATION_ID', message: 'Valid notification id is required' },
      });
    }
    const notification = await Notification.findOne({ _id: id, clearedBy: { $ne: req.user._id } }).lean();
    if (!notification) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Notification not found' } });
    }
    res.json({ success: true, data: notification });
  } catch (error) {
    next(error);
  }
});

// POST /api/notifications/:id/read
router.post('/:id/read', auth, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!id || id === 'undefined' || !mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_NOTIFICATION_ID', message: 'Valid notification id is required' },
      });
    }
    const notification = await Notification.findOne({ _id: id, clearedBy: { $ne: req.user._id } });
    if (!notification) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Notification not found' } });
    }
    const alreadyRead = (notification.readBy || []).some((uid) => String(uid) === String(req.user._id));
    if (!alreadyRead) {
      notification.readBy.push(req.user._id);
      await notification.save();
    }
    await pushCounts(String(req.user._id), req.user.preferences);
    res.json({ success: true, data: notification });
  } catch (error) {
    next(error);
  }
});

// POST /api/notifications/read-all
router.post('/read-all', auth, async (req, res, next) => {
  try {
    await Notification.updateMany(
      { clearedBy: { $ne: req.user._id }, readBy: { $ne: req.user._id } },
      { $addToSet: { readBy: req.user._id } }
    );
    await pushCounts(String(req.user._id), req.user.preferences);
    res.json({ success: true, message: 'All notifications marked as read' });
  } catch (error) {
    next(error);
  }
});

// POST /api/notifications/clear-all  (NEW — was missing)
router.post('/clear-all', auth, async (req, res, next) => {
  try {
    const { filter = 'all' } = req.body;
    const query = { clearedBy: { $ne: req.user._id } };
    if (filter && filter !== 'all') query.type = filter;
    await Notification.updateMany(query, { $addToSet: { clearedBy: req.user._id } });
    await pushCounts(String(req.user._id), req.user.preferences);
    res.json({ success: true, message: 'Notifications cleared' });
  } catch (error) {
    next(error);
  }
});

// POST /api/notifications/:id/clear
router.post('/:id/clear', auth, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!id || id === 'undefined' || !mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_NOTIFICATION_ID', message: 'Valid notification id is required' },
      });
    }
    const notification = await Notification.findById(id);
    if (!notification) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Notification not found' } });
    }
    const alreadyCleared = (notification.clearedBy || []).some(
      (uid) => String(uid) === String(req.user._id)
    );
    if (!alreadyCleared) {
      notification.clearedBy = notification.clearedBy || [];
      notification.clearedBy.push(req.user._id);
      await notification.save();
    }
    await pushCounts(String(req.user._id), req.user.preferences);
    res.json({ success: true, data: { _id: id, cleared: true } });
  } catch (error) {
    next(error);
  }
});

module.exports = router;