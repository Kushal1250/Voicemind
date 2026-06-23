# python_services/transcription_service/speaker_manager.py
"""
VoiceMind SpeakerManager — Dynamic Speaker Diarization
=========================================================

Implements fully dynamic speaker identification using:
  1. Voice Embeddings (ECAPA-TDNN via SpeechBrain or Resemblyzer)
  2. Voice Pitch Analysis (F0, average pitch, range, variance)
  3. Voice Timbre Analysis (MFCC, spectral centroid, rolloff, bandwidth)
  4. Voice Energy (RMS, loudness)
  5. Speaking Rate
  6. Acoustic Fingerprint

Speaker labels are always:
    Speaker 1, Speaker 2, Speaker 3, ... Speaker N

No role names. No doctor/patient/teacher/student labels. Ever.

Similarity threshold: 0.75 (cosine similarity)
Profile update: exponential moving average (0.8 * old + 0.2 * new)
"""

from __future__ import annotations

import logging
import os
import warnings
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

log = logging.getLogger(__name__)

# ── Constants ─────────────────────────────────────────────────────────────────
SIMILARITY_THRESHOLD: float = float(os.getenv("SPEAKER_SIMILARITY_THRESHOLD", "0.75"))
EMBEDDING_ALPHA: float      = float(os.getenv("SPEAKER_EMBEDDING_ALPHA", "0.8"))   # weight for old embedding

# Embedding backend priority: speechbrain → resemblyzer → mfcc-fallback
_EMBED_BACKEND: Optional[str] = None   # set by _init_embedding_backend()

# ── Lazy-loaded models ────────────────────────────────────────────────────────
_speechbrain_model = None
_resemblyzer_encoder = None
_resemblyzer_preprocess = None

# ── Warnings suppression ──────────────────────────────────────────────────────
def _silence_warnings() -> None:
    for pattern in [
        r".*speechbrain.*",
        r".*resemblyzer.*",
        r".*librosa.*",
        r".*numba.*",
    ]:
        try:
            warnings.filterwarnings("ignore", message=pattern)
        except Exception:
            pass


# ─── Embedding backends ───────────────────────────────────────────────────────

def _try_load_speechbrain() -> bool:
    """Try to load SpeechBrain ECAPA-TDNN speaker recognition model."""
    global _speechbrain_model
    try:
        from speechbrain.pretrained import EncoderClassifier  # type: ignore
        _speechbrain_model = EncoderClassifier.from_hparams(
            source="speechbrain/spkrec-ecapa-voxceleb",
            run_opts={"device": "cpu"},
        )
        log.info("[SpeakerManager] SpeechBrain ECAPA-TDNN loaded")
        return True
    except Exception as exc:
        log.debug(f"[SpeakerManager] SpeechBrain not available: {exc}")
        return False


def _try_load_resemblyzer() -> bool:
    """Try to load Resemblyzer speaker encoder."""
    global _resemblyzer_encoder, _resemblyzer_preprocess
    try:
        from resemblyzer import VoiceEncoder, preprocess_wav  # type: ignore
        _resemblyzer_encoder = VoiceEncoder()
        _resemblyzer_preprocess = preprocess_wav
        log.info("[SpeakerManager] Resemblyzer VoiceEncoder loaded")
        return True
    except Exception as exc:
        log.debug(f"[SpeakerManager] Resemblyzer not available: {exc}")
        return False


def _init_embedding_backend() -> str:
    """Determine and initialize the best available embedding backend."""
    global _EMBED_BACKEND
    if _EMBED_BACKEND is not None:
        return _EMBED_BACKEND
    _silence_warnings()
    if _try_load_speechbrain():
        _EMBED_BACKEND = "speechbrain"
    elif _try_load_resemblyzer():
        _EMBED_BACKEND = "resemblyzer"
    else:
        _EMBED_BACKEND = "mfcc"
        log.warning(
            "[SpeakerManager] Neither SpeechBrain nor Resemblyzer available. "
            "Falling back to MFCC-based embeddings."
        )
    return _EMBED_BACKEND


# ─── Low-level audio helpers ──────────────────────────────────────────────────

def _load_audio(wav_path: str, sr: int = 16000) -> Tuple[Optional[np.ndarray], int]:
    """Load a WAV file at the specified sample rate. Returns (samples, sr) or (None, 0)."""
    try:
        import librosa  # type: ignore
        samples, actual_sr = librosa.load(wav_path, sr=sr, mono=True)
        return samples, actual_sr
    except Exception as exc:
        log.debug(f"[SpeakerManager] librosa load failed ({exc}), trying soundfile")
    try:
        import soundfile as sf  # type: ignore
        import resampy  # type: ignore
        samples, actual_sr = sf.read(wav_path, always_2d=False)
        if samples.ndim > 1:
            samples = samples.mean(axis=1)
        samples = samples.astype(np.float32)
        if actual_sr != sr:
            samples = resampy.resample(samples, actual_sr, sr)
        return samples, sr
    except Exception as exc:
        log.debug(f"[SpeakerManager] soundfile load failed: {exc}")
    return None, 0


def _load_audio_segment(
    wav_path: str, start: float, end: float, sr: int = 16000
) -> Optional[np.ndarray]:
    """Load a specific time segment from a WAV file."""
    samples, actual_sr = _load_audio(wav_path, sr)
    if samples is None:
        return None
    start_idx = max(0, int(start * actual_sr))
    end_idx   = min(len(samples), int(end * actual_sr))
    segment   = samples[start_idx:end_idx]
    return segment if len(segment) > 0 else None


# ─── Embedding extraction ─────────────────────────────────────────────────────

def _embed_speechbrain(samples: np.ndarray, sr: int) -> Optional[np.ndarray]:
    """Extract ECAPA-TDNN embedding using SpeechBrain."""
    try:
        import torch
        tensor = torch.tensor(samples).unsqueeze(0)
        with torch.no_grad():
            embedding = _speechbrain_model.encode_batch(tensor)
        vec = embedding.squeeze().cpu().numpy().flatten()
        norm = np.linalg.norm(vec)
        return (vec / norm) if norm > 1e-9 else vec
    except Exception as exc:
        log.debug(f"[SpeakerManager] SpeechBrain embed failed: {exc}")
        return None


def _embed_resemblyzer(samples: np.ndarray, sr: int) -> Optional[np.ndarray]:
    """Extract d-vector embedding using Resemblyzer."""
    try:
        preprocessed = _resemblyzer_preprocess(samples, source_sr=sr)
        vec = _resemblyzer_encoder.embed_utterance(preprocessed)
        norm = np.linalg.norm(vec)
        return (vec / norm) if norm > 1e-9 else vec
    except Exception as exc:
        log.debug(f"[SpeakerManager] Resemblyzer embed failed: {exc}")
        return None


def _embed_mfcc(samples: np.ndarray, sr: int) -> Optional[np.ndarray]:
    """Fallback MFCC-based acoustic fingerprint (40-dim mean + std = 80-dim)."""
    try:
        import librosa  # type: ignore
        mfcc = librosa.feature.mfcc(y=samples, sr=sr, n_mfcc=40)
        spectral_centroid = librosa.feature.spectral_centroid(y=samples, sr=sr)
        spectral_rolloff  = librosa.feature.spectral_rolloff(y=samples, sr=sr)
        rms               = librosa.feature.rms(y=samples)
        feature_matrices  = [mfcc, spectral_centroid, spectral_rolloff, rms]
        parts = []
        for feat in feature_matrices:
            parts.extend([feat.mean(axis=1), feat.std(axis=1)])
        vec  = np.concatenate(parts).astype(np.float32)
        norm = np.linalg.norm(vec)
        return (vec / norm) if norm > 1e-9 else vec
    except Exception as exc:
        log.debug(f"[SpeakerManager] MFCC embed failed: {exc}")
        return None


def extract_embedding(samples: np.ndarray, sr: int = 16000) -> Optional[np.ndarray]:
    """
    Extract speaker embedding using the best available backend.
    Returns a normalized numpy array or None if extraction fails.
    """
    backend = _init_embedding_backend()
    if backend == "speechbrain" and _speechbrain_model is not None:
        vec = _embed_speechbrain(samples, sr)
        if vec is not None:
            return vec
    if backend in ("speechbrain", "resemblyzer") and _resemblyzer_encoder is not None:
        vec = _embed_resemblyzer(samples, sr)
        if vec is not None:
            return vec
    return _embed_mfcc(samples, sr)


# ─── Acoustic feature extraction ─────────────────────────────────────────────

def extract_acoustic_features(samples: np.ndarray, sr: int = 16000) -> Dict[str, float]:
    """
    Extract supporting acoustic features for speaker matching:
    pitch (F0), energy (RMS), spectral features, speaking rate.
    """
    features: Dict[str, float] = {}
    if samples is None or len(samples) == 0:
        return features
    try:
        import librosa  # type: ignore

        # ── Pitch (F0) ───────────────────────────────────────────────────────
        try:
            f0, voiced_flag, _ = librosa.pyin(
                samples, fmin=librosa.note_to_hz("C2"), fmax=librosa.note_to_hz("C7"),
                sr=sr,
            )
            voiced_f0 = f0[voiced_flag > 0] if voiced_flag is not None else f0
            voiced_f0 = voiced_f0[~np.isnan(voiced_f0)] if voiced_f0 is not None else np.array([])
            if len(voiced_f0) > 0:
                features["pitch_mean"]     = float(np.mean(voiced_f0))
                features["pitch_std"]      = float(np.std(voiced_f0))
                features["pitch_min"]      = float(np.min(voiced_f0))
                features["pitch_max"]      = float(np.max(voiced_f0))
                features["pitch_range"]    = features["pitch_max"] - features["pitch_min"]
        except Exception:
            pass

        # ── Energy (RMS) ─────────────────────────────────────────────────────
        try:
            rms = librosa.feature.rms(y=samples)[0]
            features["rms_mean"] = float(np.mean(rms))
            features["rms_std"]  = float(np.std(rms))
        except Exception:
            pass

        # ── Spectral features ─────────────────────────────────────────────────
        try:
            sc  = librosa.feature.spectral_centroid(y=samples, sr=sr)[0]
            sr_ = librosa.feature.spectral_rolloff(y=samples, sr=sr)[0]
            bw  = librosa.feature.spectral_bandwidth(y=samples, sr=sr)[0]
            features["spectral_centroid_mean"] = float(np.mean(sc))
            features["spectral_rolloff_mean"]  = float(np.mean(sr_))
            features["spectral_bandwidth_mean"]= float(np.mean(bw))
        except Exception:
            pass

        # ── Zero-crossing rate (speaking rate proxy) ──────────────────────────
        try:
            zcr = librosa.feature.zero_crossing_rate(samples)[0]
            features["zcr_mean"] = float(np.mean(zcr))
        except Exception:
            pass

    except Exception as exc:
        log.debug(f"[SpeakerManager] Acoustic feature extraction failed: {exc}")

    return features


# ─── Cosine similarity ────────────────────────────────────────────────────────

def cosine_similarity(vec_a: np.ndarray, vec_b: np.ndarray) -> float:
    """Compute cosine similarity between two embedding vectors."""
    try:
        na = np.linalg.norm(vec_a)
        nb = np.linalg.norm(vec_b)
        if na < 1e-9 or nb < 1e-9:
            return 0.0
        return float(np.dot(vec_a, vec_b) / (na * nb))
    except Exception:
        return 0.0


# ─── SpeakerManager ──────────────────────────────────────────────────────────

class SpeakerManager:
    """
    Dynamic speaker diarization manager.

    Maintains a profile per detected speaker consisting of:
      - embedding  : normalized voice embedding vector (primary identity signal)
      - acoustic   : dictionary of acoustic features (secondary signals)
      - count      : number of segments attributed to this speaker

    Speaker labels: "Speaker 1", "Speaker 2", ... "Speaker N"
    No role names ever.
    """

    def __init__(self, similarity_threshold: float = SIMILARITY_THRESHOLD) -> None:
        self.similarity_threshold: float = similarity_threshold
        self.speaker_profiles: Dict[str, Dict[str, Any]] = {}
        self.speaker_embeddings: Dict[str, np.ndarray] = {}
        self.speaker_count: int = 0

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _next_speaker_id(self) -> str:
        self.speaker_count += 1
        return f"SPEAKER_{self.speaker_count}"

    def _speaker_label(self, speaker_id: str) -> str:
        """Convert internal SPEAKER_N id to display label 'Speaker N'."""
        import re
        m = re.search(r"(\d+)$", str(speaker_id))
        n = int(m.group(1)) if m else 1
        return f"Speaker {n}"

    # ── Core API ──────────────────────────────────────────────────────────────

    def match_speaker(self, embedding: np.ndarray) -> Tuple[Optional[str], float]:
        """
        Compare embedding against all known speaker profiles.

        Returns:
            (speaker_id, best_similarity)  — speaker_id is None if no match exceeds threshold.
        """
        if not self.speaker_embeddings:
            return None, 0.0

        best_id    : Optional[str] = None
        best_score : float         = -1.0

        for sid, stored_emb in self.speaker_embeddings.items():
            score = cosine_similarity(embedding, stored_emb)
            log.debug(f"[SpeakerManager] {sid} similarity = {score:.4f}")
            if score > best_score:
                best_score = score
                best_id    = sid

        if best_score >= self.similarity_threshold:
            return best_id, best_score
        return None, best_score

    def update_profile(self, speaker_id: str, new_embedding: np.ndarray) -> None:
        """
        Update a speaker's embedding profile using exponential moving average:
            updated = ALPHA * existing + (1 - ALPHA) * new
        """
        if speaker_id not in self.speaker_embeddings:
            self.speaker_embeddings[speaker_id] = new_embedding
            return
        old = self.speaker_embeddings[speaker_id]
        updated = EMBEDDING_ALPHA * old + (1.0 - EMBEDDING_ALPHA) * new_embedding
        norm = np.linalg.norm(updated)
        if norm > 1e-9:
            updated = updated / norm
        self.speaker_embeddings[speaker_id] = updated
        self.speaker_profiles[speaker_id]["count"] = (
            self.speaker_profiles.get(speaker_id, {}).get("count", 0) + 1
        )

    def get_or_create_speaker(
        self,
        embedding: np.ndarray,
        acoustic_features: Optional[Dict[str, float]] = None,
    ) -> str:
        """
        Main entry point:
        Given an embedding, find the best matching speaker or create a new one.

        Returns the internal speaker_id (e.g. "SPEAKER_1").
        """
        matched_id, score = self.match_speaker(embedding)

        if matched_id is not None:
            log.info(
                f"[SpeakerManager] Matched {matched_id} "
                f"(similarity={score:.4f} ≥ threshold={self.similarity_threshold})"
            )
            self.update_profile(matched_id, embedding)
            return matched_id

        # No match — create new speaker
        new_id = self._next_speaker_id()
        self.speaker_embeddings[new_id] = embedding
        self.speaker_profiles[new_id] = {
            "label":    self._speaker_label(new_id),
            "count":    1,
            "acoustic": acoustic_features or {},
        }
        log.info(
            f"[SpeakerManager] Created {new_id} "
            f"(max_similarity={score:.4f} < threshold={self.similarity_threshold})"
        )
        return new_id

    def get_display_label(self, speaker_id: str) -> str:
        """Return the display label for a speaker_id. Always 'Speaker N'."""
        return self._speaker_label(speaker_id)

    def reset(self) -> None:
        """Reset all speaker profiles (use between unrelated audio files)."""
        self.speaker_profiles.clear()
        self.speaker_embeddings.clear()
        self.speaker_count = 0

    def summary(self) -> Dict[str, Any]:
        return {
            "speaker_count":    self.speaker_count,
            "similarity_threshold": self.similarity_threshold,
            "backend":          _EMBED_BACKEND or "not_initialized",
            "speakers": [
                {
                    "id":    sid,
                    "label": self._speaker_label(sid),
                    "count": self.speaker_profiles.get(sid, {}).get("count", 0),
                }
                for sid in self.speaker_embeddings
            ],
        }


# ─── File-level speaker assignment ───────────────────────────────────────────

def assign_speakers_with_embeddings(
    wav_path: str,
    diarization_segments: List[Dict[str, Any]],
    manager: Optional[SpeakerManager] = None,
    sr: int = 16000,
) -> Tuple[List[Dict[str, Any]], SpeakerManager]:
    """
    Given a WAV file and raw diarization segments (with start/end times),
    use SpeakerManager to assign consistent Speaker N labels.

    Args:
        wav_path            : Path to the WAV file.
        diarization_segments: List of dicts with {"start", "end", "speaker"}.
        manager             : Existing SpeakerManager (for cross-chunk consistency).
                              If None, a fresh one is created.
        sr                  : Sample rate for loading audio.

    Returns:
        (updated_segments, manager)
        updated_segments have "speaker_id" (SPEAKER_N) and "speaker" (Speaker N).
    """
    if manager is None:
        manager = SpeakerManager()

    if not diarization_segments:
        return [], manager

    _init_embedding_backend()

    updated: List[Dict[str, Any]] = []

    for seg in diarization_segments:
        start = float(seg.get("start", 0.0) or 0.0)
        end   = float(seg.get("end",   start) or start)
        duration = end - start

        if duration < 0.1:
            # Segment too short to extract a reliable embedding
            label = "Speaker 1"
            sid   = "SPEAKER_1"
            if manager.speaker_count > 0:
                sid, label = list(manager.speaker_embeddings.keys())[0], "Speaker 1"
            updated.append({**seg, "speaker_id": sid, "speaker": label})
            continue

        samples = _load_audio_segment(wav_path, start, end, sr=sr)

        if samples is None or len(samples) < sr * 0.1:
            log.debug(f"[SpeakerManager] Could not load segment {start:.2f}s-{end:.2f}s")
            updated.append({**seg})
            continue

        embedding = extract_embedding(samples, sr)
        if embedding is None:
            log.debug(f"[SpeakerManager] Embedding failed for {start:.2f}s-{end:.2f}s")
            updated.append({**seg})
            continue

        acoustic = extract_acoustic_features(samples, sr)
        speaker_id = manager.get_or_create_speaker(embedding, acoustic)
        speaker_label = manager.get_display_label(speaker_id)

        updated.append({
            **seg,
            "speaker_id": speaker_id,
            "speaker":    speaker_label,
        })

    log.info(
        f"[SpeakerManager] Assigned {len(updated)} segments → "
        f"{manager.speaker_count} unique speakers"
    )
    return updated, manager


# ─── Normalize raw pyannote labels to SpeakerManager ────────────────────────

def normalize_pyannote_segments(
    diarization_segments: List[Dict[str, Any]],
) -> Tuple[List[Dict[str, Any]], Dict[str, str]]:
    """
    Map raw pyannote speaker IDs (e.g. "SPEAKER_00", "SPEAKER_01") to
    stable "SPEAKER_1", "SPEAKER_2" by first-appearance order.

    Returns (updated_segments, id_map).
    """
    seen: List[str] = []
    for seg in diarization_segments:
        raw = str(seg.get("speaker_id") or seg.get("speaker") or "").strip()
        if raw and raw not in seen:
            seen.append(raw)

    id_map: Dict[str, str] = {}
    for idx, raw_id in enumerate(seen, start=1):
        id_map[raw_id] = f"SPEAKER_{idx}"

    import re as _re

    updated: List[Dict[str, Any]] = []
    for seg in diarization_segments:
        raw    = str(seg.get("speaker_id") or seg.get("speaker") or "").strip()
        mapped = id_map.get(raw, "SPEAKER_1")
        m      = _re.search(r"(\d+)$", mapped)
        n      = int(m.group(1)) if m else 1
        updated.append({
            **seg,
            "speaker_id": mapped,
            "speaker":    f"Speaker {n}",
        })

    return updated, id_map
