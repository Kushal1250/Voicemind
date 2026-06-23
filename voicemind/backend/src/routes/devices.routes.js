const express = require('express');
const Device = require('../models/Device');
const Meeting = require('../models/Meeting');
const Transcript = require('../models/Transcript');
const { auth } = require('../middleware/auth');
const eventBus = require('../services/eventBus');
const { normalizeMeetingLanguage } = require('../utils/languageSupport');

const router = express.Router();

function isDeviceFresh(device) {
  if (!device || !device.lastSeenAt) return false;
  const ageMs = Date.now() - new Date(device.lastSeenAt).getTime();
  return ageMs <= 45000;
}

router.get('/', auth, async (req, res, next) => {
  try {
    const devices = await Device.find().sort({ lastSeenAt: -1 });

    res.json({
      success: true,
      data: devices
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', auth, async (req, res, next) => {
  try {
    const device = await Device.findOne({ deviceId: req.params.id });

    if (!device) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Device not found' }
      });
    }

    res.json({
      success: true,
      data: device
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:id/status', async (req, res, next) => {
  try {
    const device = await Device.findOne({ deviceId: req.params.id });

    if (!device) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Device not found' }
      });
    }

    let currentMeeting = null;
    let transcript = null;

    if (device.currentMeetingId) {
      currentMeeting = await Meeting.findOne({ meetingId: device.currentMeetingId }).lean();
      if (currentMeeting) {
        transcript = await Transcript.findOne({ meetingId: currentMeeting.meetingId }).lean();
      }
    }

    const fresh = isDeviceFresh(device);

    if (!fresh && currentMeeting && currentMeeting.status === 'recording') {
      currentMeeting = null;
    }

    res.json({
      success: true,
      data: {
        deviceId: device.deviceId,
        name: device.name,
        status: fresh ? device.status : 'offline',
        telemetry: device.telemetry || {},
        lastSeenAt: device.lastSeenAt,
        control: device.control || {},
        currentMeeting: currentMeeting
          ? {
              meetingId: currentMeeting.meetingId,
              title: currentMeeting.title,
              source: currentMeeting.source,
              status: currentMeeting.status,
              startTime: currentMeeting.startTime,
              endTime: currentMeeting.endTime,
              chunksUploaded: currentMeeting.stats?.chunksUploaded || 0,
              chunksTotal: currentMeeting.stats?.chunksTotal || 0,
              durationSec: currentMeeting.stats?.durationSec || 0,
              transcriptStatus: transcript?.processingStatus || 'pending',
              transcriptText: transcript?.fullText || '',
              transcriptSegments: Array.isArray(transcript?.segments) ? transcript.segments.length : 0
            }
          : null
      }
    });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/heartbeat', async (req, res, next) => {
  try {
    const {
      ip,
      rssi,
      firmware,
      uptimeSec,
      freeHeap,
      freeSPIFFS,
      chunkDuration,
      psram
    } = req.body || {};

    const now = new Date();

    const existingDevice = await Device.findOne({ deviceId: req.params.id });
    const wasOffline = !existingDevice || existingDevice.status === 'offline';

    const device = await Device.findOneAndUpdate(
      { deviceId: req.params.id },
      {
        $set: {
          name: req.params.id,
          status: 'online',
          lastSeenAt: now,
          'telemetry.ip': ip,
          'telemetry.rssi': rssi,
          'telemetry.firmware': firmware,
          'telemetry.uptimeSec': uptimeSec,
          'telemetry.freeHeap': freeHeap,
          'telemetry.freeSPIFFS': freeSPIFFS,
          'telemetry.chunkDuration': chunkDuration,
          'telemetry.psram': psram
        }
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true
      }
    );

    eventBus.emit('heartbeat_received', {
      meetingId: device.currentMeetingId || null,
      deviceId: device.deviceId,
      deviceStatus: 'online',
      telemetry: device.telemetry,
      lastSeenAt: device.lastSeenAt,
      message: 'Device heartbeat received',
      dedupeKey: `heartbeat:${device.deviceId}:${Math.floor(Date.now() / 1000)}`
    });

    if (wasOffline) {
      eventBus.emit('device_online', {
        meetingId: device.currentMeetingId || null,
        deviceId: device.deviceId,
        name: device.name,
        telemetry: device.telemetry,
        lastSeenAt: device.lastSeenAt,
        currentMeetingId: device.currentMeetingId || null,
        message: 'Device is online'
      });
    }

    res.json({
      success: true,
      data: {
        status: 'ok',
        deviceId: device.deviceId,
        lastSeenAt: device.lastSeenAt
      }
    });
  } catch (error) {
    next(error);
  }
});

// ESP32 polls here for website commands
router.get('/:id/command', async (req, res, next) => {
  try {
    const device = await Device.findOne({ deviceId: req.params.id });

    if (!device) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Device not found' }
      });
    }

    const fresh = isDeviceFresh(device);

    if (!fresh) {
      return res.json({
        success: true,
        data: {
          command: 'none'
        }
      });
    }

    const pendingCommand = device.control?.pendingCommand || 'none';

    if (pendingCommand === 'none') {
      return res.json({
        success: true,
        data: {
          command: 'none'
        }
      });
    }

    return res.json({
      success: true,
      data: {
        command: pendingCommand,
        meetingId: device.control?.meetingId || null,
        title: device.control?.title || null,
        language: normalizeMeetingLanguage(device.control?.language),
        requestedAt: device.control?.requestedAt || null
      }
    });
  } catch (error) {
    next(error);
  }
});

// ESP32 acknowledges command execution here
router.post('/:id/command/ack', async (req, res, next) => {
  try {
    const { command, status, meetingId, message } = req.body || {};

    const device = await Device.findOne({ deviceId: req.params.id });
    if (!device) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Device not found' }
      });
    }

    device.status = 'online';
    device.lastSeenAt = new Date();
    device.control.acknowledgedAt = new Date();
    device.control.lastResult = {
      status: status || null,
      message: message || null,
      at: new Date()
    };

    if (command === 'start') {
      if (status === 'started') {
        device.control.pendingCommand = 'none';

        if (meetingId) {
          device.currentMeetingId = meetingId;

          await Meeting.findOneAndUpdate(
            { meetingId },
            {
              $set: {
                status: 'recording',
                startTime: new Date(),
                endTime: null,
                lastError: null
              }
            }
          );

          eventBus.emit('meeting_status_changed', {
            meetingId,
            deviceId: req.params.id,
            status: 'recording',
            reason: 'esp32_start_confirmed',
            message: 'ESP32 confirmed recording start'
          });

          eventBus.emit('recording_started', {
            meetingId,
            deviceId: req.params.id,
            startTime: new Date(),
            source: 'esp32',
            message: 'Recording started on ESP32'
          });
        }
      } else if (status === 'failed') {
        device.control.pendingCommand = 'none';
        device.currentMeetingId = null;

        if (meetingId) {
          await Meeting.findOneAndUpdate(
            { meetingId },
            {
              $set: {
                status: 'failed',
                endTime: new Date(),
                lastError: {
                  code: 'ESP32_START_FAILED',
                  message: message || 'ESP32 failed to start recording',
                  at: new Date()
                }
              }
            }
          );

          eventBus.emit('meeting_status_changed', {
            meetingId,
            status: 'failed',
            reason: 'esp32_start_failed'
          });
        }
      }
    }

    if (command === 'stop') {
      if (status === 'received' || status === 'stopping') {
        // IMPORTANT:
        // keep pendingCommand = 'stop' until the ESP32 fully confirms "stopped"
        device.control.pendingCommand = 'stop';

        if (meetingId) {
          device.currentMeetingId = meetingId;
        }

        eventBus.emit('recording_stopping', {
          meetingId: meetingId || device.currentMeetingId,
          deviceId: req.params.id,
          status: 'processing',
          reason: 'esp32_stop_in_progress',
          message: 'ESP32 acknowledged stop request'
        });

        eventBus.emit('meeting_status_changed', {
          meetingId: meetingId || device.currentMeetingId,
          deviceId: req.params.id,
          status: 'processing',
          reason: 'esp32_stop_in_progress',
          message: 'ESP32 is stopping recording'
        });
      } else if (status === 'stopped') {
        device.control.pendingCommand = 'none';

        if (meetingId) {
          const meeting = await Meeting.findOne({ meetingId });

          if (meeting) {
            meeting.status = 'processing';
            meeting.endTime = meeting.endTime || new Date();

            if (meeting.startTime) {
              meeting.stats.durationSec = Math.max(
                Number(meeting.stats?.durationSec || 0),
                Math.floor((meeting.endTime - meeting.startTime) / 1000)
              );
            }

            await meeting.save();

            eventBus.emit('recording_stopped', {
              meetingId,
              deviceId: req.params.id,
              endTime: meeting.endTime,
              duration: meeting.stats?.durationSec || 0,
              message: 'Recording stopped on ESP32',
              dedupeKey: `recording_stopped:${meetingId}`
            });

            eventBus.emit('meeting_status_changed', {
              meetingId,
              status: 'processing',
              reason: 'esp32_stop_confirmed'
            });
          }
        }

        device.currentMeetingId = null;
      } else if (status === 'failed') {
        device.control.pendingCommand = 'none';

        if (meetingId) {
          await Meeting.findOneAndUpdate(
            { meetingId },
            {
              $set: {
                status: 'failed',
                endTime: new Date(),
                lastError: {
                  code: 'ESP32_STOP_FAILED',
                  message: message || 'ESP32 failed to stop recording',
                  at: new Date()
                }
              }
            }
          );

          eventBus.emit('meeting_status_changed', {
            meetingId,
            status: 'failed',
            reason: 'esp32_stop_failed'
          });
        }

        device.currentMeetingId = null;
      }
    }

    await device.save();

    res.json({
      success: true,
      data: {
        acknowledged: true
      }
    });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/register', auth, async (req, res, next) => {
  try {
    const { name } = req.body;

    let device = await Device.findOne({ deviceId: req.params.id });

    if (device) {
      return res.status(400).json({
        success: false,
        error: { code: 'ALREADY_EXISTS', message: 'Device already registered' }
      });
    }

    device = await Device.create({
      deviceId: req.params.id,
      name: name || req.params.id,
      status: 'offline',
      registeredBy: req.user._id
    });

    res.status(201).json({
      success: true,
      data: device
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;