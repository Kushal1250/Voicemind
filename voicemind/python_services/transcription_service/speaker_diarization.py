# python_services/transcription_service/speaker_diarization.py
"""
VoiceMind Speaker Diarization — v2.0
======================================

Dynamic speaker diarization using:
  1. Pyannote Audio pipeline (segmentation + diarization)
  2. SpeakerManager for ECAPA-TDNN / Resemblyzer / MFCC embeddings
  3. Cosine-similarity speaker matching (threshold=0.75)
  4. Embedding profile updating (EMA)
  5. Acoustic feature validation

Speaker labels are ALWAYS:
    Speaker 1, Speaker 2, ... Speaker N

No role names. No doctor/patient/teacher/student labels.
"""

import os
import warnings
from typing import Any, Dict, List, Optional

_PIPELINE = None
_PIPELINE_ERROR: Optional[str] = None
_PIPELINE_DEVICE: Optional[str] = None
_PIPELINE_LOAD_ATTEMPTED = False
_LAST_RUN: Dict[str, Any] = {
    "attempted": False,
    "applied": False,
    "reason": "not_run_yet",
    "speakerSegments": 0,
    "speakerCount": 0,
    "audioPath": None,
    "error": None,
}


def _env_bool(name: str, default: str = "false") -> bool:
    return os.getenv(name, default).strip().lower() in {"1", "true", "yes", "on"}


def _env_str(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def _env_float(name: str, default: str) -> float:
    try:
        return float(os.getenv(name, default).strip())
    except Exception:
        return float(default)


def _env_int(name: str, default: str) -> int:
    try:
        return int(os.getenv(name, default).strip())
    except Exception:
        return int(default)


def _to_optional_int(value: str) -> Optional[int]:
    value = str(value or "").strip()
    if not value:
        return None
    try:
        return int(value)
    except Exception:
        return None


def _settings() -> Dict[str, Any]:
    return {
        "enabled": _env_bool("ENABLE_SPEAKER_DIARIZATION", "false"),
        "safe_mode": _env_bool("WHISPER_SAFE_MODE", "false"),
        "disable_in_safe_mode": _env_bool("DIARIZATION_DISABLE_IN_SAFE_MODE", "false"),
        "hf_token": _env_str("HF_TOKEN", _env_str("HUGGINGFACE_TOKEN", "")),
        "pipeline_name": _env_str("PYANNOTE_PIPELINE_NAME", "pyannote/speaker-diarization-3.1"),
        "device": _env_str("PYANNOTE_DEVICE", "cpu").lower(),
        "trusted_checkpoints": _env_bool("PYANNOTE_TRUSTED_CHECKPOINTS", "true"),
        "num_speakers": _to_optional_int(_env_str("DIARIZATION_NUM_SPEAKERS", "")),
        "min_speakers": _to_optional_int(_env_str("DIARIZATION_MIN_SPEAKERS", "")),
        "max_speakers": _to_optional_int(_env_str("DIARIZATION_MAX_SPEAKERS", "")),
        "min_turn_duration": _env_float("MIN_SPEAKER_TURN_DURATION", "0.25"),
        "min_audio_sec": _env_float("DIARIZATION_MIN_AUDIO_SEC", "2.5"),
        "max_segments_for_run": _env_int("DIARIZATION_MAX_SEGMENTS_FOR_RUN", "220"),
        "merge_gap": _env_float("DIARIZATION_MERGE_GAP_SEC", "0.12"),
    }


def _configure_environment_defaults(settings: Dict[str, Any]) -> None:
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    if settings["trusted_checkpoints"]:
        os.environ.setdefault("TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD", "1")


def _silence_known_dependency_warnings() -> None:
    for message in [
        r".*TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD detected.*",
        r".*huggingface_hub.*cache-system uses symlinks by default.*",
        r".*torchaudio\._backend\.list_audio_backends has been deprecated.*",
        r".*torchaudio\._backend\.utils\.info has been deprecated.*",
        r".*torchaudio\._backend\.common\.AudioMetaData has been deprecated.*",
        r".*this function's implementation will be changed to use torchaudio\.load_with_torchcodec.*",
        r".*degrees of freedom is <= 0.*",
    ]:
        try:
            warnings.filterwarnings("ignore", message=message, category=UserWarning)
        except Exception:
            pass


def _register_torch_safe_globals() -> None:
    try:
        import torch

        safe_items = []
        try:
            from torch.torch_version import TorchVersion
            safe_items.append(TorchVersion)
        except Exception:
            pass
        try:
            from omegaconf import DictConfig, ListConfig
            safe_items.extend([DictConfig, ListConfig])
        except Exception:
            pass
        try:
            from pyannote.audio.core.task import Problem, Resolution, Specifications
            safe_items.extend([Problem, Resolution, Specifications])
        except Exception:
            pass
        if safe_items:
            torch.serialization.add_safe_globals(safe_items)
    except Exception:
        pass


def _patch_torchaudio_for_older_pyannote() -> None:
    try:
        import torchaudio

        if hasattr(torchaudio, "AudioMetaData"):
            return
        try:
            from torchaudio._backend.common import AudioMetaData
            torchaudio.AudioMetaData = AudioMetaData
            return
        except Exception:
            pass
        try:
            from collections import namedtuple
            torchaudio.AudioMetaData = namedtuple(
                "AudioMetaData",
                ["sample_rate", "num_frames", "num_channels", "bits_per_sample", "encoding"],
            )
        except Exception:
            pass
    except Exception:
        pass


def _patch_hf_hub_use_auth_token() -> None:
    """
    FIX: huggingface_hub >= 0.24 removed the 'use_auth_token' argument from
    hf_hub_download() and snapshot_download(). Older versions of pyannote.audio
    still pass it, causing:
        TypeError: hf_hub_download() got an unexpected keyword argument 'use_auth_token'

    This monkey-patch wraps the two affected hf_hub functions so any call that
    passes use_auth_token= silently converts it to token= instead.
    The patch is idempotent — calling it twice has no effect.
    """
    try:
        import huggingface_hub
        import functools

        _PATCHED_ATTR = "_voicemind_use_auth_token_patched"

        for fn_name in ("hf_hub_download", "snapshot_download"):
            original = getattr(huggingface_hub, fn_name, None)
            if original is None or getattr(original, _PATCHED_ATTR, False):
                continue

            @functools.wraps(original)
            def _compat_wrapper(*args, _original=original, **kwargs):
                # Convert deprecated use_auth_token → token
                if "use_auth_token" in kwargs:
                    auth = kwargs.pop("use_auth_token")
                    # Only set token if not already provided and value is truthy
                    if auth and "token" not in kwargs:
                        kwargs["token"] = auth
                return _original(*args, **kwargs)

            setattr(_compat_wrapper, _PATCHED_ATTR, True)
            setattr(huggingface_hub, fn_name, _compat_wrapper)

        # Also patch the internal cached_download if it exists (older hf_hub)
        for fn_name in ("cached_download",):
            original = getattr(huggingface_hub, fn_name, None)
            if original is None or getattr(original, _PATCHED_ATTR, False):
                continue

            @functools.wraps(original)
            def _compat_cached(*args, _original=original, **kwargs):
                kwargs.pop("use_auth_token", None)
                return _original(*args, **kwargs)

            setattr(_compat_cached, _PATCHED_ATTR, True)
            setattr(huggingface_hub, fn_name, _compat_cached)

    except Exception:
        pass  # Never crash — patch is best-effort


def _build_diarization_kwargs(settings: Dict[str, Any]) -> Dict[str, Any]:
    kwargs: Dict[str, Any] = {}
    if settings["num_speakers"] is not None:
        kwargs["num_speakers"] = settings["num_speakers"]
    else:
        if settings["min_speakers"] is not None:
            kwargs["min_speakers"] = settings["min_speakers"]
        if settings["max_speakers"] is not None:
            kwargs["max_speakers"] = settings["max_speakers"]
    return kwargs


def _set_last_run(**updates: Any) -> None:
    global _LAST_RUN
    merged = {**_LAST_RUN, **updates}
    merged["speakerCount"] = int(merged.get("speakerCount") or 0)
    merged["speakerSegments"] = int(merged.get("speakerSegments") or 0)
    _LAST_RUN = merged


def _merge_touching_segments(speakers: List[Dict[str, Any]], min_gap: Optional[float] = None) -> List[Dict[str, Any]]:
    if not speakers:
        return []
    gap_limit = _settings()["merge_gap"] if min_gap is None else float(min_gap)
    merged: List[Dict[str, Any]] = [dict(speakers[0])]
    for item in speakers[1:]:
        previous = merged[-1]
        same_speaker = str(previous.get("speaker")) == str(item.get("speaker"))
        gap = float(item.get("start", 0.0) or 0.0) - float(previous.get("end", 0.0) or 0.0)
        if same_speaker and gap <= gap_limit:
            previous["end"] = max(float(previous.get("end", 0.0) or 0.0), float(item.get("end", 0.0) or 0.0))
        else:
            merged.append(dict(item))
    return merged


def _load_pipeline():
    global _PIPELINE, _PIPELINE_ERROR, _PIPELINE_DEVICE, _PIPELINE_LOAD_ATTEMPTED

    settings = _settings()
    if _PIPELINE is not None:
        return _PIPELINE
    if _PIPELINE_LOAD_ATTEMPTED and _PIPELINE_ERROR is not None:
        return None

    _PIPELINE_LOAD_ATTEMPTED = True

    if not settings["enabled"]:
        _PIPELINE_ERROR = "speaker diarization disabled by configuration"
        return None
    if settings["safe_mode"] and settings["disable_in_safe_mode"]:
        _PIPELINE_ERROR = "speaker diarization disabled in safe mode"
        return None
    if not settings["hf_token"]:
        _PIPELINE_ERROR = "HF_TOKEN or HUGGINGFACE_TOKEN is not configured"
        return None

    try:
        _configure_environment_defaults(settings)
        _silence_known_dependency_warnings()
        _patch_torchaudio_for_older_pyannote()
        # CRITICAL FIX: patch hf_hub BEFORE importing pyannote so any internal
        # use_auth_token call inside pyannote.audio is already intercepted.
        _patch_hf_hub_use_auth_token()

        import torch
        from pyannote.audio import Pipeline

        _register_torch_safe_globals()
        # Use `token=` (current API) with `use_auth_token=` as legacy fallback.
        # The _patch_hf_hub_use_auth_token() above handles older pyannote versions
        # that still pass use_auth_token internally to hf_hub_download().
        try:
            pipeline = Pipeline.from_pretrained(
                settings["pipeline_name"],
                use_auth_token=settings["hf_token"],   # works on pyannote < 3.3
            )
        except TypeError:
            # Newer pyannote already removed use_auth_token from its own API
            pipeline = Pipeline.from_pretrained(
                settings["pipeline_name"],
                token=settings["hf_token"],            # pyannote >= 3.3
            )

        target_device = "cpu"
        if settings["device"] == "cuda" and torch.cuda.is_available():
            target_device = "cuda"

        if hasattr(pipeline, "to"):
            pipeline.to(torch.device(target_device))

        _PIPELINE = pipeline
        _PIPELINE_DEVICE = target_device
        _PIPELINE_ERROR = None
        return _PIPELINE
    except Exception as exc:
        _PIPELINE_ERROR = str(exc).strip() or "Unknown diarization error"
        return None


def is_diarization_ready() -> bool:
    s = _settings()
    return bool(s["enabled"] and s["hf_token"])


def get_diarization_skip_reason(wav_stats: Optional[Dict[str, Any]] = None, transcript_segment_count: int = 0) -> Optional[str]:
    s = _settings()
    duration = float((wav_stats or {}).get("duration", 0.0) or 0.0)
    if duration and duration < s["min_audio_sec"]:
        return "audio_too_short"
    if transcript_segment_count and transcript_segment_count > s["max_segments_for_run"]:
        return "too_many_transcript_segments"
    return None


def should_run_diarization(wav_stats: Optional[Dict[str, Any]] = None, transcript_segment_count: int = 0) -> bool:
    return get_diarization_skip_reason(wav_stats, transcript_segment_count) is None


def count_unique_speakers(speakers: List[Dict[str, Any]]) -> int:
    return len({str(item.get("speaker") or "").strip() for item in (speakers or []) if str(item.get("speaker") or "").strip()})


def diarize_audio(audio_path: str, use_speaker_manager: bool = True) -> List[Dict[str, Any]]:
    global _PIPELINE_ERROR

    settings = _settings()
    _set_last_run(
        attempted=True,
        applied=False,
        reason="initializing",
        audioPath=audio_path,
        speakerSegments=0,
        speakerCount=0,
        error=None,
    )

    pipeline = _load_pipeline()
    if pipeline is None:
        _set_last_run(reason=_PIPELINE_ERROR or "pipeline_not_available", error=_PIPELINE_ERROR)
        return []

    try:
        diarization = pipeline(audio_path, **_build_diarization_kwargs(settings))
    except Exception as exc:
        _PIPELINE_ERROR = str(exc).strip() or "pipeline execution failed"
        _set_last_run(reason="pipeline_execution_failed", error=_PIPELINE_ERROR)
        return []

    # ── Collect raw pyannote segments ────────────────────────────────────────
    raw_speakers: List[Dict[str, Any]] = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        start = float(turn.start)
        end   = float(turn.end)
        if max(0.0, end - start) < settings["min_turn_duration"]:
            continue
        raw_speakers.append({"start": start, "end": end, "speaker": str(speaker)})

    raw_speakers.sort(key=lambda item: (item["start"], item["end"], item["speaker"]))
    raw_speakers = _merge_touching_segments(raw_speakers)

    if not raw_speakers:
        _set_last_run(
            applied=False,
            reason="no_speaker_regions_detected",
            speakerSegments=0,
            speakerCount=0,
            error=None,
        )
        return []

    # ── SpeakerManager: refine with voice embeddings ─────────────────────────
    if use_speaker_manager:
        try:
            from speaker_manager import (  # type: ignore
                SpeakerManager,
                assign_speakers_with_embeddings,
                normalize_pyannote_segments,
            )
            # First normalize raw pyannote IDs to SPEAKER_1, SPEAKER_2, …
            normalized, _id_map = normalize_pyannote_segments(raw_speakers)
            # Then refine with embedding-based matching within this audio file
            manager = SpeakerManager()
            speakers, manager = assign_speakers_with_embeddings(audio_path, normalized, manager)
        except Exception as emb_exc:
            import logging as _log
            _log.getLogger(__name__).warning(
                f"[diarization] SpeakerManager unavailable, using pyannote labels only: {emb_exc}"
            )
            # Fallback: just normalize pyannote IDs
            seen: List[str] = []
            for seg in raw_speakers:
                raw = str(seg.get("speaker") or "").strip()
                if raw and raw not in seen:
                    seen.append(raw)
            id_map = {raw: f"SPEAKER_{idx}" for idx, raw in enumerate(seen, start=1)}
            import re as _re
            speakers = []
            for seg in raw_speakers:
                raw    = str(seg.get("speaker") or "").strip()
                mapped = id_map.get(raw, "SPEAKER_1")
                m      = _re.search(r"(\d+)$", mapped)
                n      = int(m.group(1)) if m else 1
                speakers.append({**seg, "speaker_id": mapped, "speaker": f"Speaker {n}"})
    else:
        # Minimal normalization without embeddings
        seen2: List[str] = []
        for seg in raw_speakers:
            raw = str(seg.get("speaker") or "").strip()
            if raw and raw not in seen2:
                seen2.append(raw)
        id_map2 = {raw: f"SPEAKER_{idx}" for idx, raw in enumerate(seen2, start=1)}
        import re as _re2
        speakers = []
        for seg in raw_speakers:
            raw    = str(seg.get("speaker") or "").strip()
            mapped = id_map2.get(raw, "SPEAKER_1")
            m      = _re2.search(r"(\d+)$", mapped)
            n      = int(m.group(1)) if m else 1
            speakers.append({**seg, "speaker_id": mapped, "speaker": f"Speaker {n}"})

    _set_last_run(
        applied=bool(speakers),
        reason="ok" if speakers else "no_speaker_regions_detected",
        speakerSegments=len(speakers),
        speakerCount=count_unique_speakers(speakers),
        error=None,
    )
    return speakers


def diarization_health(load_if_needed: bool = False) -> Dict[str, Any]:
    if load_if_needed:
        _load_pipeline()
    settings = _settings()
    return {
        "enabled": bool(settings["enabled"]),
        "configured": bool(settings["hf_token"]),
        "ready": _PIPELINE is not None,
        "loadAttempted": _PIPELINE_LOAD_ATTEMPTED,
        "pipeline": settings["pipeline_name"],
        "device": _PIPELINE_DEVICE or settings["device"],
        "trustedCheckpoints": bool(settings["trusted_checkpoints"]),
        "numSpeakers": settings["num_speakers"],
        "minSpeakers": settings["min_speakers"],
        "maxSpeakers": settings["max_speakers"],
        "minAudioSec": settings["min_audio_sec"],
        "maxSegmentsForRun": settings["max_segments_for_run"],
        "error": _PIPELINE_ERROR,
        "lastRun": dict(_LAST_RUN),
    }