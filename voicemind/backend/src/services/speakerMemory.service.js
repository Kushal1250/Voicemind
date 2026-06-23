/**
 * speakerMemory.service.js — Persistent Speaker Memory engine (Phase 5 / 8)
 * ============================================================================
 *
 * Bridges the Node backend's MongoDB-backed SpeakerProfile collection with
 * the Python QA service's stateless POST /profile/extract endpoint.
 *
 *   syncSpeakerMemory(meetingId, context)
 *     → POST {QA_API_URL}/profile/extract  with the current transcript text
 *     → merge the returned per-speaker fields into SpeakerProfile docs
 *       (accumulating: a non-empty existing field is never replaced by an
 *        empty one from a later, possibly-truncated extraction)
 *
 *   getSpeakerMemoryJSON(meetingId)
 *     → returns a JSON STRING of { "Speaker 3": {...}, ... } ready to send
 *       as QARequest.speakerMemory on the NEXT /qa call, so "Who is
 *       Speaker 3?" can be answered even if that speaker's introduction
 *       falls outside a later request's (possibly truncated) context window.
 *
 * Both functions are designed to be called FIRE-AND-FORGET from request
 * handlers (qa.routes.js, transcripts.routes.js) — they catch and log their
 * own errors and never throw into the caller's response path, and use a
 * SHORT dedicated timeout so a slow/unavailable QA service can't stall the
 * primary request.
 */

'use strict';

const axios = require('axios');
const crypto = require('crypto');
const SpeakerProfile = require('../models/SpeakerProfile');

const QA_API_URL          = process.env.QA_API_URL || 'http://127.0.0.1:8002';
const PROFILE_TIMEOUT_MS  = Number(process.env.QA_PROFILE_TIMEOUT_MS || 8000);
// Cap how much free text we keep per array field / summary so documents
// stay small and prompts built from them stay cheap.
const MAX_ARRAY_ITEMS     = 12;
const MAX_SUMMARY_CHARS   = 400;

function contextHash(context) {
  return crypto.createHash('sha1').update(String(context || '')).digest('hex');
}

function uniqueMerge(existing = [], incoming = []) {
  const out = Array.isArray(existing) ? [...existing] : [];
  const lower = new Set(out.map((v) => String(v).toLowerCase()));
  for (const v of Array.isArray(incoming) ? incoming : []) {
    const s = String(v || '').trim();
    if (!s) continue;
    const l = s.toLowerCase();
    if (!lower.has(l)) {
      out.push(s);
      lower.add(l);
    }
  }
  return out.slice(0, MAX_ARRAY_ITEMS);
}

/**
 * Build the Mongo update for one speaker, merging the QA service's
 * /profile/extract output into whatever is already persisted.
 *
 * `existing` may be `null` (first time we've seen this speaker).
 */
function buildMergedUpdate(existing, extracted, contextHashValue) {
  const e = existing || {};
  const x = extracted || {};

  const name = e.name || (x.name || '').trim() || null;
  const profileSentence = (x.profileSentence || '').trim() || e.profileSentence || '';

  // Prefer an existing longer/non-empty summary; otherwise adopt the new
  // representative sentence (trimmed) as a starter summary.
  let summary = e.summary || '';
  if (!summary && profileSentence) {
    summary = profileSentence.slice(0, MAX_SUMMARY_CHARS);
  }

  const organization = uniqueMerge(e.organization, x.organization);
  const university   = uniqueMerge(e.university, x.university);
  const project      = uniqueMerge(e.project, x.project);
  const technologies = uniqueMerge(e.technologies, x.technologies);
  const topics       = uniqueMerge(e.topics, x.topics);
  const mentionedEntities = uniqueMerge(e.mentionedEntities, x.mentionedEntities);

  const semester = e.semester || x.semester || null;

  const introduced = Boolean(
    e.introduced || name || organization.length || university.length
      || project.length || semester
  );

  // mentions: monotonically non-decreasing — take the max of what we had
  // and what this extraction reports for the (possibly larger) context.
  const mentions = Math.max(Number(e.mentions || 0), Number(x.mentions || 0));

  return {
    name,
    profileSentence,
    summary,
    organization,
    university,
    project,
    technologies,
    topics,
    mentionedEntities,
    semester,
    introduced,
    mentions,
    lastSyncedAt: new Date(),
    lastContextHash: contextHashValue,
  };
}

/**
 * syncSpeakerMemory(meetingId, context)
 *
 * Calls the QA service's /profile/extract with the current transcript
 * context, then upserts SpeakerProfile docs for every speaker found.
 * Safe to call repeatedly (e.g. after every transcript update, or after
 * every QA request) — it's idempotent and cheap when the context hasn't
 * changed (lastContextHash short-circuit).
 *
 * Returns the number of speakers synced, or 0 on any failure (never throws).
 */
async function syncSpeakerMemory(meetingId, context) {
  if (!meetingId || !context || !String(context).trim()) return 0;

  try {
    const hash = contextHash(context);

    const response = await axios.post(
      `${QA_API_URL}/profile/extract`,
      { context, meetingId },
      { timeout: PROFILE_TIMEOUT_MS }
    );

    const speakers = response.data?.speakers || {};
    const labels   = Object.keys(speakers);
    if (!labels.length) return 0;

    // Skip speakers whose extraction is identical to last time (same
    // context hash AND we've already persisted at least once) — avoids
    // needless writes when QA is called repeatedly on an unchanged transcript.
    const existingDocs = await SpeakerProfile.find({ meetingId, speakerLabel: { $in: labels } }).lean();
    const existingByLabel = new Map(existingDocs.map((d) => [d.speakerLabel, d]));

    const ops = [];
    for (const label of labels) {
      const existing = existingByLabel.get(label) || null;
      if (existing && existing.lastContextHash === hash) continue; // unchanged

      const update = buildMergedUpdate(existing, speakers[label], hash);
      ops.push({
        updateOne: {
          filter: { meetingId, speakerLabel: label },
          update: { $set: { meetingId, speakerLabel: label, ...update } },
          upsert: true,
        },
      });
    }

    if (ops.length) {
      await SpeakerProfile.bulkWrite(ops, { ordered: false });
    }
    return labels.length;
  } catch (err) {
    // Non-fatal: speaker memory is an enhancement, never block the caller.
    console.warn(`[speakerMemory] sync failed for meeting ${meetingId}: ${err.message}`);
    return 0;
  }
}

/**
 * getSpeakerMemoryJSON(meetingId)
 *
 * Returns a JSON STRING (or `null` if no profiles exist yet) of the form
 *   { "Speaker 3": { name, role, organization, university, location,
 *                     topics, summary }, ... }
 * — the exact shape `QARequest.speakerMemory` expects on the QA service.
 */
async function getSpeakerMemoryJSON(meetingId) {
  if (!meetingId) return null;
  try {
    const docs = await SpeakerProfile.find({ meetingId }).lean();
    if (!docs.length) return null;

    const memory = {};
    for (const doc of docs) {
      const entry = {};
      if (doc.name) entry.name = doc.name;
      if (doc.role || doc.occupation) entry.role = doc.role || doc.occupation;
      if (doc.organization?.length) entry.organization = doc.organization;
      if (doc.university?.length) entry.university = doc.university;
      if (doc.location) entry.location = doc.location;
      if (doc.topics?.length) entry.topics = doc.topics;
      const summary = doc.summary || doc.profileSentence;
      if (summary) entry.summary = summary;

      if (Object.keys(entry).length) {
        memory[doc.speakerLabel] = entry;
      }
    }
    return Object.keys(memory).length ? JSON.stringify(memory) : null;
  } catch (err) {
    console.warn(`[speakerMemory] read failed for meeting ${meetingId}: ${err.message}`);
    return null;
  }
}

/**
 * getSpeakerProfiles(meetingId)
 * Plain array of SpeakerProfile docs for a meeting — used by the
 * GET /api/meetings/:id/speaker-profiles endpoint.
 */
async function getSpeakerProfiles(meetingId) {
  return SpeakerProfile.find({ meetingId }).sort({ speakerLabel: 1 }).lean();
}

module.exports = {
  syncSpeakerMemory,
  getSpeakerMemoryJSON,
  getSpeakerProfiles,
  // Exported for unit testing (pure functions, no DB/network access):
  uniqueMerge,
  buildMergedUpdate,
  contextHash,
};
