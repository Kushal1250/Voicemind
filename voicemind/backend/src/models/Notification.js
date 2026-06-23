const mongoose = require('mongoose');

const NOTIFICATION_TYPES = ['system', 'device', 'meeting', 'qa', 'transcript'];
const NOTIFICATION_SEVERITIES = ['success', 'info', 'warning', 'error', 'critical'];

const notificationSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: NOTIFICATION_TYPES,
      required: true,
    },
    severity: {
      type: String,
      enum: NOTIFICATION_SEVERITIES,
      default: 'info',
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
    },
    source: {
      type: String,
      default: 'backend',
      trim: true,
    },
    service: {
      type: String,
      default: null,
      trim: true,
    },
    deviceId: {
      type: String,
      default: null,
    },
    meetingId: {
      type: String,
      default: null,
    },
    meta: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    link: {
      path: { type: String, default: null },
      label: { type: String, default: null },
    },
    dedupeKey: {
      type: String,
      index: true,
      default: null,
    },
    readBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    clearedBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
  },
  {
    timestamps: true,
  }
);

notificationSchema.index({ type: 1, createdAt: -1 });
notificationSchema.index({ service: 1, createdAt: -1 });
notificationSchema.index({ severity: 1, createdAt: -1 });
notificationSchema.index({ meetingId: 1, createdAt: -1 });
notificationSchema.index({ deviceId: 1, createdAt: -1 });
notificationSchema.index({ createdAt: -1 });
notificationSchema.index({ readBy: 1 });
notificationSchema.index({ clearedBy: 1 });

module.exports = mongoose.model('Notification', notificationSchema);
