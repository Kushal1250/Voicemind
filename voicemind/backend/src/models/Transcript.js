const mongoose = require('mongoose');
const { ALLOWED_MEETING_LANGUAGES, normalizeMeetingLanguage } = require('../utils/languageSupport');

const wordSchema = new mongoose.Schema(
  {
    word: { type: String, default: '' },
    start: { type: Number, default: 0 },
    end: { type: Number, default: 0 },
    startMs: { type: Number, default: 0 },
    endMs: { type: Number, default: 0 },
    probability: { type: Number, default: null },
  },
  { _id: false }
);

const segmentSchema = new mongoose.Schema(
  {
    id: { type: Number, default: 0 },
    start: { type: Number, default: 0 },
    end: { type: Number, default: 0 },
    startMs: { type: Number, default: 0 },
    endMs: { type: Number, default: 0 },
    speaker: { type: String, default: 'Speaker 1' },
    language: { type: String, enum: [...ALLOWED_MEETING_LANGUAGES, ''], default: '' },
    sourceLanguage: { type: String, enum: [...ALLOWED_MEETING_LANGUAGES, ''], default: '' },
    detectedLanguage: { type: String, enum: [...ALLOWED_MEETING_LANGUAGES, ''], default: '' },
    text: { type: String, default: '' },
    displayText: { type: String, default: '' },
    rawSourceText: { type: String, default: '' },
    sourceText: { type: String, default: '' },
    normalizedSourceText: { type: String, default: '' },
    englishText: { type: String, default: '' },
    translatedText: { type: String, default: '' },
    confidence: { type: Number, default: null },
    confidenceLabel: { type: String, enum: ['unknown', 'low', 'medium', 'high'], default: 'unknown' },
    needsReview: { type: Boolean, default: false },
    uncertainTerms: { type: [String], default: [] },
    translationWarnings: { type: [String], default: [] },
    words: { type: [wordSchema], default: [] },
    chunkIndex: { type: Number, default: 0 },
  },
  { _id: false }
);

const speakerTurnSchema = new mongoose.Schema(
  {
    id: { type: Number, default: 0 },
    speaker: { type: String, default: 'Speaker 1' },
    start: { type: Number, default: 0 },
    end: { type: Number, default: 0 },
    startMs: { type: Number, default: 0 },
    endMs: { type: Number, default: 0 },
    startTimecode: { type: String, default: '00:00:00' },
    endTimecode: { type: String, default: '00:00:00' },
    language: { type: String, enum: [...ALLOWED_MEETING_LANGUAGES, ''], default: '' },
    sourceLanguage: { type: String, enum: [...ALLOWED_MEETING_LANGUAGES, ''], default: '' },
    text: { type: String, default: '' },
    displayText: { type: String, default: '' },
    sourceText: { type: String, default: '' },
    englishText: { type: String, default: '' },
    confidence: { type: Number, default: null },
    confidenceLabel: { type: String, enum: ['unknown', 'low', 'medium', 'high'], default: 'unknown' },
    needsReview: { type: Boolean, default: false },
    uncertainTerms: { type: [String], default: [] },
    translationWarnings: { type: [String], default: [] },
    chunkIndex: { type: Number, default: 0 },
    segmentCount: { type: Number, default: 0 },
    segments: { type: [segmentSchema], default: [] },
  },
  { _id: false }
);



const symptomsEvidenceItemSchema = new mongoose.Schema(
  {
    title: { type: String, default: '' },
    detail: { type: String, default: '' },
    severity: { type: String, enum: ['low', 'medium', 'high', null], default: null },
    evidence: { type: [String], default: [] },
  },
  { _id: false }
);

const communicationScorecardSchema = new mongoose.Schema(
  {
    clarity: { type: Number, default: 0 },
    confidence: { type: Number, default: 0 },
    engagement: { type: Number, default: 0 },
    structure: { type: Number, default: 0 },
    ownership: { type: Number, default: 0 },
  },
  { _id: false }
);

const speakerSymptomsSchema = new mongoose.Schema(
  {
    speaker: { type: String, default: 'Speaker 1' },
    turnCount: { type: Number, default: 0 },
    talkTimeEstimate: { type: Number, default: 0 },
    overallStyle: { type: String, default: '' },
    evidenceQuality: { type: String, default: '' },
    strongPoints: { type: [symptomsEvidenceItemSchema], default: [] },
    weakPoints: { type: [symptomsEvidenceItemSchema], default: [] },
    symptoms: { type: [symptomsEvidenceItemSchema], default: [] },
    communicationScorecard: { type: communicationScorecardSchema, default: () => ({}) },
    recommendations: { type: [String], default: [] },
  },
  { _id: false }
);

const meetingOverviewSchema = new mongoose.Schema(
  {
    summary: { type: String, default: '' },
    overallCommunicationStyle: { type: [String], default: [] },
    globalSymptoms: { type: [String], default: [] },
    riskFlags: { type: [String], default: [] },
    highlights: { type: [String], default: [] },
  },
  { _id: false }
);

const symptomsMetaSchema = new mongoose.Schema(
  {
    model: { type: String, default: 'lm_studio' },
    usedGroupedTurns: { type: Boolean, default: true },
    speakerCount: { type: Number, default: 0 },
    generatedAt: { type: Date, default: null },
    source: { type: String, default: 'lm_studio' },
    fallback: { type: Boolean, default: false },
  },
  { _id: false }
);

const symptomsDataSchema = new mongoose.Schema(
  {
    success: { type: Boolean, default: false },
    meetingOverview: { type: meetingOverviewSchema, default: () => ({}) },
    speakers: { type: [speakerSymptomsSchema], default: [] },
    meta: { type: symptomsMetaSchema, default: () => ({}) },
    warnings: { type: [String], default: [] },
    error: { type: String, default: '' },
  },
  { _id: false }
);

const actionItemSchema = new mongoose.Schema(
  {
    task: { type: String, default: '' },
    owner: { type: String, default: null },
    deadline: { type: String, default: null },
    priority: { type: String, enum: ['high', 'medium', 'low', null], default: null },
    status: {
      type: String,
      enum: ['open', 'in_progress', 'done', 'blocked', null],
      default: 'open',
    },
    supportingSpeaker: { type: String, default: null },
  },
  { _id: false }
);

const participantSchema = new mongoose.Schema(
  {
    speaker: { type: String, default: '' },
    name: { type: String, default: null },
    role: { type: String, default: null },
    organization: { type: String, default: null },
    education: { type: String, default: null },
    projectAssociation: { type: [String], default: [] },
    keyContributions: { type: [String], default: [] },
  },
  { _id: false }
);

const topicSchema = new mongoose.Schema(
  {
    title: { type: String, default: '' },
    summary: { type: String, default: '' },
  },
  { _id: false }
);

const summaryDataSchema = new mongoose.Schema(
  {
    executiveSummary: { type: [String], default: [] },
    participants: { type: [participantSchema], default: [] },
    keyPoints: { type: [mongoose.Schema.Types.Mixed], default: [] },
    decisions: { type: [String], default: [] },
    actionItems: { type: [actionItemSchema], default: [] },
    risks: { type: [String], default: [] },
    openQuestions: { type: [String], default: [] },
    importantNotes: { type: [String], default: [] },
    topics: { type: [topicSchema], default: [] },
    confidenceNotes: { type: [String], default: [] },
    generatedAt: { type: Date, default: null },
    model: { type: String, default: '' },
    source: { type: String, default: '' },
    fallback: { type: Boolean, default: false },
    transcriptExcerptChars: { type: Number, default: 0 },
  },
  { _id: false }
);

const transcriptSchema = new mongoose.Schema(
  {
    meetingId: { type: String, required: true, unique: true, index: true },
    fullText: { type: String, default: '' },
    displayText: { type: String, default: '' },
    rawFullText: { type: String, default: '' },
    sourceFullText: { type: String, default: '' },
    normalizedSourceFullText: { type: String, default: '' },
    cleanEnglish: { type: String, default: '' },
    translatedEnglish: { type: String, default: '' },
    rawTranscriptNormalized: { type: String, default: '' },
    uncertainTerms: { type: [String], default: [] },
    confidenceNotes: { type: String, default: '' },
    warnings: { type: [String], default: [] },
    translationWarnings: { type: [String], default: [] },
    segments: { type: [segmentSchema], default: [] },
    groupedSpeakerTurns: { type: [speakerTurnSchema], default: [] },
    diarization: {
      requested: { type: Boolean, default: false },
      eligible: { type: Boolean, default: false },
      skipped: { type: Boolean, default: false },
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
      minAudioSec: { type: Number, default: null },
      maxSegmentsForRun: { type: Number, default: null },
      speakerSegments: { type: Number, default: 0 },
      speakersBeforeGrouping: { type: Number, default: 0 },
      segmentSpeakersAfterMerge: { type: Number, default: 0 },
      speakersAfterGrouping: { type: Number, default: 0 },
      applied: { type: Boolean, default: false },
      reason: { type: String, default: '' },
      warnings: { type: [String], default: [] },
      error: { type: String, default: null },
    },
    diagnostics: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    language: {
      type: String,
      enum: ALLOWED_MEETING_LANGUAGES,
      default: 'auto',
      set: (value) => normalizeMeetingLanguage(value),
    },
    languageDetected: {
      type: String,
      enum: [...ALLOWED_MEETING_LANGUAGES, null],
      default: null,
      set: (value) => (value == null ? null : normalizeMeetingLanguage(value)),
    },
    languages: {
      type: [{ type: String, enum: ALLOWED_MEETING_LANGUAGES }],
      default: [],
    },
    isMultilingual: { type: Boolean, default: false },
    languageOverride: {
      type: String,
      enum: ['none', ...ALLOWED_MEETING_LANGUAGES],
      default: 'none',
    },
    speakerCount: { type: Number, default: 0 },
    chunkCountMerged: { type: Number, default: 0 },
    lastChunkIndex: { type: Number, default: -1 },
    quality: {
      coverageRatio: { type: Number, default: null },
      sourceWordCount: { type: Number, default: 0 },
      englishWordCount: { type: Number, default: 0 },
      translationWordRatio: { type: Number, default: null },
      suspiciousTranslationShrinkage: { type: Boolean, default: false },
      displayWarning: { type: Boolean, default: false },
      fallbackReason: { type: String, default: '' },
    },
    summary: { type: String, default: '' },
    keyPoints: { type: [String], default: [] },
    actionItems: { type: [actionItemSchema], default: [] },
    summaryData: { type: summaryDataSchema, default: () => ({}) },
    symptomsData: { type: symptomsDataSchema, default: () => ({}) },
    audioQualityWarning: { type: String, default: null },
    processingStatus: {
      type: String,
      enum: ['pending', 'processing', 'partial', 'completed', 'failed'],
      default: 'pending',
    },
    fallbackReason: { type: String, default: '' },
    updatedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
    minimize: false,
  }
);

transcriptSchema.index({ updatedAt: -1 });
transcriptSchema.index({ languages: 1 });
transcriptSchema.index(
  { fullText: 'text', sourceFullText: 'text', translatedEnglish: 'text' },
  {
    default_language: 'none',
    language_override: 'languageOverride',
  }
);

module.exports = mongoose.model('Transcript', transcriptSchema);
