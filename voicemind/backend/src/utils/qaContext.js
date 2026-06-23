/**
 * qaContext.js — shared transcript-context formatting for the QA service.
 *
 * The Python QA service's parse_context() expects each line in the form:
 *   [HH:MM:SS-HH:MM:SS] Speaker N: text
 *
 * routes/qa.routes.js has its own near-identical `formatMs`/
 * `buildFullTranscriptContext` (left untouched to avoid any behavior change
 * in that working, tested path). This module exists so
 * routes/transcripts.routes.js — which has no such helper — can build the
 * same format for the Speaker Memory sync triggered after a transcript
 * rebuild (Phase 5/8).
 */

'use strict';

function formatMs(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const hours   = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * Build "[HH:MM:SS-HH:MM:SS] Speaker N: text" lines from an array of
 * segments with {startMs, endMs, speaker, text}. Empty-text segments are
 * skipped. Returns a single newline-joined string.
 */
function buildQaContext(segments = []) {
  return segments
    .map((seg) => {
      const text = normalizeText(seg?.text);
      if (!text) return null;
      const start   = formatMs(seg?.startMs);
      const end     = formatMs(seg?.endMs ?? seg?.startMs);
      const speaker = normalizeText(seg?.speaker) || 'Speaker';
      return `[${start}-${end}] ${speaker}: ${text}`;
    })
    .filter(Boolean)
    .join('\n');
}

module.exports = { formatMs, buildQaContext };
