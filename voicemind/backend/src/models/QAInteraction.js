const mongoose = require('mongoose');

// ROOT-CAUSE FIX: `speaker` was missing from this sub-schema even though
// qa.routes.js (buildSourcesFromSegments) and the Python QA service both
// populate it on every source. Mongoose silently strips any field not
// declared on a (sub)schema, so every saved QAInteraction was losing the
// speaker label on its evidence — proof cards looked unattributed/generic
// as soon as the page was reloaded (GET /meetings/:id/qa), even though the
// very first in-memory response had the right data.
const sourceSchema = new mongoose.Schema({
  startMs: Number,
  endMs: Number,
  textSnippet: String,
  confidence: Number,
  speaker: { type: String, default: null },
}, { _id: false });

const qaInteractionSchema = new mongoose.Schema({
  meetingId: {
    type: String,
    default: null,
    index: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  question: {
    type: String,
    required: true,
  },
  answer: {
    type: String,
    required: true,
  },
  sources: [sourceSchema],
  confidence: {
    type: String,
    enum: ['high', 'medium', 'low'],
    default: 'medium',
  },
  limitedContext: {
    type: Boolean,
    default: false,
  },
  transcriptAvailable: {
    type: Boolean,
    default: true,
  },
  status: {
    type: String,
    enum: ['success', 'failed', 'mock', 'fallback'],
    default: 'success',
  },
  processingTimeMs: Number,
  // ROOT-CAUSE FIX: qa.routes.js has passed `mode` and `questionLang` to
  // QAInteraction.create() since v8.0 (see header comment in that file),
  // but neither field was ever declared here, so Mongoose dropped them on
  // every save. The frontend's ModeBadge/LangBadge only ever showed
  // correctly on the very first render (from the live response object) and
  // reverted to blank/default after any reload.
  mode: {
    type: String,
    default: null,
  },
  questionLang: {
    type: String,
    default: 'en',
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
}, {
  timestamps: true,
});

qaInteractionSchema.index({ meetingId: 1, createdAt: -1 });
qaInteractionSchema.index({ userId: 1 });

module.exports = mongoose.model('QAInteraction', qaInteractionSchema);
