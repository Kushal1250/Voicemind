const mongoose = require('mongoose');
const { ALLOWED_MEETING_LANGUAGES, normalizeMeetingLanguage } = require('../utils/languageSupport');

const deviceSchema = new mongoose.Schema(
  {
    deviceId: { type: String, required: true, unique: true, trim: true },
    name: {
      type: String,
      trim: true,
      default: function defaultName() {
        return this.deviceId;
      }
    },
    firmwareVersion: { type: String, default: null },
    status: {
      type: String,
      enum: ['online', 'offline', 'recording', 'error'],
      default: 'offline',
      index: true
    },
    lastSeenAt: { type: Date, default: Date.now, index: true },
    currentMeetingId: { type: String, default: null, index: true },
    network: {
      ip: { type: String, default: null },
      mac: { type: String, default: null },
      ssid: { type: String, default: null },
      rssi: { type: Number, default: null }
    },
    telemetry: {
      uptimeSec: { type: Number, default: 0 },
      freeHeap: { type: Number, default: 0 },
      totalHeap: { type: Number, default: 0 },
      freeSPIFFS: { type: Number, default: 0 },
      chunkDuration: { type: Number, default: 0 },
      psram: { type: Boolean, default: false },
      audioLevel: { type: Number, default: null },
      firmware: { type: String, default: null }
    },
    control: {
      pendingCommand: {
        type: String,
        enum: ['none', 'start', 'stop'],
        default: 'none',
        index: true
      },
      meetingId: { type: String, default: null },
      title: { type: String, default: null },
      meetingContext: { type: String, default: null },
      language: {
        type: String,
        enum: ALLOWED_MEETING_LANGUAGES,
        default: 'auto',
        set: (value) => normalizeMeetingLanguage(value)
      },
      requestedAt: { type: Date, default: null },
      acknowledgedAt: { type: Date, default: null },
      lastResult: {
        status: { type: String, default: null },
        message: { type: String, default: null },
        at: { type: Date, default: null }
      }
    },
    registeredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  {
    timestamps: true,
    minimize: false
  }
);

deviceSchema.index({ 'network.mac': 1 });

module.exports = mongoose.model('Device', deviceSchema);
