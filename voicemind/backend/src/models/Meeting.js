const mongoose = require('mongoose');
const {
  ALLOWED_MEETING_LANGUAGES,
  AUDIO_STORAGE_FOLDERS,
  normalizeMeetingLanguage,
  resolveAudioLanguageFolder,
} = require('../utils/languageSupport');

const actionItemSchema = new mongoose.Schema(
  {
    task: { type: String, default: '' },
    owner: { type: String, default: null },
    deadline: { type: String, default: null }
  },
  { _id: false }
);

const meetingSchema = new mongoose.Schema(
  {
    meetingId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      default: () => `mtg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
    },
    title: {
      type: String,
      required: [true, 'Meeting title is required'],
      trim: true
    },
    meetingContext: {
      type: String,
      trim: true,
      default: ''
    },
    description: {
      type: String,
      trim: true,
      default: ''
    },
    source: {
      type: String,
      enum: ['web', 'esp32'],
      required: true,
      default: 'web'
    },
    language: {
      type: String,
      trim: true,
      enum: ALLOWED_MEETING_LANGUAGES,
      default: 'auto',
      set: (value) => normalizeMeetingLanguage(value)
    },
    selectedLanguage: {
      type: String,
      trim: true,
      enum: ALLOWED_MEETING_LANGUAGES,
      default: 'auto',
      set: (value) => normalizeMeetingLanguage(value)
    },
    normalizedLanguage: {
      type: String,
      trim: true,
      enum: ALLOWED_MEETING_LANGUAGES,
      default: 'auto',
      set: (value) => normalizeMeetingLanguage(value)
    },
    storageFolder: {
      type: String,
      trim: true,
      enum: AUDIO_STORAGE_FOLDERS,
      default: 'auto'
    },
    storagePath: {
      type: String,
      trim: true,
      default: ''
    },
    languageDetected: {
      type: String,
      trim: true,
      enum: [...ALLOWED_MEETING_LANGUAGES, null],
      default: null,
      set: (value) => (value == null ? null : normalizeMeetingLanguage(value))
    },
    detectedLanguages: {
      type: [{ type: String, enum: ALLOWED_MEETING_LANGUAGES }],
      default: []
    },
    isMultilingual: {
      type: Boolean,
      default: false
    },
    deviceId: {
      type: String,
      default: null,
      index: true
    },
    sourceConfig: {
      recordingMode: {
        type: String,
        enum: ['mic', 'mic_system'],
        default: 'mic'
      },
      noiseReduction: {
        type: Boolean,
        default: true
      },
      sampleRate: {
        type: Number,
        default: null
      }
    },
    visible: {
      type: Boolean,
      default: false,
      index: true
    },
    visibilityReason: {
      type: String,
      default: 'pending_min_duration'
    },
    status: {
      type: String,
      // v2: added 'cancelled' and 'cancelled_short' — were missing, causing Mongoose
      // validation errors when the backend tried to set these states.
      enum: ['idle', 'pending', 'recording', 'uploading', 'processing', 'completed', 'failed', 'ended', 'cancelled', 'cancelled_short'],
      default: 'pending',
      index: true,
      set: (value) => {
        const normalized = String(value || '').trim().toLowerCase();
        if (normalized === 'done') return 'completed';
        if (normalized === 'error') return 'failed';
        return normalized || 'pending';
      }
    },
    startTime: {
      type: Date,
      default: Date.now
    },
    endTime: {
      type: Date,
      default: null
    },
    summary: {
      type: String,
      default: ''
    },
    keyPoints: {
      type: [String],
      default: []
    },
    actionItems: {
      type: [actionItemSchema],
      default: []
    },
    audioQualityWarning: {
      type: String,
      default: null
    },
    lastTranscriptAt: {
      type: Date,
      default: null,
      index: true
    },
    stats: {
      durationSec: { type: Number, default: 0 },
      chunkCount: { type: Number, default: 0 },
      transcriptLength: { type: Number, default: 0 },
      transcriptSegments: { type: Number, default: 0 },
      speakerCount: { type: Number, default: 0 },
      chunksUploaded: { type: Number, default: 0 },
      chunksCompleted30s: { type: Number, default: 0 },
      chunksProcessing: { type: Number, default: 0 },
      chunksTranscribed: { type: Number, default: 0 },
      chunksFailed: { type: Number, default: 0 },
      chunksTotal: { type: Number, default: 0 },
      hasFinalPartialChunk: { type: Boolean, default: false },
      lastChunkIndex: { type: Number, default: -1 },
      totalAudioBytes: { type: Number, default: 0 },
      fileSizeBytes: { type: Number, default: 0 },
      lastClientDurationSec: { type: Number, default: 0 },
      transcriptUpdatedAt: { type: Date, default: null }
    },
    diarization: {
      enabled: { type: Boolean, default: false },
      configured: { type: Boolean, default: false },
      ready: { type: Boolean, default: false },
      loadAttempted: { type: Boolean, default: false },
      pipeline: { type: String, default: null },
      device: { type: String, default: null },
      trustedCheckpoints: { type: Boolean, default: false },
      numSpeakers: { type: Number, default: null },
      minSpeakers: { type: Number, default: null },
      maxSpeakers: { type: Number, default: null },
      error: { type: String, default: null },
      segments: { type: Number, default: 0 },
      applied: { type: Boolean, default: false },
      speakerCount: { type: Number, default: 0 }
    },
    lastError: {
      code: { type: String, default: null },
      message: { type: String, default: null },
      at: { type: Date, default: null }
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    }
  },
  {
    timestamps: true,
    minimize: false
  }
);

meetingSchema.pre('validate', function syncLanguageStorage(next) {
  const normalized = normalizeMeetingLanguage(this.selectedLanguage || this.normalizedLanguage || this.language);
  this.language = normalized;
  this.selectedLanguage = normalized;
  this.normalizedLanguage = normalized;

  if (!this.storageFolder || !AUDIO_STORAGE_FOLDERS.includes(this.storageFolder)) {
    this.storageFolder = resolveAudioLanguageFolder(normalized);
  }

  next();
});

meetingSchema.index({ createdAt: -1 });
meetingSchema.index({ source: 1, status: 1 });
meetingSchema.index({ language: 1, languageDetected: 1 });
meetingSchema.index({ selectedLanguage: 1, normalizedLanguage: 1, storageFolder: 1 });
meetingSchema.index({ detectedLanguages: 1 });
meetingSchema.index({ isMultilingual: 1 });
meetingSchema.index({ 'stats.chunkCount': -1 });

module.exports = mongoose.model('Meeting', meetingSchema);