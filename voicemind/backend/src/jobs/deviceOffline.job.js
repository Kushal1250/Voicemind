const cron = require('node-cron');
const mongoose = require('mongoose');
const Device = require('../models/Device');
const Meeting = require('../models/Meeting');
const Transcript = require('../models/Transcript');
const eventBus = require('../services/eventBus');

const DEVICE_OFFLINE_AFTER_SEC = parseInt(process.env.DEVICE_OFFLINE_AFTER_SEC || '45', 10);
const CHECK_INTERVAL_SEC = parseInt(process.env.DEVICE_CHECK_INTERVAL_SEC || '10', 10);

async function finalizeMeetingForOfflineDevice(device) {
  if (!device.currentMeetingId) return;

  const meeting = await Meeting.findOne({ meetingId: device.currentMeetingId });
  if (!meeting) return;
  if (!['recording', 'uploading', 'processing'].includes(meeting.status)) return;

  const transcript = await Transcript.findOne({ meetingId: meeting.meetingId });
  const cleanText = String(transcript?.fullText || '')
    .replace(/\[Chunk \d+\] Audio uploaded successfully, but the transcription service is not running yet\.?/g, '')
    .trim();

  const hasRealTranscript = cleanText.length > 0;

  meeting.endTime = meeting.endTime || new Date();

  if (meeting.startTime) {
    meeting.stats.durationSec = Math.max(
      Number(meeting.stats?.durationSec || 0),
      Math.floor((meeting.endTime - meeting.startTime) / 1000)
    );
  }

  if (meeting.lastError?.code === 'TRANSCRIBE_FAILED') {
    meeting.status = 'failed';
  } else if (hasRealTranscript || Number(meeting.stats?.chunksUploaded || 0) > 0) {
    meeting.status = 'completed';
  } else {
    meeting.status = 'failed';
    meeting.lastError = {
      code: 'DEVICE_OFFLINE',
      message: 'Device went offline before a usable transcript was created',
      at: new Date(),
    };
  }

  await meeting.save();

  eventBus.emit('recording_stopped', {
    meetingId: meeting.meetingId,
    deviceId: meeting.deviceId,
    endTime: meeting.endTime,
    duration: meeting.stats.durationSec,
    reason: 'device_offline',
  });

  eventBus.emit('meeting_status_changed', {
    meetingId: meeting.meetingId,
    status: meeting.status,
    reason: 'device_offline',
  });
}

const checkOfflineDevices = async () => {
  if (mongoose.connection.readyState !== 1) {
    return;
  }

  try {
    const cutoffTime = new Date(Date.now() - DEVICE_OFFLINE_AFTER_SEC * 1000);

    const offlineDevices = await Device.find({
      status: 'online',
      lastSeenAt: { $lt: cutoffTime },
    });

    for (const device of offlineDevices) {
      await finalizeMeetingForOfflineDevice(device);

      device.status = 'offline';
      device.currentMeetingId = null;
      await device.save();

      console.log(`Device ${device.deviceId} marked as offline at ${new Date().toISOString()}`);

      eventBus.emit('device_offline', {
        deviceId: device.deviceId,
        lastSeenAt: device.lastSeenAt,
      });
    }

    const staleRecordingMeetings = await Meeting.find({
      status: 'recording',
      updatedAt: { $lt: cutoffTime },
    });

    for (const meeting of staleRecordingMeetings) {
      const device = meeting.deviceId
        ? await Device.findOne({ deviceId: meeting.deviceId })
        : null;

      const deviceStillFresh =
        device &&
        device.status === 'online' &&
        device.currentMeetingId === meeting.meetingId &&
        device.lastSeenAt &&
        new Date(device.lastSeenAt) >= cutoffTime;

      if (deviceStillFresh) continue;

      meeting.status = Number(meeting.stats?.chunksUploaded || 0) > 0 ? 'completed' : 'failed';
      meeting.endTime = meeting.endTime || new Date();

      if (meeting.startTime) {
        meeting.stats.durationSec = Math.max(
          Number(meeting.stats?.durationSec || 0),
          Math.floor((meeting.endTime - meeting.startTime) / 1000)
        );
      }

      if (meeting.status === 'error' && !meeting.lastError?.code) {
        meeting.lastError = {
          code: 'STALE_RECORDING',
          message: 'Meeting was stuck in recording without active device heartbeat',
          at: new Date(),
        };
      }

      await meeting.save();

      if (device && device.currentMeetingId === meeting.meetingId) {
        device.currentMeetingId = null;
        if (device.lastSeenAt && new Date(device.lastSeenAt) < cutoffTime) {
          device.status = 'offline';
        }
        await device.save();
      }

      eventBus.emit('meeting_status_changed', {
        meetingId: meeting.meetingId,
        status: meeting.status,
        reason: 'stale_recording_cleanup',
      });
    }
  } catch (error) {
    console.error('Error checking offline devices:', error.message);
  }
};

const startDeviceOfflineJob = () => {
  const task = cron.schedule(`*/${CHECK_INTERVAL_SEC} * * * * *`, checkOfflineDevices);
  console.log(
    `🔍 Device offline detection started (checking every ${CHECK_INTERVAL_SEC}s, offline after ${DEVICE_OFFLINE_AFTER_SEC}s)`
  );
  return () => task.stop();
};

module.exports = { startDeviceOfflineJob, checkOfflineDevices };
