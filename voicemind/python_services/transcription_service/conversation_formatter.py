# python_services/transcription_service/conversation_formatter.py
"""
VoiceMind Conversation Formatter v7.0
======================================

CHANGES IN v7.0 — DYNAMIC SPEAKER DIARIZATION
----------------------------------------------

REMOVED COMPLETELY:
  - _KNOWN_ROLES dict (doctor, patient, teacher, student, etc.)
  - _ROLE_DISPLAY dict
  - All role mapping, role prediction, role classification
  - All role normalization and role display formatting
  - Doctor/Patient heuristics
  - Teacher/Student heuristics
  - Conversation role inference

SPEAKER LABEL POLICY:
  - All speakers are labeled: Speaker 1, Speaker 2, ... Speaker N
  - No other naming format is allowed
  - No emojis
  - No inferred identities
  - No role names of any kind

SPEAKER IDENTIFICATION:
  - Voice embeddings (ECAPA-TDNN / Resemblyzer / MFCC fallback)
  - Cosine similarity matching (threshold: 0.75)
  - Embedding profile updating (EMA: 0.8 * old + 0.2 * new)
  - Acoustic feature validation (pitch, timbre, energy, rate)
"""

from __future__ import annotations

import re
import logging
from typing import Any, Dict, List, Optional, Tuple

log = logging.getLogger(__name__)


# ─── Speaker display helper ───────────────────────────────────────────────────

def display_speaker_name(speaker_id: str) -> str:
    """
    Convert a speaker_id to a display string.

    Rules:
      - SPEAKER_N  → "Speaker N"
      - speaker N  → "Speaker N"
      - Any number → "Speaker N"
      - Fallback   → "Speaker 1"

    NEVER returns a role name (Doctor, Patient, Teacher, Student, etc.).
    """
    if speaker_id:
        raw = str(speaker_id).strip()
        m = re.search(r"(\d+)$", raw)
        if m:
            n = int(m.group(1))
            # Pyannote returns 0-indexed sometimes; keep 1-based
            display_n = n if n >= 1 else 1
            return f"Speaker {display_n}"
    return "Speaker 1"


# ─── Speaker ID normalization ─────────────────────────────────────────────────

def normalize_speaker_ids(
    diarization_segments: List[Dict[str, Any]],
) -> Tuple[List[Dict[str, Any]], Dict[str, str]]:
    """
    Map raw diarization IDs → stable SPEAKER_1, SPEAKER_2… by first appearance.
    All resulting speaker labels are "Speaker N" — no role names.
    """
    seen: List[str] = []
    for seg in diarization_segments:
        raw = str(seg.get("speaker_id") or seg.get("speaker") or "").strip()
        if raw and raw not in seen:
            seen.append(raw)

    id_map: Dict[str, str] = {}
    for idx, raw_id in enumerate(seen, start=1):
        id_map[raw_id] = f"SPEAKER_{idx}"

    updated = []
    for seg in diarization_segments:
        raw    = str(seg.get("speaker_id") or seg.get("speaker") or "").strip()
        mapped = id_map.get(raw, "SPEAKER_1")
        updated.append({**seg, "speaker_id": mapped, "speaker": display_speaker_name(mapped)})

    log.info(f"[formatter] speaker id_map: {id_map}")
    return updated, id_map


# ─── Time-overlap speaker assignment ─────────────────────────────────────────

def assign_speakers_by_time_overlap(
    asr_segments: List[Dict[str, Any]],
    diarization_segments: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Assign each ASR segment to the diarization speaker with max timestamp overlap."""
    if not diarization_segments:
        return assign_all_to_speaker_1(asr_segments)

    result = []
    for seg in asr_segments:
        seg_start = float(seg.get("start", 0) or 0)
        seg_end   = float(seg.get("end", seg_start) or seg_start)

        best_speaker_id = "SPEAKER_1"
        best_overlap    = 0.0

        for d_seg in diarization_segments:
            d_start  = float(d_seg.get("start", 0) or 0)
            d_end    = float(d_seg.get("end",   d_start) or d_start)
            overlap  = max(0.0, min(seg_end, d_end) - max(seg_start, d_start))
            if overlap > best_overlap:
                best_overlap    = overlap
                best_speaker_id = str(d_seg.get("speaker_id") or "SPEAKER_1")

        display = display_speaker_name(best_speaker_id)
        log.info(f"[formatter] [{seg_start:.1f}s-{seg_end:.1f}s] → {display} (overlap={best_overlap:.2f}s)")
        result.append({**seg, "speaker_id": best_speaker_id, "speaker": display})

    return result


def assign_all_to_speaker_1(
    asr_segments: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Fallback: all segments → Speaker 1."""
    log.info("[formatter] assigning all to Speaker 1")
    return [
        {**seg, "speaker_id": "SPEAKER_1", "speaker": "Speaker 1"}
        for seg in asr_segments
    ]


# ─── Turn grouping ────────────────────────────────────────────────────────────

def group_segments_into_turns(
    segments: List[Dict[str, Any]],
    merge_gap_sec: float = 3.0,
) -> List[Dict[str, Any]]:
    """
    Merge consecutive same-speaker segments into turns.
    Speaker label is always "Speaker N" — never a role name.
    """
    if not segments:
        return []

    turns: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None

    for seg in segments:
        text = str(seg.get("text", "")).strip()
        if not text:
            continue

        speaker_id = str(seg.get("speaker_id") or "SPEAKER_1").strip()
        speaker    = display_speaker_name(speaker_id)

        start  = float(seg.get("start", 0) or 0)
        end    = float(seg.get("end",   start) or start)
        source = str(seg.get("source_text", text)).strip()

        if current is None:
            current = {
                "speaker":       speaker,
                "speaker_id":    speaker_id,
                "start":         start,
                "end":           end,
                "text":          text,
                "source_text":   source,
                "segment_count": 1,
            }
            continue

        same_speaker = current["speaker_id"] == speaker_id
        gap          = start - current["end"]

        if same_speaker and gap <= merge_gap_sec:
            current["text"]          = f"{current['text']} {text}".strip()
            current["source_text"]   = f"{current['source_text']} {source}".strip()
            current["end"]           = max(current["end"], end)
            current["segment_count"] += 1
        else:
            turns.append(current)
            current = {
                "speaker":       speaker,
                "speaker_id":    speaker_id,
                "start":         start,
                "end":           end,
                "text":          text,
                "source_text":   source,
                "segment_count": 1,
            }

    if current and current.get("text"):
        turns.append(current)

    log.info(f"[formatter] grouped {len(segments)} segments → {len(turns)} turns")
    return turns


# ─── Conversation text builder ────────────────────────────────────────────────

def build_conversation_text(
    turns: List[Dict[str, Any]],
    diarization_applied: bool = False,
) -> str:
    """
    Build clean conversation_text from turns.

    Output format (always):
        Speaker 1:
        Hello.

        Speaker 2:
        Hi.

        Speaker 1:
        How are you?

    Rules:
      - No role names (Doctor, Patient, Teacher, Student, etc.)
      - No emojis
      - No inferred identities
      - No diarization warning notes
      - Only "Speaker N" labels
    """
    lines: List[str] = []

    for turn in turns:
        speaker_id = str(turn.get("speaker_id") or "SPEAKER_1").strip()
        speaker    = display_speaker_name(speaker_id)
        text       = str(turn.get("text", "")).strip()
        if speaker and text:
            lines.append(f"{speaker}: {text}")

    return "\n\n".join(lines)


# ─── Speaker count ────────────────────────────────────────────────────────────

def count_unique_speakers(turns: List[Dict[str, Any]]) -> int:
    return len({str(t.get("speaker_id") or "SPEAKER_1") for t in turns})


# ─── Main format entry-point ──────────────────────────────────────────────────

def format_transcript_to_conversation(
    segments: List[Dict[str, Any]],
    diarization_segments: Optional[List[Dict[str, Any]]] = None,
    diarization_applied: bool = False,
    full_text: str = "",
    language: str = "auto",
) -> Dict[str, Any]:
    """
    Format ASR segments into a conversation transcript.

    All speakers are labeled Speaker N. No role inference of any kind.
    """
    if not segments:
        return {
            "conversation_text":   "",
            "turns":               [],
            "speaker_count":       1,
            "diarization_applied": False,
            "diarization_status":  "unavailable",
        }

    if diarization_applied and diarization_segments:
        norm_diar, _     = normalize_speaker_ids(diarization_segments)
        labeled_segments = assign_speakers_by_time_overlap(segments, norm_diar)
        diar_status      = "applied"
    else:
        labeled_segments = segments
        unique_speakers  = {str(s.get("speaker_id") or "SPEAKER_1") for s in labeled_segments}
        diar_status      = "heuristic" if len(unique_speakers) > 1 else "single_speaker"

    turns             = group_segments_into_turns(labeled_segments)
    conversation_text = build_conversation_text(turns, diarization_applied=diarization_applied)
    speaker_count     = count_unique_speakers(turns)

    log.info(f"[formatter] speaker_count={speaker_count} diar_status={diar_status}")
    log.info(f"[formatter] conversation_text preview:\n{conversation_text[:300]}")

    return {
        "conversation_text":   conversation_text,
        "turns":               turns,
        "speaker_count":       speaker_count,
        "diarization_applied": diarization_applied,
        "diarization_status":  diar_status,
    }
