const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const Device = require('../models/Device');
const Meeting = require('../models/Meeting');
const Transcript = require('../models/Transcript');
const Notification = require('../models/Notification');
const { auth } = require('../middleware/auth');
const eventBus = require('../services/eventBus');

const router = express.Router();

const TRANSCRIBE_API_URL = process.env.TRANSCRIBE_API_URL || 'http://127.0.0.1:8001';
const QA_API_URL = process.env.QA_API_URL || 'http://127.0.0.1:8002';

async function pingService(url) {
  try {
    const response = await axios.get(`${url}/health`, { timeout: 5000 });
    return {
      ok: true,
      status: response.status,
      data: response.data || null,
    };
  } catch (error) {
    return {
      ok: false,
      status: error.response?.status || null,
      error: error.response?.data || error.message,
    };
  }
}

router.get('/test', (req, res) => {
  res.json({
    success: true,
    message: 'VoiceMind backend connectivity test successful!',
    timestamp: new Date().toISOString(),
    yourIP: req.ip,
  });
});

router.get('/', (req, res, next) => next());

router.get('/status', auth, async (req, res) => {
  try {
    const dbState = mongoose.connection.readyState;
    const database =
      dbState === 1
        ? 'connected'
        : dbState === 2
          ? 'connecting'
          : dbState === 3
            ? 'disconnecting'
            : 'disconnected';

    const [activeDevices, activeMeetings, transcriptCount, transcribeService, qaService] = await Promise.all([
      Device.countDocuments({ status: 'online' }),
      Meeting.countDocuments({ status: { $in: ['recording', 'uploading', 'processing'] } }),
      Transcript.countDocuments({}),
      pingService(TRANSCRIBE_API_URL),
      pingService(QA_API_URL),
    ]);

    const degraded = !transcribeService.ok || !qaService.ok || database !== 'connected';

    if (degraded) {
      eventBus.emit('system_warning', {
        code: 'system-degraded',
        title: 'System degraded',
        message: 'One or more services are unavailable or degraded.',
        dedupeKey: `system-degraded:${database}:${transcribeService.ok}:${qaService.ok}`,
      });
    }

    res.json({
      success: true,
      data: {
        status: transcribeService.ok ? 'healthy' : 'degraded',
        version: '2.0.0',
        uptime: process.uptime(),
        serverTime: new Date().toISOString(),
        database,
        activeDevices,
        activeMeetings,
        transcriptCount,
        services: {
          transcription: {
            url: TRANSCRIBE_API_URL,
            ...transcribeService,
          },
          qa: {
            url: QA_API_URL,
            ...qaService,
          },
        },
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'SERVER_ERROR',
        message: error.message,
      },
    });
  }
});

router.get('/errors', auth, async (req, res) => {
  try {
    const { limit = 20, code, severity, type = 'system' } = req.query;
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);

    const query = { type };
    if (severity) query.severity = severity;
    if (code) {
      query.$or = [
        { dedupeKey: { $regex: String(code), $options: 'i' } },
        { title: { $regex: String(code), $options: 'i' } },
        { message: { $regex: String(code), $options: 'i' } },
      ];
    }

    const items = await Notification.find(query)
      .sort({ createdAt: -1 })
      .limit(safeLimit)
      .lean();

    res.json({
      success: true,
      data: items,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'SYSTEM_ERRORS_FETCH_FAILED',
        message: error.message,
      },
    });
  }
});

module.exports = router;
