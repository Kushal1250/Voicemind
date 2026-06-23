const express = require('express');
const Device = require('../models/Device');
const Meeting = require('../models/Meeting');
const Transcript = require('../models/Transcript');
const eventBus = require('../services/eventBus');

const router = express.Router();
const clients = new Set();
const ACTIVE_MEETING_STATUSES = new Set(['recording', 'processing', 'pending', 'partial']);

function sendEvent(res, eventType, data) {
  res.write(`event: ${eventType}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function safeWrite(client, eventType, data) {
  try {
    sendEvent(client.res, eventType, data);
    return true;
  } catch (_error) {
    return false;
  }
}

function serializeMeeting(meeting, transcriptMap) {
  const transcript = transcriptMap.get(meeting.meetingId) || null;
  return {
    meetingId: meeting.meetingId,
    title: meeting.title,
    deviceId: meeting.deviceId,
    source: meeting.source,
    status: meeting.status,
    createdAt: meeting.createdAt,
    updatedAt: meeting.updatedAt,
    startTime: meeting.startTime,
    endTime: meeting.endTime,
    stats: meeting.stats || {},
    durationSec: Number(meeting.stats?.durationSec || 0),
    chunksUploaded: Number(meeting.stats?.chunksUploaded || 0),
    chunksTotal: Number(meeting.stats?.chunksTotal || 0),
    chunksProcessing: Number(meeting.stats?.chunksProcessing || 0),
    chunksTranscribed: Number(meeting.stats?.chunksTranscribed || 0),
    chunksFailed: Number(meeting.stats?.chunksFailed || 0),
    transcript,
  };
}

async function buildSnapshot(targetMeetingId = null) {
  const meetingQuery = targetMeetingId
    ? { meetingId: targetMeetingId }
    : { status: { $in: ['pending', 'recording', 'processing', 'completed', 'done', 'failed', 'ended'] } };

  const [devices, meetings] = await Promise.all([
    Device.find({}).sort({ lastSeenAt: -1 }).lean(),
    Meeting.find(meetingQuery).sort({ updatedAt: -1, createdAt: -1 }).limit(targetMeetingId ? 5 : 30).lean(),
  ]);

  const meetingIds = meetings.map((m) => m.meetingId);
  const transcripts = meetingIds.length
    ? await Transcript.find({ meetingId: { $in: meetingIds } }).lean()
    : [];
  const transcriptMap = new Map(transcripts.map((t) => [t.meetingId, t]));

  const activeMeetingDoc = targetMeetingId
    ? meetings.find((meeting) => meeting.meetingId === targetMeetingId) || null
    : meetings.find((meeting) => ACTIVE_MEETING_STATUSES.has(String(meeting.status || '').toLowerCase())) || null;

  return {
    serverTime: new Date().toISOString(),
    activeMeetingId: activeMeetingDoc?.meetingId || null,
    devices: devices.map((device) => ({
      deviceId: device.deviceId,
      name: device.name,
      status: device.status,
      lastSeenAt: device.lastSeenAt,
      telemetry: device.telemetry || {},
      currentMeetingId: device.currentMeetingId || null,
      control: device.control || {},
    })),
    activeMeeting: activeMeetingDoc ? serializeMeeting(activeMeetingDoc, transcriptMap) : null,
    recentMeetings: meetings.map((meeting) => serializeMeeting(meeting, transcriptMap)),
  };
}

async function replayCurrentState(client) {
  const snapshot = await buildSnapshot(client.meetingId || null);
  safeWrite(client, 'connection', {
    eventType: 'connection',
    eventId: `connection:${Date.now()}`,
    timestamp: snapshot.serverTime,
    mode: 'LIVE',
    serverTime: snapshot.serverTime,
    meetingId: client.meetingId || snapshot.activeMeetingId || null,
  });
  safeWrite(client, 'live_snapshot', {
    eventType: 'live_snapshot',
    eventId: `live_snapshot:${client.meetingId || 'global'}:${Date.now()}`,
    timestamp: snapshot.serverTime,
    ...snapshot,
  });
}

function shouldSendToClient(client, payload = {}) {
  if (!client.meetingId) return true;
  return !payload.meetingId || payload.meetingId === client.meetingId;
}

function broadcast(eventType, data) {
  for (const client of [...clients]) {
    if (!shouldSendToClient(client, data)) continue;
    const ok = safeWrite(client, eventType, data);
    if (!ok) clients.delete(client);
  }
}

router.get('/', async (req, res) => {
  const meetingId = String(req.query.meetingId || '').trim() || null;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const client = { res, meetingId };
  clients.add(client);

  try {
    await replayCurrentState(client);
  } catch (_error) {
    safeWrite(client, 'system_error', {
      eventType: 'system_error',
      eventId: `system_error:init:${Date.now()}`,
      timestamp: new Date().toISOString(),
      meetingId,
      message: 'Failed to load initial live state',
    });
  }

  const pingInterval = setInterval(() => {
    try {
      sendEvent(res, 'ping', {
        eventType: 'ping',
        eventId: `ping:${Date.now()}`,
        timestamp: new Date().toISOString(),
        meetingId,
      });
    } catch (_error) {
      clearInterval(pingInterval);
      clients.delete(client);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(pingInterval);
    clients.delete(client);
  });

  req.on('error', () => {
    clearInterval(pingInterval);
    clients.delete(client);
  });
});

[
  'recording_started',
  'recording_stopped',
  'chunk_uploaded',
  'chunk_processing_started',
  'chunk_processed',
  'chunk_failed',
  'transcript_updated',
  'transcript_delta',
  'transcript_rejected',
  'meeting_status_changed',
  'device_online',
  'device_offline',
  'heartbeat_received',
  'meeting_started',
  'meeting_ended',
  'remote_start_sent',
  'recording_started',
  'recording_stopping',
  'device_error',
  'system_warning',
  'system_error',
].forEach((eventName) => {
  eventBus.on(eventName, (data) => broadcast(eventName, data));
});

module.exports = router;
