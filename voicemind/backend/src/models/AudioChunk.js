const mongoose = require('mongoose');

const audioChunkSchema = new mongoose.Schema(
  {
    meetingId: {
      type: String,
      required: true,
      index: true,
    },
    chunkIndex: {
      type: Number,
      required: true,
      index: true,
    },
    chunkNumber: {
      type: Number,
      default: null,
      index: true,
    },
    source: {
      type: String,
      enum: ['web', 'esp32'],
      required: true,
    },
    uploadToken: {
      type: String,
      default: null,
      index: true,
    },
    mimeType: {
      type: String,
      default: 'audio/wav',
    },
    originalName: {
      type: String,
      default: '',
    },
    fileName: {
      type: String,
      required: true,
    },
    filePath: {
      type: String,
      required: true,
    },
    storageProvider: {
      type: String,
      enum: ['local', 'r2'],
      default: 'local',
      index: true,
    },
    r2Bucket: { type: String, default: '' },
    r2Key: { type: String, default: '', index: true },
    r2ETag: { type: String, default: '' },
    r2Url: { type: String, default: '' },
    uploadCompletedAt: { type: Date, default: null },
    transcriptStatus: {
      type: String,
      enum: ['queued', 'processing', 'accepted', 'rejected_hallucination', 'no_speech', 'unsupported_language', 'error', ''],
      default: '',
      index: true,
    },
    rejectionReason: { type: String, default: '' },
    sizeBytes: {
      type: Number,
      default: 0,
    },
    durationMs: {
      type: Number,
      default: 0,
    },
    durationSource: {
      type: String,
      enum: ['backend', 'client', 'unknown'],
      default: 'unknown',
    },
    checksum: {
      type: String,
      default: null,
    },
    chunkTimestamp: {
      type: Date,
      default: Date.now,
    },
    finalChunk: {
      type: Boolean,
      default: false,
      index: true,
    },
    partialChunk: {
      type: Boolean,
      default: false,
    },
    isFinalPartialChunk: {
      type: Boolean,
      default: false,
      index: true,
    },
    chunkStartSec: {
      type: Number,
      default: null,
      index: true,
    },
    chunkEndSec: {
      type: Number,
      default: null,
      index: true,
    },
    startedAtMs: {
      type: Number,
      default: null,
    },
    endedAtMs: {
      type: Number,
      default: null,
    },
    clientCapturedAt: {
      type: Date,
      default: null,
    },
    sequenceStartMs: {
      type: Number,
      default: null,
    },
    sequenceEndMs: {
      type: Number,
      default: null,
    },
    transcriptText: {
      type: String,
      default: '',
    },
    displayTranscriptText: {
      type: String,
      default: '',
    },
    rawTranscriptText: {
      type: String,
      default: '',
    },
    cleanEnglishTranscript: {
      type: String,
      default: '',
    },
    translatedEnglishTranscript: {
      type: String,
      default: '',
    },
    sourceTranscriptText: {
      type: String,
      default: '',
    },
    normalizedSourceTranscript: {
      type: String,
      default: '',
    },
    rawTranscriptNormalized: {
      type: String,
      default: '',
    },
    conversationText: {
      type: String,
      default: '',
    },
    rawText: {
      type: String,
      default: '',
    },
    normalizedText: {
      type: String,
      default: '',
    },
    modelUsed: {
      type: String,
      default: '',
    },
    fallbackUsed: {
      type: Boolean,
      default: false,
    },
    transcriptWarnings: {
      type: [String],
      default: [],
    },
    translationWarnings: {
      type: [String],
      default: [],
    },
    uncertainTerms: {
      type: [String],
      default: [],
    },
    confidenceNotes: {
      type: String,
      default: '',
    },
    transcriptLanguage: {
      type: String,
      default: 'en',
    },
    transcriptSourceLanguage: {
      type: String,
      default: 'auto',
    },
    transcriptLanguages: {
      type: [String],
      default: [],
    },
    transcriptSegments: {
      type: Array,
      default: [],
    },
    groupedSpeakerTurns: {
      type: Array,
      default: [],
    },
    transcriptQuality: {
      coverageRatio: { type: Number, default: null },
      sourceWordCount: { type: Number, default: 0 },
      englishWordCount: { type: Number, default: 0 },
      translationWordRatio: { type: Number, default: null },
      suspiciousTranslationShrinkage: { type: Boolean, default: false },
      displayWarning: { type: Boolean, default: false },
      fallbackReason: { type: String, default: '' },
    },
    transcriptAcceptance: {
      accepted: { type: Boolean, default: false },
      rejectionReason: { type: String, default: null },
      acceptedText: { type: String, default: '' },
      acceptedSourceText: { type: String, default: '' },
    },
    transcriptMergeStatus: {
      type: String,
      enum: ['pending', 'merged', 'failed'],
      default: 'pending',
    },
    transcriptMergedAt: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: ['uploaded', 'transcribing', 'transcribed', 'skipped', 'failed'],
      default: 'uploaded',
      index: true,
    },
    retries: {
      type: Number,
      default: 0,
    },
    lastError: {
      message: { type: String, default: null },
      at: { type: Date, default: null },
    },
    diagnostics: {
      containerDurationSec: { type: Number, default: null },
      decodedDurationSec: { type: Number, default: null },
      durationDeltaSec: { type: Number, default: null },
      blobSizeBytes: { type: Number, default: 0 },
      mimeType: { type: String, default: '' },
      ffprobe: { type: String, default: '' },
      ffmpeg: { type: String, default: '' },
      rms: { type: Number, default: null },
      inputContainer: { type: String, default: '' },
      outputFormat: { type: String, default: '' },
      sampleRate: { type: Number, default: null },
      channels: { type: Number, default: null },
      detectedLanguage: { type: String, default: '' },
      segmentCount: { type: Number, default: 0 },
      groupedTurnCount: { type: Number, default: 0 },
      displayWarning: { type: Boolean, default: false },
      fallbackReason: { type: String, default: '' },
      coverageRatio: { type: Number, default: null },
      translationWordRatio: { type: Number, default: null },
      suspiciousTranslationShrinkage: { type: Boolean, default: false },
      measuredByClientSec: { type: Number, default: null },
      uploadedAt: { type: Date, default: null },
    },
  },
  {
    timestamps: true,
    minimize: false,
  }
);

audioChunkSchema.pre('validate', function syncLegacyChunkNumber(next) {
  if (typeof this.chunkIndex === 'number' && Number.isFinite(this.chunkIndex)) {
    this.chunkNumber = this.chunkIndex;
  } else if (typeof this.chunkNumber === 'number' && Number.isFinite(this.chunkNumber)) {
    this.chunkIndex = this.chunkNumber;
  }

  const safeStartSec = Number.isFinite(Number(this.chunkStartSec)) ? Number(this.chunkStartSec) : null;
  const safeEndSec = Number.isFinite(Number(this.chunkEndSec)) ? Number(this.chunkEndSec) : null;

  if (safeStartSec != null && Number.isFinite(Number(this.sequenceStartMs)) !== true) {
    this.sequenceStartMs = Math.round(safeStartSec * 1000);
  }
  if (safeEndSec != null && Number.isFinite(Number(this.sequenceEndMs)) !== true) {
    this.sequenceEndMs = Math.round(safeEndSec * 1000);
  }
  if (safeStartSec != null && Number.isFinite(Number(this.startedAtMs)) !== true) {
    this.startedAtMs = Math.round(safeStartSec * 1000);
  }
  if (safeEndSec != null && Number.isFinite(Number(this.endedAtMs)) !== true) {
    this.endedAtMs = Math.round(safeEndSec * 1000);
  }

  if (safeStartSec != null && safeEndSec != null && safeEndSec >= safeStartSec) {
    const derivedDurationMs = Math.max(0, Math.round((safeEndSec - safeStartSec) * 1000));
    if (!this.durationMs || this.durationMs <= 0) {
      this.durationMs = derivedDurationMs;
    }
    const partial = derivedDurationMs > 0 && derivedDurationMs < 30000;
    this.partialChunk = partial;
    if (this.finalChunk && partial) {
      this.isFinalPartialChunk = true;
    }
  }

  next();
});

audioChunkSchema.index({ meetingId: 1, chunkIndex: 1 }, { unique: true });
audioChunkSchema.index({ meetingId: 1, chunkNumber: 1 }, { unique: true, sparse: true });
audioChunkSchema.index({ meetingId: 1, createdAt: 1 });
audioChunkSchema.index({ meetingId: 1, status: 1 });
audioChunkSchema.index({ meetingId: 1, chunkStartSec: 1, chunkEndSec: 1 });
audioChunkSchema.index({ meetingId: 1, uploadToken: 1 }, { sparse: true });
audioChunkSchema.index({ meetingId: 1, storageProvider: 1, r2Key: 1 });

module.exports = mongoose.model('AudioChunk', audioChunkSchema);
