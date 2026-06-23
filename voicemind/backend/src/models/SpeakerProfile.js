/**
 * SpeakerProfile.js — Persistent Speaker Memory (Phase 5 / Phase 8)
 * ====================================================================
 *
 * Stores one document per (meetingId, speakerLabel) — e.g. "Speaker 3" in
 * meeting "mtg_172...". Populated/refreshed by
 * services/speakerMemory.service.js, which calls the QA service's
 * POST /profile/extract on the current transcript and merges the result
 * into this document (accumulating — never DOWNGRADING a known field with
 * an empty one from a later, possibly-truncated extraction).
 *
 * This is what lets "Who is Speaker 3?" / "Which university does Speaker 3
 * study in?" be answered even if Speaker 3's introduction falls outside the
 * context window sent on a LATER question — the backend re-sends this
 * accumulated memory via QARequest.speakerMemory on every /qa call.
 *
 * Example document (matches the Phase 8 sketch in the prompt):
 *   {
 *     meetingId: "mtg_1234",
 *     speakerLabel: "Speaker 3",
 *     name: "Rohan Patel",
 *     role: "Final-year student",
 *     organization: ["Perception Care"],
 *     university: ["Adani University"],
 *     location: null,
 *     project: ["VoiceMind"],
 *     semester: "7th",
 *     technologies: ["React", "Node.js", "MongoDB"],
 *     topics: ["transcription", "speaker diarization"],
 *     mentionedEntities: ["VR10", "Mercedes-Maybach S 650 Guard"],
 *     profileSentence: "I am building a real-time transcription system...",
 *     summary: "Final-year CS student at Adani University working on VoiceMind.",
 *     mentions: 12,
 *     introduced: true,
 *   }
 */

'use strict';

const mongoose = require('mongoose');

const speakerProfileSchema = new mongoose.Schema(
  {
    meetingId: { type: String, required: true, index: true, trim: true },

    // e.g. "Speaker 1", "Speaker 2", ... — the diarization label as it
    // appears in the transcript for THIS meeting.
    speakerLabel: { type: String, required: true, trim: true },

    // ── Identity fields (Phase 5 EXTRACT list) ──────────────────────────────
    name:         { type: String, default: null, trim: true },
    role:         { type: String, default: null, trim: true },
    occupation:   { type: String, default: null, trim: true },
    location:     { type: String, default: null, trim: true },
    semester:     { type: String, default: null, trim: true },

    organization: { type: [String], default: [] },
    university:   { type: [String], default: [] },
    project:      { type: [String], default: [] },
    technologies: { type: [String], default: [] },
    skills:       { type: [String], default: [] },
    interests:    { type: [String], default: [] },

    // Contact references / relationships mentioned about this speaker
    contactReferences: { type: [String], default: [] },
    relationships:     { type: [String], default: [] },

    // ── General profile (v9.2 QA service — works even without name/org) ────
    topics:             { type: [String], default: [] },
    mentionedEntities:  { type: [String], default: [] },
    profileSentence:    { type: String, default: '' },

    // Free-text rolling summary (Phase 5 "Summarize Speaker 3 in 10 words" /
    // biography-style). Updated opportunistically by the sync job; never
    // auto-generated to be longer than ~400 chars.
    summary: { type: String, default: '' },

    // How many transcript segments this speaker has spoken across all syncs
    // for this meeting (monotonically non-decreasing).
    mentions: { type: Number, default: 0 },

    // True once any identity field (name/org/university/role/etc.) has ever
    // been populated for this speaker in this meeting.
    introduced: { type: Boolean, default: false },

    // Diagnostics — when/how this profile was last refreshed.
    lastSyncedAt:    { type: Date, default: null },
    lastContextHash: { type: String, default: null },
  },
  { timestamps: true }
);

// One profile per speaker per meeting.
speakerProfileSchema.index({ meetingId: 1, speakerLabel: 1 }, { unique: true });

/**
 * toMemoryEntry()
 * Shape expected by the QA service's QARequest.speakerMemory field:
 *   { "Speaker 3": { name, role, organization, university, location,
 *                     topics, summary, ... } }
 * (see qa_service/main.py merge_persisted_speaker_memory()).
 */
speakerProfileSchema.methods.toMemoryEntry = function toMemoryEntry() {
  return {
    name:         this.name || undefined,
    role:         this.role || this.occupation || undefined,
    organization: this.organization?.length ? this.organization : undefined,
    university:   this.university?.length ? this.university : undefined,
    location:     this.location || undefined,
    topics:       this.topics?.length ? this.topics : undefined,
    summary:      this.summary || this.profileSentence || undefined,
  };
};

module.exports = mongoose.models.SpeakerProfile
  || mongoose.model('SpeakerProfile', speakerProfileSchema);
