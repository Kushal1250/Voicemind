# python_services/transcription_service/main.py
"""
VoiceMind Transcription Service — v16.0 PRODUCTION FIX
=======================================================

ROOT CAUSE ANALYSIS from terminal logs:
----------------------------------------

PROBLEM 1 — IndicWhisper model does NOT exist on HuggingFace (401/404)
  ai4bharat/indicwhisper-large-v2-gu → DOES NOT EXIST
  ai4bharat/indicwhisper-large-v2-hi → DOES NOT EXIST
  Fix: Use CORRECT model IDs:
    Gujarati: "ai4bharat/indic-whisper-large-v2" (multilingual Indic Whisper)
    OR the correct community model path.
    REAL FIX: Use openai/whisper-large-v2 with forced Gujarati token + proper
    language=gu decoding. The current faster-whisper gu decoder fails because
    Gujarati+English code-switched cricket commentary confuses it.
    SOLUTION: Accept English output for Gujarati sessions when the content
    is code-switched (Gujarati speakers using English cricket terms).

PROBLEM 2 — Gujarati cricket commentary is code-switched
  Speaker speaks: "wicket thayu, Gujarat Titans ne 6 ball ma 3 wicket"
  Whisper forced-gu hallucinates character repeats
  Whisper auto detects English at 0.64–0.99 (because cricket terms ARE English)
  Then gets rejected by LANG_ENFORCE as "auto_fallback_language_mismatch:en"
  Fix: When requested_lang=gu AND auto gives English AND content has Gujarati
  vocabulary markers → ACCEPT the English/romanized output as valid

PROBLEM 3 — "the the the the" hallucination in silence
  Segments with silence get "the" repeated. Already in hallucination filter
  but not catching "the" repeated 12+ times.
  Fix: Add "the" to banned consecutive patterns

PROBLEM 4 — NO_SPEECH_THRESHOLD=0.85 is too strict
  Real Gujarati speech at logp=-0.46 (good) but short pauses
  between words cause segments to be trimmed.
  Fix: Relax to 0.70

PROBLEM 5 — Gujarati auto-detected as English (en probability 0.64-0.99)
  This is because cricket commentary has: wicket, over, boundary, six, four,
  batting, bowling, IPL, Mumbai, KKR — all English words.
  The Gujarati connector words (ane, che, thi, pachi) are few.
  Fix: After accepting English auto-detected output for gu session,
  STILL tag language as gu and return it. Don't reject based on script.

PROBLEM 6 — Hindi good segments getting "karo" → skipped with "karo" repeated
  The "I am not going to" repeated 5x is hallucination from silence.
  The _consecutive_repeat_count threshold is 4 — correct. But "I am not going"
  pattern repeats as 4-gram — needs ngram threshold lowered.

WHAT v16.0 DOES:
-----------------
1. REMOVES IndicWhisper (wrong model IDs — cannot load)
2. ACCEPTS English/romanized output for gu/hi sessions when content
   contains Gujarati/Hindi vocabulary markers (code-switched speech)
3. Adds "the" consecutive repeat filter
4. Fixes NO_SPEECH_THRESHOLD: 0.85 → 0.70
5. Fixes LOG_PROB_THRESHOLD: -2.0 → -1.5
6. Adds Silero VAD as optional noise gate (free, runs on CPU)
7. Adds WhisperX word-level confidence filtering
8. Adds output post-filter: removes trailing/leading "the the the" patterns
9. Improves Gujarati code-switch acceptance logic
10. Uses ai4bharat/indic-whisper-large-v2 (CORRECT model) as optional fallback
"""

import gc
import logging
import os
import re
import subprocess
import tempfile
import threading
import shutil
import time
import requests
from collections import Counter, deque
from pathlib import Path
from typing import Any, Dict, List, Optional, Deque

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from google import genai as _genai
from google.genai import types as _genai_types

try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

# CPU thread limits
# FIX: Raise thread counts from 2→6 for 3–5x CPU inference speedup
os.environ.setdefault("OMP_NUM_THREADS",  os.getenv("WHISPER_CPU_THREADS", "6"))
os.environ.setdefault("MKL_NUM_THREADS",  os.getenv("WHISPER_CPU_THREADS", "6"))
os.environ.setdefault("CT2_NUM_THREADS",  os.getenv("WHISPER_CPU_THREADS", "6"))
os.environ.setdefault("CT2_USE_EXPERIMENTAL_PACKED_GEMM", "1")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
)
log = logging.getLogger(__name__)

# ── helpers ───────────────────────────────────────────────────────────────────
def _env_bool(name: str, default: bool = False) -> bool:
    return os.getenv(name, str(default)).strip().lower() in ("1", "true", "yes", "y", "on")

def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)).strip())
    except Exception:
        return default

def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)).strip())
    except Exception:
        return default

# ── Gemini Transcription model config ────────────────────────────────────────
GEMINI_MODEL               = os.getenv("GEMINI_MODEL", "gemini-3.5-flash")
GOOGLE_API_KEY             = os.getenv("GOOGLE_API_KEY", "AQ.Ab8RN6LDUM4cnAkQDJnCz2nEZsuBLIWDpRw787TVLj1ud18PyQ")
PORT                       = _env_int("PORT", _env_int("SERVICE_PORT", 8001))

AUDIO_PREPROCESS_MODE      = os.getenv("AUDIO_PREPROCESS_MODE", "enhanced").strip().lower()
MIN_CHUNK_DURATION_SEC     = _env_float("MIN_CHUNK_DURATION_SEC", 0.3)
REJECT_BAD_CHUNKS          = _env_bool("REJECT_BAD_CHUNKS", True)
ENABLE_DEMUCS              = _env_bool("ENABLE_DEMUCS_PREPROCESS", False)
OUTPUT_SCRIPT_MODE         = os.getenv("OUTPUT_SCRIPT_MODE", "preserve").strip().lower()

_UNSUPPORTED_LANGUAGES = {
    "jw", "jv", "es", "ur", "bn", "id", "ja", "ko", "zh", "pt", "ar",
    "tr", "ms", "tl", "uk", "ru", "ta", "te", "ml", "mr", "pa", "ne", "fa",
}

ENABLE_LM_STUDIO_CLEANUP = _env_bool("ENABLE_LM_STUDIO_CLEANUP", False)
LM_STUDIO_BASE_URL = os.getenv("LM_STUDIO_BASE_URL", "http://localhost:1234/v1").rstrip("/")
LM_STUDIO_MODEL    = os.getenv("LM_STUDIO_MODEL", "local-model")

ENABLE_DIARIZATION = _env_bool("ENABLE_SPEAKER_DIARIZATION", False)
HF_TOKEN           = os.getenv("HF_TOKEN", "")

FFMPEG_BIN  = os.getenv("FFMPEG_BIN", "ffmpeg")
FFPROBE_BIN = os.getenv(
    "FFPROBE_BIN",
    FFMPEG_BIN.replace("ffmpeg.exe", "ffprobe.exe").replace("ffmpeg", "ffprobe"),
)
try:
    _r = subprocess.run([FFMPEG_BIN, "-version"], capture_output=True)
    if _r.returncode != 0:
        raise FileNotFoundError
except (FileNotFoundError, OSError):
    try:
        import imageio_ffmpeg
        FFMPEG_BIN  = imageio_ffmpeg.get_ffmpeg_exe()
        FFPROBE_BIN = FFMPEG_BIN.replace("ffmpeg", "ffprobe")
        log.info(f"Using imageio-ffmpeg: {FFMPEG_BIN}")
    except Exception:
        log.warning("ffmpeg not found.")

WHISPER_PASS_INITIAL_PROMPT = _env_bool("WHISPER_PASS_INITIAL_PROMPT", True)

# FIX: Sports/cricket initial prompt stabilises Whisper decoding on commentary.
# Providing expected vocabulary reduces hallucinations by anchoring the decoder
# to real cricket terminology used in Gujarati/Hindi commentary.
# FIX: Expanded sports initial prompt for IPL 2025 cricket commentary.
# Providing rich domain vocabulary anchors Whisper's decoder to real words,
# dramatically reducing hallucinations on Gujarati/Hindi cricket audio.
# Includes: team names, player names, cricket terms, Gujarati connectors, Hindi connectors.
_SPORTS_INITIAL_PROMPT = (
    "Gujarati Hindi cricket commentary. IPL 2025. "
    "Teams: Gujarat Titans, Mumbai Indians, Chennai Super Kings, CSK, KKR, Kolkata Knight Riders, "
    "RCB, Royal Challengers Bangalore, SRH, Sunrisers Hyderabad, LSG, Lucknow Super Giants, "
    "DC, Delhi Capitals, PBKS, Punjab Kings, RR, Rajasthan Royals. "
    "Players: Shubman Gill, Hardik Pandya, Rashid Khan, Mohammed Siraj, Jasprit Bumrah, "
    "Virat Kohli, Rohit Sharma, MS Dhoni, Rinku Singh, Yashasvi Jaiswal, "
    "KL Rahul, Sanju Samson, Rishabh Pant, David Warner, Pat Cummins. "
    "Cricket terms: wicket, boundary, six, four, over, powerplay, DRS review, umpire, "
    "no-ball, wide, run-out, caught, bowled, LBW, batting, bowling, fielding, "
    "strike rate, run rate, required rate, partnership, innings, maiden over, "
    "qualifier, eliminator, final, playoff, Q1, Q2, Eliminate. "
    "Gujarati: ane, che, chhe, thi, pachi, mane, tamne, kem, shu, pan, have, "
    "avyo, gayo, aavyu, thayun, karyu, joyu, mukyu, nakhu, lidhu, aapyu, "
    "viket, baetsman, bollar, choggo, chhaggo, umpire, boundary, over, run. "
    "Hindi: hai, hain, nahi, karo, kar, aaya, gaya, raha, rahi, tha, thi, "
    "kya, kyun, kaise, tab, jab, phir, lekin, aur, ya, to, se, ne, ko, ka, ki, ke."
)

# ── Cross-chunk cache ─────────────────────────────────────────────────────────
_CHUNK_TEXT_CACHE: Dict[str, Deque[str]] = {}
_CACHE_LOCK = threading.Lock()

def _cache_get_last(lang: str) -> Optional[str]:
    with _CACHE_LOCK:
        q = _CHUNK_TEXT_CACHE.get(lang)
        return q[-1] if q else None

def _cache_push(lang: str, text: str) -> None:
    with _CACHE_LOCK:
        if lang not in _CHUNK_TEXT_CACHE:
            _CHUNK_TEXT_CACHE[lang] = deque(maxlen=3)
        _CHUNK_TEXT_CACHE[lang].append(text)

def _is_cross_chunk_repeat(text: str, lang: str) -> bool:
    if not text or len(text) < 30:
        return False
    last = _cache_get_last(lang)
    if not last or len(last) < 20:
        return False
    words_new  = set(re.findall(r"\w+", text.lower(),  flags=re.U))
    words_last = set(re.findall(r"\w+", last.lower(), flags=re.U))
    if not words_new or not words_last:
        return False
    overlap = len(words_new & words_last) / max(len(words_new), len(words_last))
    _cross_threshold = float(os.getenv("CROSS_SEGMENT_REPEAT_THRESHOLD", "0.65"))
    if overlap > _cross_threshold:
        log.info(f"[CROSS_CHUNK_REPEAT] overlap={overlap:.2f} rejecting: {text[:80]}")
        return True
    return False

def dedupe_overlap(prev_text: str, current_text: str, max_window: int = 12) -> str:
    """
    FIX: Token-level overlap suppression between adjacent chunks.
    Prevents cross-segment duplication when chunk boundaries split mid-sentence.
    Example: prev ends with 'ball hit the boundary'
             current starts with 'hit the boundary for six'
             → returns 'for six' (removes duplicated prefix)
    """
    if not prev_text or not current_text:
        return current_text
    prev_words = re.findall(r"[\w\u0900-\u097F\u0A80-\u0AFF]+", prev_text.lower(), flags=re.U)
    curr_words = re.findall(r"[\w\u0900-\u097F\u0A80-\u0AFF]+", current_text.lower(), flags=re.U)
    curr_original = re.findall(r"\S+", current_text)

    max_overlap = min(max_window, len(prev_words), len(curr_words))

    for n in range(max_overlap, 1, -1):
        if prev_words[-n:] == curr_words[:n]:
            # Remove the duplicated prefix tokens from current text
            deduped_tokens = curr_original[n:] if n < len(curr_original) else []
            result = " ".join(deduped_tokens).strip()
            if result:
                log.info(f"[DEDUPE_OVERLAP] Removed {n} overlapping words from chunk start")
                return result
    return current_text

# ── Gemini Transcription client ──────────────────────────────────────────────
log.info("=" * 60)
log.info(f"Gemini Transcription: model={GEMINI_MODEL}")
log.info(f"  output_script_mode={OUTPUT_SCRIPT_MODE}")
log.info("=" * 60)

if not GOOGLE_API_KEY:
    log.warning("GOOGLE_API_KEY is not set — transcription calls will fail")

_gemini_client = _genai.Client(api_key=GOOGLE_API_KEY) if GOOGLE_API_KEY else None
_lock = threading.Lock()
log.info("Gemini Transcription client ready ✓")

# ── Silero VAD (standalone gate — separate from Whisper built-in VAD) ─────────
# FIX: Real Silero VAD for pre-transcription silence gating.
# Whisper hallucinates heavily on silence ("the the the", English phrases).
# Pre-gating with Silero removes silence BEFORE Whisper sees the audio,
# which eliminates the root cause of most English hallucinations on Gujarati audio.
_silero_vad_model = None
_silero_vad_loaded = False
VAD_STANDALONE_ENABLED = _env_bool("VAD_STANDALONE_ENABLED", True)
VAD_THRESHOLD = _env_float("VAD_THRESHOLD", 0.52)
VAD_MIN_SPEECH_RATIO = _env_float("VAD_MIN_SPEECH_RATIO", 0.18)

def _try_load_silero_vad():
    global _silero_vad_model, _silero_vad_loaded
    if not VAD_STANDALONE_ENABLED:
        log.info("Silero VAD standalone disabled by config")
        return
    try:
        import torch
        from silero_vad import load_silero_vad
        _silero_vad_model = load_silero_vad()
        _silero_vad_loaded = True
        log.info("Silero VAD standalone loaded ✓")
    except ImportError:
        log.warning("silero-vad not installed — pip install silero-vad to enable standalone VAD gate")
    except Exception as e:
        log.warning(f"Silero VAD load failed: {e}")

threading.Thread(target=_try_load_silero_vad, daemon=True).start()

def check_speech_ratio_silero(wav_path: str) -> float:
    """
    Return ratio of speech frames vs total frames using Silero VAD.
    Returns 1.0 (assume all speech) if VAD model not loaded.
    """
    if not _silero_vad_loaded or _silero_vad_model is None:
        return 1.0
    try:
        import torch
        import torchaudio
        from silero_vad import get_speech_timestamps

        waveform, sr = torchaudio.load(wav_path)
        if sr != 16000:
            waveform = torchaudio.functional.resample(waveform, sr, 16000)
        audio_tensor = waveform.squeeze(0)
        total_samples = max(1, audio_tensor.shape[0])

        speech_timestamps = get_speech_timestamps(
            audio_tensor,
            _silero_vad_model,
            threshold=VAD_THRESHOLD,
            min_speech_duration_ms=250,
            min_silence_duration_ms=150,
            return_seconds=False,
        )
        speech_samples = sum(t["end"] - t["start"] for t in speech_timestamps)
        ratio = speech_samples / total_samples
        log.info(f"[SILERO_VAD] speech_ratio={ratio:.3f} ({len(speech_timestamps)} speech segments)")
        return ratio
    except Exception as e:
        log.warning(f"[SILERO_VAD] check failed: {e}")
        return 1.0  # fail-open: assume speech present

# ── Optional normalizer ───────────────────────────────────────────────────────
try:
    from multilingual_normalizer import (
        apply_desired_normalization,
        clean_roman_output,
        detect_language,
        is_placeholder_text,
        gujarati_lexicon_status,
        hindi_lexicon_status,
    )
    _HAS_NORMALIZER = True
    log.info("multilingual_normalizer ✓")
except ImportError as e:
    _HAS_NORMALIZER = False
    log.warning(f"multilingual_normalizer not available: {e}")
    def apply_desired_normalization(text, language=None): return text
    def clean_roman_output(text): return text
    def detect_language(text): return "en"
    def is_placeholder_text(text): return False
    def gujarati_lexicon_status(): return "normalizer_missing"
    def hindi_lexicon_status(): return "normalizer_missing"

try:
    from conversation_formatter import (
        assign_all_to_speaker_1,
        group_segments_into_turns,
        build_conversation_text,
        count_unique_speakers,
        normalize_speaker_ids,
        assign_speakers_by_time_overlap,
    )
    _HAS_FORMATTER = True
    log.info("conversation_formatter ✓")
except ImportError as e:
    _HAS_FORMATTER = False
    log.warning(f"conversation_formatter not available: {e}")
    def assign_all_to_speaker_1(segs):
        return [{**s, "speaker_id": "SPEAKER_1", "speaker": "Speaker 1"} for s in segs]
    def group_segments_into_turns(segs, merge_gap_sec=2.0):
        return [{"speaker": "Speaker 1", "speaker_id": "SPEAKER_1",
                 "start": s.get("start", 0), "end": s.get("end", 0),
                 "text": s.get("text", ""), "source_text": s.get("source_text", ""),
                 "segment_count": 1} for s in segs if s.get("text")]
    def build_conversation_text(turns, diarization_applied=False):
        return "\n\n".join(f"{t['speaker']}: {t['text']}" for t in turns if t.get("text"))
    def count_unique_speakers(turns): return 1
    def normalize_speaker_ids(segs): return segs, {}
    def assign_speakers_by_time_overlap(asr_segs, diar_segs):
        return assign_all_to_speaker_1(asr_segs)

# ── Diarization ───────────────────────────────────────────────────────────────
_pyannote_pipeline = None
_diarization_load_error = ""

def _try_load_diarization():
    global _pyannote_pipeline, _diarization_load_error
    if not ENABLE_DIARIZATION:
        _diarization_load_error = "ENABLE_SPEAKER_DIARIZATION=false"
        log.info("Diarization disabled by config")
        return
    if not HF_TOKEN:
        _diarization_load_error = "HF_TOKEN not set"
        return
    try:
        from pyannote.audio import Pipeline
        _pyannote_pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1", use_auth_token=HF_TOKEN)
        log.info("pyannote diarization loaded ✓")
    except Exception as e:
        _diarization_load_error = str(e)
        log.warning(f"pyannote load failed: {e}")

threading.Thread(target=_try_load_diarization, daemon=True).start()

def run_diarization(wav_path: str) -> Dict[str, Any]:
    if not ENABLE_DIARIZATION:
        return {"attempted": False, "applied": False, "speaker_count": 1,
                "method": "none", "segments": [], "reason": "disabled", "error": None}
    if _pyannote_pipeline is None:
        return {"attempted": True, "applied": False, "speaker_count": 1,
                "method": "none", "segments": [], "reason": "pipeline not loaded",
                "error": _diarization_load_error}
    try:
        diarization = _pyannote_pipeline(wav_path)
        raw_segments = [
            {"start": round(turn.start, 3), "end": round(turn.end, 3), "speaker_id": speaker}
            for turn, _, speaker in diarization.itertracks(yield_label=True)
        ]
        if not raw_segments:
            return {"attempted": True, "applied": False, "speaker_count": 1,
                    "method": "pyannote", "segments": [], "reason": "no segments", "error": None}
        norm_segs, id_map = normalize_speaker_ids(raw_segments)
        return {"attempted": True, "applied": True, "speaker_count": len(id_map),
                "method": "pyannote", "segments": norm_segs, "reason": "", "error": None}
    except Exception as e:
        log.warning(f"Diarization runtime error: {e}")
        return {"attempted": True, "applied": False, "speaker_count": 1,
                "method": "pyannote", "segments": [], "reason": "runtime error", "error": str(e)}

# ── Pydantic models ───────────────────────────────────────────────────────────
class TranscribeRequest(BaseModel):
    audio_path: str
    language: str = "auto"
    speaker_id: str = "SPEAKER_1"

class SegmentOut(BaseModel):
    start: float
    end: float
    text: str
    source_text: str = ""
    speaker: str = "Speaker 1"
    speaker_id: str = "SPEAKER_1"
    language: str = ""
    confidence: Optional[float] = None

class TurnOut(BaseModel):
    speaker: str
    speaker_id: str
    start: float
    end: float
    text: str
    segment_count: int = 1

class TranscribeResponse(BaseModel):
    success: bool
    status: str
    transcript_status: str = ""
    text: str = ""
    conversation_text: str = ""
    segments: List[SegmentOut] = []
    turns: List[TurnOut] = []
    language: str = ""
    detected_languages: List[str] = []
    speaker_id: str = "SPEAKER_1"
    speaker_count: int = 1
    needs_review: bool = False
    diarization: Dict[str, Any] = {}
    raw_text: str = ""
    normalized_text: str = ""
    coverage_ratio: float = 0.0
    confidence: str = "unknown"
    model_used: str = ""
    fallback_used: bool = False
    rejection_reason: str = ""
    duration_sec: float = 0.0

# ── Audio preprocessing ───────────────────────────────────────────────────────
def convert_to_wav(input_path: str, output_path: str) -> bool:
    """
    FIX v19: Production-grade FFmpeg filter chain for Gujarati/Indic speech.
    - highpass=f=120: removes low-frequency crowd rumble (cricket stadiums)
    - lowpass=f=7600: removes high-frequency noise while preserving speech
    - aresample=async=1: fixes timestamp drift from broken WebM chunks
    - loudnorm: consistent volume for Whisper
    Gujarati consonants are mid-frequency heavy (700–4000 Hz) — this chain
    preserves that range while removing stadium noise that causes hallucinations.
    """
    enhanced_filter = (
        "aresample=async=1:min_hard_comp=0.100:first_pts=0,"
        "highpass=f=120,"
        "afftdn=nf=-25,"           # stronger noise floor reduction for cricket/crowd
        "lowpass=f=7600,"
        "dynaudnorm=f=150:g=15,"
        "loudnorm=I=-23:LRA=7:TP=-2"
    )
    plain_filter = "aresample=16000"

    commands = []
    if AUDIO_PREPROCESS_MODE == "enhanced":
        commands.append(("enhanced", [
            FFMPEG_BIN, "-y",
            "-fflags", "+genpts",      # FIX: generate missing PTS timestamps
            "-i", input_path,
            "-map", "0:a:0?", "-ac", "1", "-ar", "16000", "-vn",
            "-af", enhanced_filter,
            "-acodec", "pcm_s16le", output_path,
        ]))
    commands.append(("plain", [
        FFMPEG_BIN, "-y", "-fflags", "+genpts", "-i", input_path,
        "-map", "0:a:0?", "-ac", "1", "-ar", "16000", "-vn",
        "-acodec", "pcm_s16le", output_path,
    ]))

    for mode, cmd in commands:
        result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode == 0 and get_audio_duration(output_path) >= MIN_CHUNK_DURATION_SEC:
            log.info(f"[FFMPEG] Converted {Path(input_path).name} → WAV ({mode})")
            return True
        log.warning(f"[FFMPEG] {mode} failed: {result.stderr.decode(errors='replace')[:200]}")

    # Stage 3: remux then plain
    ext = Path(input_path).suffix or ".webm"
    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
        remux_path = tmp.name
    try:
        if remux_webm(input_path, remux_path):
            result = subprocess.run([
                FFMPEG_BIN, "-y", "-i", remux_path,
                "-map", "0:a:0?", "-ac", "1", "-ar", "16000", "-vn",
                "-acodec", "pcm_s16le", output_path,
            ], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if result.returncode == 0 and get_audio_duration(output_path) >= MIN_CHUNK_DURATION_SEC:
                log.info(f"[FFMPEG] Converted via remux+plain")
                return True
    finally:
        try:
            os.unlink(remux_path)
        except OSError:
            pass
    return False

def get_audio_duration(path: str) -> float:
    """
    FIX (Bug 1c): Browser MediaRecorder produces fragmented WebM. ffprobe only reads
    the container-level format.duration which is always 0 or absent for fragmented WebM.
    Stream-level duration IS present in fragmented WebM. We try 2 passes.
    """
    # Pass 1: container-level duration (works for MP4, WAV, OGG; NOT fragmented WebM)
    cmd = [FFPROBE_BIN, "-v", "error", "-show_entries", "format=duration",
           "-of", "default=noprint_wrappers=1:nokey=1", path]
    try:
        out = subprocess.check_output(cmd, stderr=subprocess.DEVNULL).decode().strip()
        val = max(0.0, float(out)) if out else 0.0
        if val > 0.05:
            return val
    except Exception:
        pass

    # Pass 2: stream-level duration (fragmented WebM from MediaRecorder stores it here)
    cmd2 = [FFPROBE_BIN, "-v", "error", "-select_streams", "a:0",
            "-show_entries", "stream=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", path]
    try:
        out2 = subprocess.check_output(cmd2, stderr=subprocess.DEVNULL).decode().strip()
        val2 = max(0.0, float(out2)) if out2 else 0.0
        if val2 > 0.05:
            log.info(f"[FFPROBE] stream-level fallback duration={val2:.3f}s for {Path(path).name}")
            return val2
    except Exception:
        pass

    return 0.0

def get_wav_rms(path: str) -> float:
    try:
        import wave, audioop
        with wave.open(path, "rb") as wf:
            frames = wf.readframes(min(wf.getnframes(), wf.getframerate() * 30))
            return float(audioop.rms(frames, wf.getsampwidth())) if frames else 0.0
    except Exception:
        return 0.0

def remux_webm(input_path: str, output_path: str) -> bool:
    # FIX: -fflags +genpts regenerates missing PTS/DTS timestamps in broken WebM fragments
    # This is the root cause of ffprobe_duration=0.0000s from MediaRecorder partial chunks
    before_dur = get_audio_duration(input_path)
    cmd = [FFMPEG_BIN, "-y", "-fflags", "+genpts", "-i", input_path, "-c", "copy", output_path]
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode == 0:
        after_dur = get_audio_duration(output_path)
        log.info(f"[REMUX] success: before={before_dur:.3f}s → after={after_dur:.3f}s")
        return True
    log.warning(f"[REMUX] failed: {result.stderr.decode(errors='replace')[:300]}")
    return False

def validate_and_repair_chunk(input_path: str) -> Optional[str]:
    """
    FIX (Bug 4): Previously called get_audio_duration() which returned 0.0 for all fragmented
    WebM (Bug 1c). A valid 60s chunk at 64kbps is ~480KB. The condition
    (file_size > 50_000 AND raw_dur < 0.1) was ALWAYS true → remux fired for every single chunk.
    After Bug 1c fix, get_audio_duration() returns the real value, so the fast path works.
    Also added post-remux validation to verify the remux actually produced valid audio.
    """
    file_size = Path(input_path).stat().st_size
    raw_dur   = get_audio_duration(input_path)   # now returns real duration after Bug 1c fix
    log.info(f"[CHUNK_VALIDATE] size={file_size} ffprobe_duration={raw_dur:.4f}s")

    # Fast path: duration is valid — skip remux entirely
    if raw_dur >= MIN_CHUNK_DURATION_SEC:
        log.info(f"[CHUNK_VALIDATE] valid, skip remux → duration={raw_dur:.4f}s")
        return input_path

    # Only attempt remux if file is large (real audio) but ffprobe still returned near-zero
    # (happens when container probe fails even after stream-level fallback — truly broken header)
    is_large_file = file_size > 50_000  # >50KB = at least several seconds at 64kbps

    if is_large_file and raw_dur < 0.1:
        estimated_min_sec = file_size / (8000 * 2)  # 64kbps with 2x safety margin
        log.warning(f"[CHUNK_VALIDATE] invalid_webm_chunk_duration_mismatch: "
                    f"size={file_size} (≈{estimated_min_sec:.1f}s min) "
                    f"but ffprobe={raw_dur:.4f}s — attempting remux")
        ext = Path(input_path).suffix or ".webm"
        with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
            remux_path = tmp.name
        if remux_webm(input_path, remux_path):
            # FIX: validate remux output — don't return a still-broken file
            repaired_dur = get_audio_duration(remux_path)
            if repaired_dur >= MIN_CHUNK_DURATION_SEC:
                log.info(f"[CHUNK_VALIDATE] remux success: new_duration={repaired_dur:.3f}s")
                return remux_path
            log.warning(f"[CHUNK_VALIDATE] remux produced invalid duration={repaired_dur:.3f}s — discarding")
            try: os.unlink(remux_path)
            except OSError: pass
        return None

    if raw_dur > 0 and raw_dur < MIN_CHUNK_DURATION_SEC:
        log.warning(f"[CHUNK_VALIDATE] too_short: {raw_dur:.4f}s < {MIN_CHUNK_DURATION_SEC}s")
        return None

    return input_path

def maybe_extract_vocals(input_path: str) -> str:
    if not ENABLE_DEMUCS or shutil.which("demucs") is None:
        return input_path
    tmp_dir = tempfile.mkdtemp(prefix="voicemind_demucs_")
    try:
        cmd = ["demucs", "--two-stems=vocals", "-o", tmp_dir, input_path]
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=900)
        candidates = list(Path(tmp_dir).glob("**/vocals.wav"))
        if res.returncode == 0 and candidates:
            out = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
            out.close()
            shutil.copyfile(str(candidates[0]), out.name)
            return out.name
    except Exception as e:
        log.warning(f"[DEMUCS] skipped: {e}")
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
    return input_path

ENABLE_DEEPFILTERNET = _env_bool("ENABLE_DEEPFILTERNET", False)

def maybe_apply_deepfilter(wav_path: str) -> str:
    """
    FIX: Optional DeepFilterNet noise enhancement for cricket/crowd audio.
    Improves Gujarati accuracy +5-15% on noisy audio (TV commentary, mobile, crowd).
    Requires: pip install deepfilternet
    Enable via: ENABLE_DEEPFILTERNET=true
    NOTE: disabled by default as it adds ~5-15s CPU processing per chunk.
    """
    if not ENABLE_DEEPFILTERNET:
        return wav_path
    try:
        from df.enhance import enhance, init_df
        import soundfile as sf
        import numpy as np

        df_state, _ = init_df()
        audio, sr = sf.read(wav_path)
        if len(audio.shape) > 1:
            audio = audio.mean(axis=1)
        enhanced_audio = enhance(df_state, audio)

        out = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        out.close()
        sf.write(out.name, enhanced_audio, sr)
        log.info(f"[DEEPFILTERNET] Enhanced audio: {wav_path} → {out.name}")
        return out.name
    except ImportError:
        log.warning("[DEEPFILTERNET] Not installed — pip install deepfilternet")
        return wav_path
    except Exception as e:
        log.warning(f"[DEEPFILTERNET] Enhancement failed: {e}")
        return wav_path

# ── Script density ────────────────────────────────────────────────────────────
def _script_density(text: str) -> Dict[str, float]:
    total = max(1, len(re.sub(r"\s+", "", text or "")))
    gu = len(re.findall(r"[\u0A80-\u0AFF]", text or ""))
    hi = len(re.findall(r"[\u0900-\u097F]", text or ""))
    en = len(re.findall(r"[A-Za-z]", text or ""))
    return {"gu": gu / total, "hi": hi / total, "en": en / total}

def _validate_script_match(text: str, requested_lang: str) -> Optional[str]:
    """
    FIX: Script-ratio validation per guide.
    Rejects output where the script density doesn't match the requested language.
    For code-switched commentary (gu session → English output with Gujarati vocab),
    we ACCEPT instead of reject — cricket commentary legitimately mixes scripts.
    Returns rejection reason string or None if valid.
    """
    if not text or not requested_lang or requested_lang in ("auto", "mixed"):
        return None
    dens = _script_density(text)
    wc = len(re.findall(r"\w+", text, flags=re.U))

    if requested_lang == "gu":
        # Accept if: has Gujarati script, OR has Gujarati vocab markers (code-switch), OR short text
        has_gu_script = dens["gu"] >= 0.10
        has_gu_vocab  = len(_GU_VOCAB_MARKERS.findall(text)) >= 1 if wc >= 3 else True
        if not has_gu_script and not has_gu_vocab and wc >= 8:
            # Pure English with no Gujarati indicators — likely hallucination
            en_only = dens["en"] >= 0.85
            if en_only:
                log.info(f"[SCRIPT_MISMATCH] gu requested but pure English output: dens={dens}")
                return "selected_language_script_mismatch:gu_pure_english"
    elif requested_lang == "hi":
        has_hi_script = dens["hi"] >= 0.10
        has_hi_vocab  = len(_HI_MARKERS.findall(text)) >= 1 if wc >= 3 else True
        if not has_hi_script and not has_hi_vocab and wc >= 8:
            en_only = dens["en"] >= 0.85
            if en_only:
                log.info(f"[SCRIPT_MISMATCH] hi requested but pure English output: dens={dens}")
                return "selected_language_script_mismatch:hi_pure_english"
    return None

# ── Gujarati vocabulary markers in romanized/English output ───────────────────
# FIX 2: These identify Gujarati code-switched speech even when Whisper outputs English
_GU_VOCAB_MARKERS = re.compile(
    r"(?:^|\b)(Gujarat|Titans|Hardik|Pandya|Shubman|Gill|Rashid|Khan|"
    r"Rinku|Singh|Washington|Sundar|Bumrah|Rohit|Kohli|"
    r"Dhoni|CSK|KKR|RCB|MI|GT|SRH|LSG|DC|PBKS|RR|"
    r"wicket|boundary|powerplay|sixer|four|IPL|T20|"
    r"ane|che|chhe|thi|mane|tame|kem|shu|pan|pachi|"
    r"avjo|chalo|bahu|namaste|saheb|dava|allergy|chamdi|"
    r"su|tame|tamne|ama|tema|ahiya|tyan|have|pehla|pachhi|"
    r"viket|baetsman|bollar|over|run|umpire|commentary|"
    r"choggo|chhaggo|majama|kemon|ketlak|vadhu|ochhu|"
    r"Gujarat|Ahmedabad|Surat|Vadodara|Rajkot|Bhavnagar)(?:\b|$)",
    re.I,
)

_HI_VOCAB_MARKERS = re.compile(
    r"(?:^|\b)(hai|hain|nahi|karo|kiya|aaya|gaya|raha|rahi|"
    r"lekin|kyunki|jab|tab|phir|abhi|wahan|yahan|"
    r"achha|theek|bilkul|zaroor|aur|ya|par|se|ne|ko|"
    r"mein|men|ka|ki|ke|pe|doctor|saheb|dawa|tablet)(?:\b|$)",
    re.I,
)

def _count_gu_vocab(text: str) -> int:
    return len(_GU_VOCAB_MARKERS.findall(text))

def _count_hi_vocab(text: str) -> int:
    return len(_HI_VOCAB_MARKERS.findall(text))

# ── FIX 6: Output post-cleaner ────────────────────────────────────────────────
def _clean_output_text(text: str) -> str:
    """
    Remove hallucination artifacts from otherwise good transcriptions.
    - "the the the the" repeated silence segments
    - Trailing/leading filler sounds
    - Any word repeated 3+ times consecutively (FIX per guide)
    """
    if not text:
        return text

    # FIX 3: Remove repeated "the" / "oh" patterns (stadium background noise)
    text = re.sub(r"(\bthe\b\s+){3,}", "", text, flags=re.I)
    text = re.sub(r"(\boh\b\s+){4,}", "", text, flags=re.I)
    text = re.sub(r"(\buh\b\s+){3,}", "", text, flags=re.I)
    text = re.sub(r"(\bhm+\b\s*){3,}", "", text, flags=re.I)

    # FIX per guide: Remove any word repeated 3+ times in a row
    # Catches: "hello hello hello hello" → "hello"
    # Also catches Gujarati/Hindi repeated tokens
    text = re.sub(r"(\b\w+\b)( \1\b){2,}", r"\1", text, flags=re.I | re.U)

    # Clean up multiple spaces
    text = re.sub(r"\s{2,}", " ", text).strip()

    # Remove segment if it's now empty or only punctuation
    if re.match(r"^[.,!? ]+$", text):
        return ""

    return text

# ── Hallucination guard ───────────────────────────────────────────────────────
_BANNED_PHRASES = [
    re.compile(r"thanks?\s+for\s+watching", re.I),
    re.compile(r"thank\s+you\s+(very\s+much\s+)?for\s+watching", re.I),
    re.compile(r"please\s+(like\s+and\s+)?(subscribe|share)", re.I),
    re.compile(r"don'?t\s+forget\s+to\s+subscribe", re.I),
    re.compile(r"like\s+and\s+subscribe", re.I),
    re.compile(r"hit\s+the\s+bell\s+(icon|button)", re.I),
    re.compile(r"(no,?\s+){4,}", re.I),
    re.compile(r"(yes,?\s+){4,}", re.I),
    re.compile(r"(आप\s+){3,}", re.U),
    re.compile(r"(the\s+){5,}", re.I),           # FIX 3: "the the the" hallucination
    re.compile(r"(I am not going to\s*){3,}", re.I),  # FIX 6
]

def _has_banned_phrase(text: str) -> bool:
    for pat in _BANNED_PHRASES:
        if pat.search(text):
            return True
    return False

_HALLUCINATION_REGEXES = [
    re.compile(r"(\b\w{1,5}\b)(\s+\1){4,}", re.I | re.U),
    re.compile(r"(.\s*)\1{6,}", re.U),
    re.compile(r"([^\s.!?,]{2,15})(\s+\1){3,}", re.I | re.U),
    re.compile(r"^[\s.,!?।\-–—…()\[\]]*$"),
    re.compile(r"^[\u0A80-\u0AFF\s]{1,8}$", re.U),
    re.compile(r"^[\u0900-\u097F\s]{1,8}$", re.U),
    re.compile(r"\bau\s+matra\b", re.I),
    re.compile(r"\bndi\s+ndi\b", re.I),
    re.compile(r"[ૌ]\s+[ૌ]"),
    re.compile(r"।\s+।"),
    re.compile(r"(music|♪|♫|\[music\]|\[applause\]|\[laughter\])", re.I),
    re.compile(r"thank\s+you\s+for\s+watching", re.I),
    re.compile(r"subtitles?\s+by", re.I),
    re.compile(r"www\.\w+\.com", re.I),
    # FIX: Counting-sequence hallucination — Whisper counts numbers during silence
    # Logs showed: "10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28"
    re.compile(r"^(\s*\d{1,3}\s+){6,}\s*$"),          # 6+ standalone numbers only
    re.compile(r"(\b\d{1,3}\b\s*){10,}"),              # 10+ consecutive numbers anywhere
]

_PROMPT_ECHO_PATTERNS = [
    re.compile(r"transcribe only the words", re.I),
    re.compile(r"do not translate", re.I),
    re.compile(r"multi.?speaker\s+meeting", re.I),
    re.compile(r"preserve\s+speaker\s+changes", re.I),
]

def _is_prompt_echo(text: str) -> bool:
    return any(p.search(text) for p in _PROMPT_ECHO_PATTERNS)

def _repetition_ratio(text: str) -> float:
    tokens = re.findall(r"\b\w+\b", text.lower())
    if len(tokens) < 4:
        return 0.0
    c = Counter(tokens)
    return c.most_common(1)[0][1] / len(tokens)

def _consecutive_repeat_count(text: str) -> int:
    tokens = re.findall(r"\b\w+\b", text.lower())
    if not tokens:
        return 0
    max_run = current_run = 1
    for i in range(1, len(tokens)):
        if tokens[i] == tokens[i - 1]:
            current_run += 1
            max_run = max(max_run, current_run)
        else:
            current_run = 1
    return max_run

def hallucination_score(text: str) -> float:
    """
    FIX: Composite hallucination score per guide.
    Score > 1.1 → reject as hallucination.
    Combines word repetition ratio + inverse unique word ratio.
    Works for both Gujarati (script) and English/Roman output.
    """
    words = re.findall(r"[\w\u0900-\u097F\u0A80-\u0AFF]+", text.lower(), flags=re.U)
    if len(words) < 4:
        return 0.0
    counts = Counter(words)
    top_count = counts.most_common(1)[0][1]
    repetition  = top_count / len(words)
    unique_ratio = len(set(words)) / len(words)
    score = repetition + (1.0 - unique_ratio)
    return score

def _repeated_ngram_ratio(text: str, n: int = 4) -> float:
    tokens = re.findall(r"[\w\u0900-\u097F\u0A80-\u0AFF]+", (text or "").lower(), flags=re.U)
    if len(tokens) < n * 2:
        return 0.0
    grams = [tuple(tokens[i:i+n]) for i in range(len(tokens) - n + 1)]
    if not grams:
        return 0.0
    return max(Counter(grams).values()) / max(1, len(grams))

def _unique_word_ratio(text: str) -> float:
    tokens = re.findall(r"[\w\u0900-\u097F\u0A80-\u0AFF]+", (text or "").lower(), flags=re.U)
    return len(set(tokens)) / len(tokens) if tokens else 0.0

def _is_char_level_repetition(text: str) -> bool:
    stripped = text.strip()
    if len(stripped) < 12:
        return False
    m = re.search(r"(.{2,6}?)\1{5,}", stripped, re.U)
    return bool(m and len(m.group(0)) > len(stripped) * 0.5)

def _is_devanagari_phrase_hallucination(text: str) -> bool:
    stripped = text.strip()
    if re.search(r"[A-Za-z]", stripped) or len(stripped) < 40:
        return False
    words = stripped.split()
    if len(words) < 8:
        return False
    wc = Counter(words)
    mw, mc = wc.most_common(1)[0]
    if mc / len(words) >= 0.40 and len(wc) <= 3:
        bigrams = [f"{words[i]} {words[i+1]}" for i in range(len(words)-1)]
        bc = Counter(bigrams)
        if bc and bc.most_common(1)[0][1] / max(1, len(bigrams)) >= 0.70:
            return True
    return False

_WHISPER_SILENCE_PAT = re.compile(
    r"^(i'?m\s+sorry\.?|foreign\.?|i\s+am\s+a\.?|okay\.?|alright\.?|"
    r"the\s+end\.?|i\s+don'?t\s+know\.?|music\.?|silence\.?|applause\.)$",
    re.I | re.U,
)

def _is_hallucinated_segment(text: str) -> bool:
    stripped = text.strip()
    if not stripped or len(stripped) < 2:
        return True
    if _has_banned_phrase(stripped):
        log.info(f"[HALLUCINATION:BANNED] {stripped[:80]}")
        return True
    if _is_char_level_repetition(stripped):
        log.info(f"[HALLUCINATION:CHAR_REPEAT] {stripped[:60]}")
        return True
    if _is_devanagari_phrase_hallucination(stripped):
        log.info(f"[HALLUCINATION:DEVANAGARI_PHRASE] {stripped[:60]}")
        return True
    wc = len(re.findall(r"\b\w+\b", stripped, flags=re.U))
    if wc <= 3 and _WHISPER_SILENCE_PAT.match(stripped):
        log.info(f"[HALLUCINATION:SILENCE_PHRASE] {stripped[:60]}")
        return True

    # FIX: Counting-sequence hallucination — Whisper produces number sequences during
    # silence/low-speech segments: "10 11 12 13 14 15 16 17 18 19 20..."
    # Seen in logs: speaker 2 outputs "10 11 12 13 14 15...28" from crowd noise.
    numbers_only = re.findall(r'\d+', stripped)
    non_numbers = re.sub(r'[\d\s]', '', stripped)
    if len(numbers_only) >= 6 and len(non_numbers) <= 2:
        log.info(f"[HALLUCINATION:COUNTING_SEQUENCE] {stripped[:80]}")
        return True

    # FIX 5: Bigram repetition check — catches "which is a weak ball, which is a weak ball..."
    # A bigram that appears 3+ times in a ≥10-word segment is a hallucination pattern
    if wc >= 10:
        words = re.findall(r"\b\w+\b", stripped.lower(), flags=re.U)
        bigrams = [f"{words[i]} {words[i+1]}" for i in range(len(words)-1)]
        if bigrams:
            bg_count = Counter(bigrams)
            top_bg, top_cnt = bg_count.most_common(1)[0]
            if top_cnt >= 3 and top_cnt / max(1,len(bigrams)) >= 0.40:
                log.info(f"[HALLUCINATION:BIGRAM_REPEAT] '{top_bg}' x{top_cnt}/{len(bigrams)}: {stripped[:80]}")
                return True

    # FIX 5b: Single word dominates a long segment (e.g. "the" x12 in a 14-word segment)
    if wc >= 8:
        words_lower = re.findall(r"\b\w+\b", stripped.lower(), flags=re.U)
        wc_count = Counter(words_lower)
        top_w, top_wc = wc_count.most_common(1)[0]
        if top_wc / wc >= 0.60 and len(top_w) <= 5:
            log.info(f"[HALLUCINATION:SINGLE_WORD_REPEAT] '{top_w}' x{top_wc}/{wc}: {stripped[:80]}")
            return True

    for pat in _HALLUCINATION_REGEXES:
        if pat.search(stripped):
            return True
    if _consecutive_repeat_count(stripped) >= 4:
        return True
    # FIX: Raised threshold from 0.65 to 0.72 — Gujarati morphology naturally has
    # repeated syllables and connector words (che, ane, pan) that were being
    # incorrectly flagged as hallucinations under the English-calibrated 0.65 threshold.
    if _repetition_ratio(stripped) > 0.72:
        return True
    if _repeated_ngram_ratio(stripped, 3) >= 0.55:
        return True
    if _unique_word_ratio(stripped) < 0.10 and len(re.findall(r"\w+", stripped, flags=re.U)) >= 10:
        return True
    if _is_prompt_echo(stripped):
        return True
    # FIX: Composite hallucination score — catches fake Gujarati/Hindi gibberish
    # that passes individual checks but has overall repetitive pattern.
    # score = word_repetition_ratio + (1 - unique_word_ratio); threshold=1.1
    h_score = hallucination_score(stripped)
    if h_score > 1.1:
        log.info(f"[HALLUCINATION:COMPOSITE_SCORE] score={h_score:.2f}: {stripped[:80]}")
        return True
    return False

def _all_segments_hallucinated(segments: List[Dict[str, Any]]) -> bool:
    if not segments:
        return True
    good = [s for s in segments if not _is_hallucinated_segment(s.get("text", ""))]
    if not good:
        return True
    if len(segments) >= 4:
        all_texts = [s.get("text", "").strip().lower() for s in segments]
        tc = Counter(all_texts)
        mtext, mcount = tc.most_common(1)[0]
        if mcount / len(all_texts) >= float(os.getenv("CROSS_SEGMENT_REPEAT_THRESHOLD","0.65")) and mcount >= int(os.getenv("CROSS_SEGMENT_MIN_COUNT","6")):
            log.info(f"[HALLUCINATION:CROSS_SEGMENT] text='{mtext[:40]}' ratio={mcount/len(all_texts):.2f}")
            return True
    return False

def _has_supported_script_or_language(text: str, expected_lang: str = "auto") -> bool:
    dens = _script_density(text or "")
    expected_lang = (expected_lang or "auto").lower()
    if expected_lang == "gu":
        return dens["gu"] >= 0.05
    if expected_lang == "hi":
        return dens["hi"] >= 0.05
    if expected_lang == "en":
        return dens["en"] >= 0.25
    return dens["gu"] >= 0.05 or dens["hi"] >= 0.05 or dens["en"] >= 0.15

def _strict_quality_reject_reason(
    text: str, segments: List[Dict[str, Any]],
    expected_lang: str = "auto", detected_lang: str = ""
) -> Optional[str]:
    # Safety fallback — in case module-level _UNSUPPORTED_LANGUAGES is missing
    _unsupported = globals().get("_UNSUPPORTED_LANGUAGES", {
        "jw", "jv", "es", "ur", "bn", "id", "ja", "ko", "zh", "pt", "ar",
        "tr", "ms", "tl", "uk", "ru", "ta", "te", "ml", "mr", "pa", "ne", "fa",
    })
    cleaned = " ".join(str(text or "").split())
    if not cleaned:
        return "empty"
    if _has_banned_phrase(cleaned):
        return "banned_phrase"
    if _is_prompt_echo(cleaned):
        return "prompt_echo"
    r3 = _repeated_ngram_ratio(cleaned, 3)
    r5 = _repeated_ngram_ratio(cleaned, 5)
    if r3 >= 0.70 or (r3 >= 0.55 and r5 >= 0.45):
        return "repeated_phrase"
    words = re.findall(r"\w+", cleaned.lower(), flags=re.U)
    if len(words) >= 8:
        wc = Counter(words)
        tw, tc = wc.most_common(1)[0]
        if tc / len(words) >= 0.60:
            return "single_word_repetition"
        bigrams = [f"{words[i]} {words[i+1]}" for i in range(len(words)-1)]
        bc = Counter(bigrams)
        if bc and bc.most_common(1)[0][1] / max(1, len(bigrams)) >= 0.75:
            return "bigram_repetition_hallucination"
    # Native script bypass — trust it
    if expected_lang == "hi" and len(re.findall(r"[\u0900-\u097F]", cleaned)) >= 3:
        return None
    if expected_lang == "gu" and len(re.findall(r"[\u0A80-\u0AFF]", cleaned)) >= 3:
        return None
    # FIX 2: Gujarati vocabulary bypass — trust English output with Gujarati markers
    if expected_lang == "gu" and _count_gu_vocab(cleaned) >= 2:
        return None
    if expected_lang == "hi" and _count_hi_vocab(cleaned) >= 2:
        return None
    if len(cleaned) < 18 and not _has_supported_script_or_language(cleaned, expected_lang):
        return "too_short_or_gibberish"
    if _unique_word_ratio(cleaned) < 0.10 and len(words) >= 15:
        return "low_unique_word_ratio"
    # FIX: Composite hallucination score gate — catches fake Gujarati/Hindi gibberish
    h_score = hallucination_score(cleaned)
    if h_score > 1.1:
        log.info(f"[STRICT_QUALITY] hallucination_score={h_score:.2f} rejecting: {cleaned[:80]}")
        return "hallucination_composite_score"
    # FIX: Script-ratio mismatch — rejects pure English output for gu/hi sessions
    # but ALLOWS code-switched cricket commentary (English words + Gujarati vocab)
    script_reject = _validate_script_match(cleaned, expected_lang)
    if script_reject:
        return script_reject
    if detected_lang and detected_lang.lower() in _unsupported:
        if not _has_supported_script_or_language(cleaned, expected_lang):
            return f"unsupported_language:{detected_lang}"
    if segments:
        avg_ns = sum(float(s.get("no_speech_prob", 0.0) or 0.0) for s in segments) / len(segments)
        if avg_ns >= 0.90 and len(cleaned) < 60:
            return "mostly_no_speech"
    return None

# ── Scoring ───────────────────────────────────────────────────────────────────
_GU_MARKERS = re.compile(
    r"(?:^|\b)(mane|mare|tame|tamne|shu|kem|kai|ane|pan|pachi|tamari|"
    r"ketlak|divas|thi|chella|chamdi|khanjvaal|khanjwal|laal|daana|"
    r"khub|sathal|thai|rahya|che|chhe|vaadhe|ochhu|pehla|pachhi|"
    r"lagbhag|besho|samasya|samjayu|navi|koi|sharu|kyare|have|vadhu|"
    r"namaste|saheb|doctor|cream|dava|allergy|infection|bijou|taraf|"
    r"aapo|avjo|chalo|karo|kariye|joi|juo|bahu|khali|potanu|"
    r"temno|emno|ema|tema|aa|te|em|pan|nahi|chhe|hato|hati|Gujarat|Titans)(?:\b|$)",
    re.I,
)
_HI_MARKERS = re.compile(
    r"(?:^|\b)(kya|mai|mujhe|andar|aa|sakta|hu|hai|hain|hum|tum|aap|"
    r"kar|karo|kiya|nahin|nahi|bhi|yeh|woh|iska|kaise|kab|"
    r"doctor|saheb|namaste|lagaya|pehle|baad|cream|theek|"
    r"samajh|batao|bolo|aya|aaya|gaya|karta|karti|raha|rahi|"
    r"tha|thi|se|ne|ko|ka|ki|ke|pe|par|mein|men)(?:\b|$)",
    re.I,
)

# ════════════════════════════════════════════════════════════════════════════
# PRODUCTION-GRADE LANGUAGE SELECTION SCORING  v22.0
# ════════════════════════════════════════════════════════════════════════════
#
# ROOT CAUSE ANALYSIS — WHY GUJARATI WINS INCORRECTLY
# ─────────────────────────────────────────────────────
# OLD _score_transcription had three fatal flaws:
#
# FLAW 1 — Hard language priority bias:
#   LANG_PRIORITY = {"gu": 1.0, "hi": 0.92, "en": 0.70}
#   English transcript was penalised -30% BEFORE any quality check.
#   Result: corrupted Gujarati Unicode scored higher than valid English.
#
# FLAW 2 — Flat +10 script bonus with no quality gate:
#   if dens["gu"] >= 0.10: score += 10.0 * LANG_PRIORITY["gu"]
#   Any Gujarati Unicode characters added +10 regardless of whether those
#   characters formed real words. Hallucinated Gujarati phoneme noise like
#   "તોના, અહેંડીક્યાન" contains valid Unicode codepoints and triggers this.
#
# FLAW 3 — No dictionary coverage check:
#   The scorer never verified whether the transcribed words existed in the
#   Gujarati/Hindi lexicon. Garbage like "અહેંડીક્યાન" passes script density
#   but has 0% dictionary coverage.
#
# NEW FORMULA (per spec):
#   FINAL_SCORE = (
#       language_probability * 0.15
#     + dictionary_coverage  * 0.25
#     + confidence_score     * 0.20
#     + semantic_quality     * 0.25
#     + sentence_structure   * 0.15
#   ) - hallucination_penalty
#
# ════════════════════════════════════════════════════════════════════════════

# ── English word set for semantic quality check ───────────────────────────────
_ENGLISH_FUNCTION_WORDS: frozenset = frozenset({
    "the","a","an","and","or","but","in","on","at","to","for","of","with",
    "is","are","was","were","be","been","being","have","has","had","do",
    "does","did","will","would","could","should","may","might","shall","can",
    "i","you","he","she","it","we","they","me","him","her","us","them",
    "my","your","his","its","our","their","this","that","these","those",
    "not","no","so","as","if","then","than","when","where","who","what",
    "how","all","any","some","one","two","three","come","go","get","know",
    "first","like","just","your","your","your","your","your","your",
})

# ── Sentence-boundary markers ─────────────────────────────────────────────────
_SENTENCE_END_PAT = re.compile(r'[.!?।]')
_WORD_PAT         = re.compile(r'\b[a-zA-Z]{2,}\b')
_EN_SENTENCE_PAT  = re.compile(
    r'\b(i|you|he|she|it|we|they|the|a|an)\s+\w+\s+(is|are|was|were|\w+s?)\b',
    re.I
)

# ── Load lexicons for dictionary coverage ─────────────────────────────────────
_GU_LEXICON_WORDS: frozenset = frozenset()
_HI_LEXICON_WORDS: frozenset = frozenset()

def _load_lexicons() -> None:
    global _GU_LEXICON_WORDS, _HI_LEXICON_WORDS
    import json

    _lexicon_dirs = [
        Path(__file__).parent / "resources",
        Path(__file__).parent / "res_check" / "resources",
        Path(__file__).parent / ".." / "resources",
    ]
    # Also check zip
    zip_path = Path(__file__).parent / "python_resources.zip"
    if zip_path.exists() and not any((d / "gujarati_lexicon.json").exists() for d in _lexicon_dirs):
        import zipfile, tempfile
        with zipfile.ZipFile(zip_path, "r") as zf:
            tmpdir = Path(tempfile.mkdtemp(prefix="vm_res_"))
            zf.extractall(tmpdir)
            _lexicon_dirs.insert(0, tmpdir / "resources")

    for d in _lexicon_dirs:
        gu_f = d / "gujarati_lexicon.json"
        hi_f = d / "hindi_lexicon.json"
        if gu_f.exists() and hi_f.exists():
            try:
                gu_raw = json.loads(gu_f.read_text(encoding="utf-8"))
                hi_raw = json.loads(hi_f.read_text(encoding="utf-8"))
                # Keys are native-script words
                _GU_LEXICON_WORDS = frozenset(k.strip() for k in gu_raw.keys() if k.strip())
                _HI_LEXICON_WORDS = frozenset(k.strip() for k in hi_raw.keys() if k.strip())
                log.info(f"[SCORER] Lexicons loaded: gu={len(_GU_LEXICON_WORDS)} hi={len(_HI_LEXICON_WORDS)}")
                return
            except Exception as e:
                log.warning(f"[SCORER] Lexicon load failed from {d}: {e}")
    log.warning("[SCORER] No lexicons found — dictionary coverage will default to 0.5")

threading.Thread(target=_load_lexicons, daemon=True).start()


def detect_gibberish_ratio(text: str, lang: str = "auto") -> float:
    """
    Compute ratio of gibberish tokens in a transcript.

    A token is gibberish when:
    - It is in the target script but not in the lexicon (OOV)
    - For Gujarati: token has Gujarati codepoints but is not a real word
    - For Hindi: token has Devanagari codepoints but is not a real word
    - For English: token has 5+ consonants in a row (no real English word)
    - Contains mixed script within a single token (corrupted encoding)

    Returns float in [0.0, 1.0] — 0.0 = no gibberish, 1.0 = all gibberish.
    """
    if not text or not text.strip():
        return 1.0

    tokens = re.findall(r'[\w\u0900-\u097F\u0A80-\u0AFF]+', text, flags=re.U)
    if not tokens:
        return 1.0

    gibberish_count = 0
    _gu_script = re.compile(r'[\u0A80-\u0AFF]')
    _hi_script = re.compile(r'[\u0900-\u097F]')
    _en_consonant_run = re.compile(r'[bcdfghjklmnpqrstvwxyz]{5,}', re.I)

    for token in tokens:
        tok_lower = token.lower().strip()
        if not tok_lower:
            continue

        has_gu = bool(_gu_script.search(tok_lower))
        has_hi = bool(_hi_script.search(tok_lower))
        has_en = bool(re.search(r'[a-z]', tok_lower))

        # Mixed script within one token = encoding corruption
        script_count = sum([has_gu, has_hi, has_en])
        if script_count > 1:
            gibberish_count += 1
            continue

        if has_gu:
            if _GU_LEXICON_WORDS and tok_lower not in _GU_LEXICON_WORDS:
                # Single chars or very short Gujarati tokens are vowels/conjuncts — OK
                if len(tok_lower) > 2:
                    gibberish_count += 1
        elif has_hi:
            if _HI_LEXICON_WORDS and tok_lower not in _HI_LEXICON_WORDS:
                if len(tok_lower) > 2:
                    gibberish_count += 1
        elif has_en:
            # English gibberish: impossible consonant clusters
            if _en_consonant_run.search(tok_lower):
                gibberish_count += 1

    return gibberish_count / max(1, len(tokens))


def compute_dictionary_coverage(text: str, lang: str) -> float:
    """
    Compute what fraction of script-specific tokens exist in the lexicon.

    Returns float [0.0, 1.0]:
    - 1.0 = every word is in the lexicon (excellent)
    - 0.0 = no words found in lexicon (likely hallucination)
    - 0.5 = returned when lexicon unavailable (neutral)

    For English: returns 0.8 if text forms recognizable English sentences,
    otherwise uses function-word coverage as proxy.
    """
    if not text or not text.strip():
        return 0.0

    lang = (lang or "auto").lower()

    # English: use function-word heuristic + sentence pattern
    if lang == "en":
        en_words = re.findall(r'\b[a-zA-Z]{2,}\b', text.lower())
        if not en_words:
            return 0.0
        fw_hits = sum(1 for w in en_words if w in _ENGLISH_FUNCTION_WORDS)
        fw_ratio = fw_hits / len(en_words)
        # Bonus if text contains proper English sentence structure
        has_en_sentences = bool(_EN_SENTENCE_PAT.search(text))
        coverage = fw_ratio * 0.6 + (0.4 if has_en_sentences else 0.0)
        return min(1.0, coverage + 0.2)  # English always gets baseline 0.2

    # Gujarati
    if lang == "gu":
        gu_tokens = re.findall(r'[\u0A80-\u0AFF]+', text, flags=re.U)
        if not gu_tokens:
            # No Gujarati script → check if it's romanized Gujarati (code-switched)
            gu_vocab_hits = _count_gu_vocab(text)
            wc = max(1, len(re.findall(r'\w+', text, flags=re.U)))
            return min(0.7, gu_vocab_hits / wc * 5)
        if not _GU_LEXICON_WORDS:
            return 0.5  # Lexicon unavailable — neutral
        hits = sum(1 for t in gu_tokens if t.strip() in _GU_LEXICON_WORDS)
        return hits / max(1, len(gu_tokens))

    # Hindi
    if lang == "hi":
        hi_tokens = re.findall(r'[\u0900-\u097F]+', text, flags=re.U)
        if not hi_tokens:
            hi_vocab_hits = _count_hi_vocab(text)
            wc = max(1, len(re.findall(r'\w+', text, flags=re.U)))
            return min(0.7, hi_vocab_hits / wc * 5)
        if not _HI_LEXICON_WORDS:
            return 0.5
        hits = sum(1 for t in hi_tokens if t.strip() in _HI_LEXICON_WORDS)
        return hits / max(1, len(hi_tokens))

    # Auto: best of all
    gu_cov = compute_dictionary_coverage(text, "gu")
    hi_cov = compute_dictionary_coverage(text, "hi")
    en_cov = compute_dictionary_coverage(text, "en")
    return max(gu_cov, hi_cov, en_cov)


def compute_semantic_quality(text: str, lang: str, segments: List[Dict[str, Any]]) -> float:
    """
    Estimate semantic quality of a transcript.

    Combines:
    1. Average logprob from Whisper segments (model confidence)
    2. Unique word ratio (diversity — real speech is diverse)
    3. Sentence completeness (does text form complete thoughts?)
    4. Word length distribution (real language has varied word lengths)
    5. OOV penalty (too many unknown words = likely hallucination)

    Returns float [0.0, 1.0].
    """
    if not text or not text.strip():
        return 0.0

    # 1. Whisper segment log-probs
    if segments:
        avg_lp = sum(float(s.get("avg_logprob", -1.0) or -1.0) for s in segments) / len(segments)
        # Normalize: -0.2 (excellent) → 1.0, -2.0 (poor) → 0.0
        lp_score = max(0.0, min(1.0, (avg_lp + 2.0) / 1.8))
    else:
        lp_score = 0.3

    # 2. Unique word ratio (diversity)
    tokens = re.findall(r'[\w\u0900-\u097F\u0A80-\u0AFF]+', text.lower(), flags=re.U)
    if not tokens:
        return 0.0
    unique_ratio = len(set(tokens)) / max(1, len(tokens))
    # Real speech: 0.5–0.9 unique ratio. All same = 0. All different = fine too.
    diversity_score = min(1.0, unique_ratio * 1.3)

    # 3. Sentence completeness
    sentence_ends = len(_SENTENCE_END_PAT.findall(text))
    word_count    = len(tokens)
    # Expect roughly 1 sentence per 8–15 words in real speech
    if word_count >= 5:
        expected_sentences = word_count / 10.0
        completeness = min(1.0, sentence_ends / max(0.5, expected_sentences))
    else:
        completeness = 0.5

    # 4. Word length distribution (real Gujarati: avg 3–8 chars, English 3–7)
    word_lengths = [len(t) for t in tokens]
    avg_wl  = sum(word_lengths) / max(1, len(word_lengths))
    # Very short (<2) or very long (>15) avg word length suggests corruption
    wl_ok   = 1.0 if 2.5 <= avg_wl <= 12.0 else 0.3

    # 5. Gibberish penalty
    gibberish = detect_gibberish_ratio(text, lang)
    gibberish_factor = max(0.0, 1.0 - gibberish * 2.0)

    quality = (
        lp_score       * 0.35 +
        diversity_score * 0.25 +
        completeness    * 0.15 +
        wl_ok           * 0.10 +
        gibberish_factor * 0.15
    )
    return max(0.0, min(1.0, quality))


def compute_sentence_structure_score(text: str, lang: str) -> float:
    """
    Score how well the text follows sentence structure rules for its language.

    English: checks for subject-verb patterns, proper capitalization, punctuation
    Gujarati: checks for sentence-ending markers (।), conjunction patterns
    Hindi:    same as Gujarati

    Returns float [0.0, 1.0].
    """
    if not text or not text.strip():
        return 0.0

    lang = (lang or "auto").lower()
    tokens = re.findall(r'[\w\u0900-\u097F\u0A80-\u0AFF]+', text, flags=re.U)
    if not tokens:
        return 0.0

    word_count = len(tokens)

    if lang == "en":
        # English structure signals
        en_words   = re.findall(r'\b[a-zA-Z]{2,}\b', text.lower())
        if not en_words:
            return 0.1

        # Subject-verb pattern
        sv_hits    = len(_EN_SENTENCE_PAT.findall(text))
        sv_score   = min(1.0, sv_hits / max(1, word_count / 8))

        # Proper starts (capital letter)
        sentences  = re.split(r'[.!?]+', text.strip())
        cap_starts = sum(1 for s in sentences if s.strip() and s.strip()[0].isupper())
        cap_score  = cap_starts / max(1, len(sentences))

        # Punctuation ratio
        punct_count = len(re.findall(r'[.,!?;\'\"-]', text))
        punct_score = min(1.0, punct_count / max(1, word_count / 6))

        # Function word density (English texts have many function words)
        fw_count    = sum(1 for w in en_words if w in _ENGLISH_FUNCTION_WORDS)
        fw_score    = min(1.0, fw_count / max(1, len(en_words)) * 2.5)

        return sv_score * 0.30 + cap_score * 0.25 + punct_score * 0.15 + fw_score * 0.30

    elif lang in ("gu", "hi"):
        # Indic structure: sentence-ending markers, connector words
        script_range = r'[\u0A80-\u0AFF]' if lang == "gu" else r'[\u0900-\u097F]'
        native_chars = len(re.findall(script_range, text))

        if native_chars == 0:
            # Romanized — use vocab marker density
            vocab_hits = _count_gu_vocab(text) if lang == "gu" else _count_hi_vocab(text)
            return min(1.0, vocab_hits / max(1, word_count) * 4.0)

        # Sentence ends (। is Devanagari/Gujarati danda)
        danda_count = text.count("।")
        danda_score = min(1.0, danda_count / max(1, word_count / 8))

        # Native script density
        total_chars  = max(1, len(re.sub(r'\s', '', text)))
        script_ratio = native_chars / total_chars
        script_score = min(1.0, script_ratio * 1.5)

        # Word boundary diversity (real language: varied token lengths)
        tl = [len(t) for t in tokens]
        tl_std = (sum((l - sum(tl)/len(tl))**2 for l in tl) / len(tl)) ** 0.5 if len(tl) > 1 else 0
        diversity = min(1.0, tl_std / 3.0)

        return danda_score * 0.20 + script_score * 0.50 + diversity * 0.30

    # Auto: average of all
    return (
        compute_sentence_structure_score(text, "en") * 0.4 +
        compute_sentence_structure_score(text, "gu") * 0.3 +
        compute_sentence_structure_score(text, "hi") * 0.3
    )


def score_transcript_quality(
    result: Dict[str, Any],
    candidate_lang: str = "auto",
) -> Dict[str, float]:
    """
    Full quality scoring for a Whisper transcription result.

    Returns a dict with all component scores and the final weighted score.

    Formula:
        FINAL_SCORE = (
            language_probability * 0.15
          + dictionary_coverage  * 0.25
          + confidence_score     * 0.20
          + semantic_quality     * 0.25
          + sentence_structure   * 0.15
        ) - hallucination_penalty

    This replaces the old _score_transcription which:
    - gave Gujarati a flat +10 bonus (no quality gate)
    - penalised English 30% regardless of quality
    - never checked dictionary coverage
    - never verified sentence structure

    No language gets a fixed priority boost. Quality wins.
    """
    text       = result.get("text", "") or ""
    segments   = result.get("segments", []) or []
    lang_label = result.get("language", candidate_lang) or candidate_lang
    lang       = (lang_label or "auto").lower()

    if not text or not text.strip():
        return {"final_score": -999.0, "language_probability": 0.0,
                "dictionary_coverage": 0.0, "confidence_score": 0.0,
                "semantic_quality": 0.0, "sentence_structure": 0.0,
                "hallucination_penalty": 1.0, "gibberish_ratio": 1.0}

    # ── Component 1: Language probability (Whisper's own confidence) ──────────
    lang_prob = float(result.get("language_probability", 0.5) or 0.5)
    # Clamp to [0, 1]
    lang_prob = max(0.0, min(1.0, lang_prob))

    # ── Component 2: Dictionary coverage ─────────────────────────────────────
    dict_coverage = compute_dictionary_coverage(text, lang)

    # ── Component 3: Confidence score (segment-level avg_logprob) ────────────
    if segments:
        avg_lp = sum(float(s.get("avg_logprob", -1.0) or -1.0) for s in segments) / len(segments)
        avg_ns = sum(float(s.get("no_speech_prob", 0.0) or 0.0) for s in segments) / len(segments)
        # Normalize logprob: [-2.0, 0.0] → [0.0, 1.0]
        confidence_score = max(0.0, min(1.0, (avg_lp + 2.0) / 2.0))
        # Penalise for high no-speech probability
        confidence_score *= max(0.0, 1.0 - avg_ns * 0.8)
    else:
        confidence_score = 0.3
        avg_ns = 0.0

    # ── Component 4: Semantic quality ────────────────────────────────────────
    semantic_quality = compute_semantic_quality(text, lang, segments)

    # ── Component 5: Sentence structure ──────────────────────────────────────
    sentence_structure = compute_sentence_structure_score(text, lang)

    # ── Hallucination penalty ─────────────────────────────────────────────────
    gibberish     = detect_gibberish_ratio(text, lang)
    h_score       = hallucination_score(text)
    rep_ratio     = _repetition_ratio(text)
    consec_repeat = _consecutive_repeat_count(text)

    hallucination_penalty = 0.0

    # Gibberish tokens → heavy penalty
    if gibberish > 0.5:
        hallucination_penalty += (gibberish - 0.5) * 1.5

    # Composite hallucination score
    if h_score > 0.8:
        hallucination_penalty += (h_score - 0.8) * 0.8

    # Repetition
    if rep_ratio > 0.35:
        hallucination_penalty += (rep_ratio - 0.35) * 0.6

    # Consecutive repeats
    if consec_repeat >= 3:
        hallucination_penalty += consec_repeat * 0.08

    # Hard floor on coverage — if <20% of native-script words are in lexicon
    # AND lang is not English, apply strong penalty (this is the key fix)
    if lang in ("gu", "hi") and dict_coverage < 0.20 and len(text) > 30:
        hallucination_penalty += (0.20 - dict_coverage) * 2.0

    hallucination_penalty = min(hallucination_penalty, 1.5)  # cap at 1.5

    # ── Final score ───────────────────────────────────────────────────────────
    # NO LANGUAGE PRIORITY BIAS — quality determines the winner
    final_score = (
        lang_prob          * 0.15 +
        dict_coverage      * 0.25 +
        confidence_score   * 0.20 +
        semantic_quality   * 0.25 +
        sentence_structure * 0.15
    ) - hallucination_penalty

    scores = {
        "final_score":          round(final_score,         4),
        "language_probability": round(lang_prob,           4),
        "dictionary_coverage":  round(dict_coverage,       4),
        "confidence_score":     round(confidence_score,    4),
        "semantic_quality":     round(semantic_quality,    4),
        "sentence_structure":   round(sentence_structure,  4),
        "hallucination_penalty":round(hallucination_penalty, 4),
        "gibberish_ratio":      round(gibberish,           4),
        "rep_ratio":            round(rep_ratio,           4),
        "lang":                 lang,
    }

    log.info(
        f"[QUALITY_SCORE] lang={lang} final={final_score:.3f} | "
        f"dict={dict_coverage:.2f} sem={semantic_quality:.2f} struct={sentence_structure:.2f} | "
        f"gibberish={gibberish:.2f} hall_pen={hallucination_penalty:.2f} "
        f"lang_prob={lang_prob:.2f}"
    )
    return scores


def select_best_language(all_results: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Select the best candidate language result using score_transcript_quality.

    Key rules:
    1. Score every candidate with the full quality formula
    2. If English result has final_score >= EN_WINS_THRESHOLD AND all
       Gujarati/Hindi candidates have gibberish_ratio > GU_HI_GIBBERISH_THRESHOLD
       → English wins unconditionally (even if Gujarati has higher raw score)
    3. If the winner's dictionary_coverage < MIN_DICT_COVERAGE
       AND an alternative has coverage > MIN_DICT_COVERAGE → prefer alternative
    4. Log all scores for debugging

    Configurable via env vars:
      EN_WINS_THRESHOLD           default 0.40
      GU_HI_GIBBERISH_THRESHOLD   default 0.45
      MIN_DICT_COVERAGE           default 0.15
    """
    EN_WINS_THRESHOLD         = _env_float("EN_WINS_THRESHOLD",         0.40)
    GU_HI_GIBBERISH_THRESHOLD = _env_float("GU_HI_GIBBERISH_THRESHOLD", 0.45)
    MIN_DICT_COVERAGE         = _env_float("MIN_DICT_COVERAGE",         0.15)

    if not all_results:
        return {}

    if len(all_results) == 1:
        return all_results[0]

    # Score all candidates
    scored = []
    for r in all_results:
        cand_lang = r.get("language", r.get("_candidate_lang", "auto"))
        scores    = score_transcript_quality(r, cand_lang)
        scored.append((scores["final_score"], scores, r))

    scored.sort(key=lambda x: x[0], reverse=True)

    # Log all candidates
    for fs, sc, r in scored:
        log.info(
            f"[SELECT_BEST] lang={sc['lang']} final={fs:.3f} "
            f"dict={sc['dictionary_coverage']:.2f} gibberish={sc['gibberish_ratio']:.2f} "
            f"sem={sc['semantic_quality']:.2f}"
        )

    top_score, top_sc, top_result = scored[0]

    # Rule 2: English override — if English is clearly valid and top candidate is garbage
    en_results = [(fs, sc, r) for fs, sc, r in scored
                  if sc["lang"] == "en" or r.get("language", "") == "en"]
    non_en_results = [(fs, sc, r) for fs, sc, r in scored
                      if sc["lang"] not in ("en",) and r.get("language", "") not in ("en",)]

    if en_results and non_en_results:
        best_en_score, best_en_sc, best_en_result = en_results[0]
        all_non_en_garbage = all(
            sc["gibberish_ratio"] > GU_HI_GIBBERISH_THRESHOLD
            for _, sc, _ in non_en_results
        )
        if best_en_score >= EN_WINS_THRESHOLD and all_non_en_garbage:
            log.info(
                f"[SELECT_BEST] EN_OVERRIDE: English wins (en_score={best_en_score:.3f}, "
                f"all non-EN gibberish_ratio>{GU_HI_GIBBERISH_THRESHOLD})"
            )
            return best_en_result

    # Rule 3: Coverage fallback — winner has too-low coverage, better option exists
    if top_sc["dictionary_coverage"] < MIN_DICT_COVERAGE:
        better = [(fs, sc, r) for fs, sc, r in scored[1:]
                  if sc["dictionary_coverage"] >= MIN_DICT_COVERAGE]
        if better:
            alt_score, alt_sc, alt_result = better[0]
            log.info(
                f"[SELECT_BEST] COVERAGE_FALLBACK: winner dict={top_sc['dictionary_coverage']:.2f} "
                f"< {MIN_DICT_COVERAGE} → using lang={alt_sc['lang']} "
                f"dict={alt_sc['dictionary_coverage']:.2f}"
            )
            return alt_result

    log.info(f"[SELECT_BEST] WINNER: lang={top_sc['lang']} score={top_score:.3f}")
    return top_result


def _score_transcription(result: Dict[str, Any]) -> float:
    """
    Backward-compatible wrapper.
    Returns the final_score from score_transcript_quality().
    Used by max(all_results, key=_score_transcription) in transcribe_with_retry().
    """
    cand_lang = result.get("language", result.get("_candidate_lang", "auto"))
    return score_transcript_quality(result, cand_lang)["final_score"]


# ── Speaker labeling (numeric only — dynamic diarization) ─────────────────────

def _apply_role_inference(segments: List[Dict[str, Any]], full_text: str) -> List[Dict[str, Any]]:
    """
    Normalize all speaker labels to 'Speaker N' format.

    This function NEVER assigns role labels (Doctor, Patient, Teacher, Student, etc.).
    Speaker identification is purely voice-characteristic based via SpeakerManager.
    All output labels follow the format: Speaker 1, Speaker 2, ... Speaker N.
    """
    result = []
    for seg in segments:
        speaker_id = str(seg.get("speaker_id") or "SPEAKER_1").strip()
        m = re.search(r"(\d+)$", speaker_id)
        n = int(m.group(1)) if m else 1
        # Ensure n is 1-based
        n = max(1, n)
        result.append({**seg, "speaker_id": speaker_id, "speaker": f"Speaker {n}"})
    return result

# ── Language-mode system prompts for Gemini Transcription ──────────────────
_VERBATIM_RULES = """
VERBATIM TRANSCRIPTION RULES:
1. Preserve every spoken word exactly as heard.
2. Never summarize. Never rewrite. Never improve grammar.
3. Never translate. Never convert scripts.
4. Preserve Gujarati script exactly (ગુજરાતી).
5. Preserve Hindi script exactly (हिंदी).
6. Preserve English words exactly.
7. Preserve mixed/code-switched speech exactly as spoken.
8. Detect speaker changes and output a new Speaker N: label whenever the voice changes.
9. Output only the transcript. No explanations, no metadata, no commentary.
10. If uncertain about a word, use the closest phonetic transcription.

OUTPUT FORMAT (one label per voice change, text on next line):
Speaker 1:
[text]

Speaker 2:
[text]

Speaker 1:
[text]

Return transcript only."""

_SYSTEM_PROMPT_ENGLISH = """You are an expert multilingual meeting transcription engine.
LANGUAGE MODE: ENGLISH
- Transcribe English speech verbatim.
- Speaker diarization: use numeric labels Speaker 1, Speaker 2, etc.
""" + _VERBATIM_RULES

_SYSTEM_PROMPT_HINDI = """You are an expert multilingual meeting transcription engine.
LANGUAGE MODE: HINDI
- Transcribe Hindi speech verbatim in Devanagari script.
- Do NOT transliterate or romanize Hindi.
- Do NOT translate to English.
- Preserve Hindi-English code-switching (Hinglish) exactly as spoken.
- Speaker diarization: use numeric labels Speaker 1, Speaker 2, etc.
""" + _VERBATIM_RULES

_SYSTEM_PROMPT_GUJARATI = """You are an expert multilingual meeting transcription engine.
LANGUAGE MODE: GUJARATI
- Transcribe Gujarati speech verbatim in Gujarati script (ગુજરાતી).
- Do NOT transliterate or romanize Gujarati.
- Do NOT translate to English or Hindi.
- Preserve Gujarati-English code-switching exactly as spoken.
- Speaker diarization: use numeric labels Speaker 1, Speaker 2, etc.
""" + _VERBATIM_RULES

_SYSTEM_PROMPT_AUTO = """You are an expert multilingual meeting transcription engine.
LANGUAGE MODE: AUTO
- Detect the spoken language automatically.
- Support: Gujarati, Hindi, English, Hinglish, Gujarati-English mixed, Hindi-English mixed.
- Do NOT translate. Do NOT normalize or force one language.
- Preserve multilingual speech exactly as spoken (code-switching stays mixed).
- Gujarati stays in Gujarati script. Hindi stays in Devanagari. English stays in Latin script.
- Speaker diarization: use numeric labels Speaker 1, Speaker 2, etc.
""" + _VERBATIM_RULES

_LANG_TO_SYSTEM_PROMPT: Dict[str, str] = {
    "en":      _SYSTEM_PROMPT_ENGLISH,
    "english": _SYSTEM_PROMPT_ENGLISH,
    "hi":      _SYSTEM_PROMPT_HINDI,
    "hindi":   _SYSTEM_PROMPT_HINDI,
    "gu":      _SYSTEM_PROMPT_GUJARATI,
    "gujarati": _SYSTEM_PROMPT_GUJARATI,
    "auto":    _SYSTEM_PROMPT_AUTO,
}

def _get_system_prompt(language: str) -> str:
    lang = (language or "auto").strip().lower()
    return _LANG_TO_SYSTEM_PROMPT.get(lang, _SYSTEM_PROMPT_AUTO)


# ── Gemini Speaker Block Parser ──────────────────────────────────────────────
def _parse_gemini_speaker_blocks(raw_text: str, total_duration: float) -> List[Dict[str, Any]]:
    """
    Parse Gemini transcript output into per-speaker segments.

    Gemini returns:
        Speaker 1:
        text line 1

        Speaker 2:
        text line 2

    This function extracts each speaker block and assigns synthetic timestamps
    proportional to the text length, so downstream grouping logic works correctly.

    Supports case-insensitive: Speaker 1 / SPEAKER 1 / speaker 1
    """
    import re as _re

    # Regex: matches "Speaker N:" at start of a line (case-insensitive, any whitespace before colon)
    SPEAKER_PATTERN = _re.compile(
        r'^((?:speaker|SPEAKER|Speaker)\s+\d+)\s*:\s*$',
        _re.MULTILINE | _re.IGNORECASE,
    )

    lines = raw_text.splitlines()
    blocks: List[Dict[str, Any]] = []  # [{speaker, text}]
    current_speaker: Optional[str] = None
    current_lines: List[str] = []

    for line in lines:
        stripped = line.strip()
        m = SPEAKER_PATTERN.match(stripped)
        if m:
            # Save previous block
            if current_speaker is not None:
                block_text = " ".join(l for l in current_lines if l.strip())
                if block_text.strip():
                    blocks.append({"speaker": current_speaker, "text": block_text.strip()})
            # Normalize speaker label: "SPEAKER 2" → "Speaker 2"
            raw_label = m.group(1).strip()
            num_match = _re.search(r"(\d+)$", raw_label)
            n = num_match.group(1) if num_match else "1"
            current_speaker = f"Speaker {n}"
            current_lines = []
        else:
            if current_speaker is not None:
                current_lines.append(stripped)
            # Lines before first speaker label — treat as Speaker 1 if non-empty
            elif stripped:
                current_speaker = "Speaker 1"
                current_lines = [stripped]

    # Flush last block
    if current_speaker is not None:
        block_text = " ".join(l for l in current_lines if l.strip())
        if block_text.strip():
            blocks.append({"speaker": current_speaker, "text": block_text.strip()})

    # If no speaker labels found at all — fall back to single segment
    if not blocks:
        log.warning("[PARSER] No speaker labels found in Gemini output — using single segment")
        return [{
            "start": 0.0,
            "end": round(total_duration, 3),
            "text": raw_text,
            "source_text": raw_text,
            "speaker": "Speaker 1",
            "speaker_id": "SPEAKER_1",
            "avg_logprob": -0.3,
            "no_speech_prob": 0.05,
            "compression_ratio": 1.5,
        }]

    # Assign proportional timestamps based on word count
    total_words = sum(len(b["text"].split()) for b in blocks)
    total_words = max(total_words, 1)
    current_time = 0.0
    segments: List[Dict[str, Any]] = []
    seen_speakers: List[str] = []

    for block in blocks:
        words = len(block["text"].split())
        duration = (words / total_words) * total_duration
        end_time = min(round(current_time + duration, 3), round(total_duration, 3))

        # Build stable SPEAKER_N id from label
        spk_num_m = _re.search(r"(\d+)$", block["speaker"])
        spk_n = spk_num_m.group(1) if spk_num_m else "1"
        speaker_id = f"SPEAKER_{spk_n}"

        segments.append({
            "start": round(current_time, 3),
            "end": end_time,
            "text": block["text"],
            "source_text": block["text"],
            "speaker": block["speaker"],
            "speaker_id": speaker_id,
            "avg_logprob": -0.3,
            "no_speech_prob": 0.05,
            "compression_ratio": 1.5,
        })
        current_time = end_time
        if block["speaker"] not in seen_speakers:
            seen_speakers.append(block["speaker"])

    log.info(f"[PARSER] Parsed {len(segments)} segments, {len(seen_speakers)} unique speakers: {seen_speakers}")
    return segments


# ── Gemini Transcription call ────────────────────────────────────────────────
def _transcribe_with_gemini(
    wav_path: str,
    language: str,
    use_diarization: bool = False,
) -> Dict[str, Any]:
    """
    Call Gemini (gemini-3.5-flash) with the appropriate language-mode system
    prompt and return a normalized result dict.
    Replaces the former GPT-4o Transcribe / GPT-4o Transcribe Diarize call.
    """
    if _gemini_client is None:
        return {"success": False, "text": "", "segments": [], "language": language or "auto",
                "_rejected_reason": "gemini_client_not_configured"}

    system_prompt = _get_system_prompt(language)

    try:
        t0 = time.time()
        with open(wav_path, "rb") as audio_file:
            audio_bytes = audio_file.read()

        # Upload audio as inline bytes (base64-encoded via SDK)
        import base64
        audio_b64 = base64.b64encode(audio_bytes).decode("utf-8")

        # Build the prompt: system instructions + audio + transcription request
        contents = [
            _genai_types.Content(
                role="user",
                parts=[
                    _genai_types.Part(
                        inline_data=_genai_types.Blob(
                            mime_type="audio/wav",
                            data=audio_b64,
                        )
                    ),
                    _genai_types.Part(text=system_prompt),
                ],
            )
        ]

        response = _gemini_client.models.generate_content(
            model=GEMINI_MODEL,
            contents=contents,
        )
        elapsed = time.time() - t0
        log.info(f"[GEMINI] model={GEMINI_MODEL} lang={language} elapsed={elapsed:.1f}s")

        raw_text = (response.text or "").strip()
        if not raw_text:
            return {"success": False, "text": "", "segments": [], "language": language or "auto",
                    "_rejected_reason": "empty_or_hallucinated"}

        # ── SPEAKER-LABEL PARSER ────────────────────────────────────────────
        # Gemini outputs "Speaker N:\ntext" blocks. Parse them into separate
        # segments so the conversation_formatter sees multiple speakers.
        # Supported (case-insensitive): Speaker 1: / SPEAKER 1: / speaker 1:
        duration = get_audio_duration(wav_path)
        segments: List[Dict[str, Any]] = _parse_gemini_speaker_blocks(raw_text, duration)
        log.info(f"[GEMINI] parsed {len(segments)} speaker segments from Gemini output")

        final_lang = _final_language_from_text(language or "auto", language or "auto", raw_text)
        return {
            "success": True, "text": raw_text, "segments": segments,
            "language": final_lang, "detected_language": final_lang,
            "language_probability": 1.0,
            "model_used": GEMINI_MODEL, "fallback_used": False,
        }

    except Exception as exc:
        log.exception(f"[GEMINI] transcription failed: {exc}")
        return {"success": False, "text": "", "segments": [], "language": language or "auto",
                "_rejected_reason": "gemini_exception"}
# ── Language detection helper ─────────────────────────────────────────────────
def _final_language_from_text(candidate_lang: str, detected_lang: str, text: str) -> str:
    density = _script_density(text)
    has_gu = density["gu"] > 0.08
    has_hi = density["hi"] > 0.08
    has_en = density["en"] > 0.12
    if sum([has_gu, has_hi, has_en]) >= 2:
        parts = []
        if has_gu: parts.append("gu")
        if has_hi: parts.append("hi")
        if has_en: parts.append("en")
        return "mixed-" + "-".join(parts)
    if has_gu: return "gu"
    if has_hi: return "hi"
    if has_en: return "en"
    if candidate_lang in {"gu", "hi", "en"}: return candidate_lang
    if detected_lang in {"gu", "hi", "en"}: return detected_lang
    return "auto"


# ── Main transcription entry point ────────────────────────────────────────────
def transcribe_with_retry(wav_path: str, requested_lang: str, audio_duration: float = 0.0) -> Dict[str, Any]:
    """
    Transcribe using Gemini with the language-mode system prompt.
    """
    requested_lang = (requested_lang or "auto").strip().lower()
    log.info(f"[GEMINI] transcribe_with_retry lang={requested_lang} duration={audio_duration:.1f}s")

    result = _transcribe_with_gemini(wav_path, requested_lang, use_diarization=False)

    if result.get("success"):
        text = result.get("text", "")
        if _is_cross_chunk_repeat(text, requested_lang):
            log.info("[GEMINI] cross-chunk repeat detected — rejecting")
            return {"success": False, "text": "", "segments": [], "language": requested_lang,
                    "_rejected_reason": "cross_chunk_repeat"}
        _cache_push(requested_lang, text)

    return result
# ── Normalization ─────────────────────────────────────────────────────────────
def postprocess(result: Dict[str, Any]) -> Dict[str, Any]:
    lang     = result.get("language", "")
    raw_text = result.get("text",     "")
    segments = result.get("segments", [])
    log.info(f"[NORMALIZE] lang={lang} raw_len={len(raw_text)} preview={raw_text[:120]}")

    if OUTPUT_SCRIPT_MODE == "preserve":
        normalized_text = raw_text
    else:
        normalized_text = apply_desired_normalization(raw_text, lang)

    log.info(f"[NORMALIZE] norm_len={len(normalized_text)} preview={normalized_text[:120]}")

    normalized_segments = []
    for seg in segments:
        raw_seg  = seg.get("text", "")
        norm_seg = raw_seg if OUTPUT_SCRIPT_MODE == "preserve" else apply_desired_normalization(raw_seg, lang)
        avg_lp   = seg.get("avg_logprob", -1.0)
        conf     = round(min(1.0, max(0.0, 1.0 + avg_lp)), 3) if avg_lp else None
        normalized_segments.append({**seg, "text": norm_seg, "source_text": raw_seg,
                                     "language": lang, "confidence": conf})

    return {**result, "text": normalized_text, "normalized_text": normalized_text,
            "raw_text": raw_text, "segments": normalized_segments}

def assess_confidence(segments: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not segments:
        return {"confidence": "low", "needs_review": True}
    avg_lp = sum(s.get("avg_logprob", -1.0) for s in segments) / len(segments)
    avg_ns = sum(s.get("no_speech_prob", 0.5) for s in segments) / len(segments)
    if avg_lp > -0.5 and avg_ns < 0.25:
        return {"confidence": "high", "needs_review": False}
    elif avg_lp > -1.8 and avg_ns < 0.80:
        return {"confidence": "medium", "needs_review": False}
    return {"confidence": "low", "needs_review": avg_ns > 0.70}

def _heuristic_speaker_split(segments: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    FIX v21: Skip re-splitting if Gemini parser already produced multi-speaker segments.
    Falls back to pause-based heuristic only when all segments share the same speaker.

    Rules (when fallback needed):
    1. Long pause (>= PAUSE_LONG_SEC=3s)         → always switch speaker
    2. Medium pause (>= PAUSE_SHORT_SEC=1.5s)
       + significant word-count contrast (3x)    → switch speaker
    3. Same speaker running > MAX_SAME_SPEAKER_SEC=45s → force switch
    4. < MIN_SEGMENTS_FOR_SPLIT=3 segments        → all speaker 1
    """
    # ── FAST PATH: already multi-speaker from Gemini parser ────────────────
    if segments:
        unique_ids = {str(s.get("speaker_id") or s.get("speaker") or "SPEAKER_1") for s in segments}
        if len(unique_ids) > 1:
            log.info(f"[SPEAKER_SPLIT] Gemini parser already produced {len(unique_ids)} speakers — skipping heuristic")
            return segments
    PAUSE_SHORT_SEC        = float(os.getenv("PAUSE_SHORT_SEC",        "1.5"))
    PAUSE_LONG_SEC         = float(os.getenv("PAUSE_LONG_SEC",         "3.0"))
    MAX_SAME_SPEAKER_SEC   = float(os.getenv("MAX_SAME_SPEAKER_SEC",   "45.0"))
    MIN_SEGMENTS_FOR_SPLIT = int(os.getenv("MIN_SEGMENTS_FOR_SPLIT",   "3"))

    if len(segments) < MIN_SEGMENTS_FOR_SPLIT:
        return [{**s, "speaker_id": "SPEAKER_1", "speaker": "Speaker 1"} for s in segments]

    result: List[Dict[str, Any]] = []
    current_speaker       = 1
    current_speaker_start = float(segments[0].get("start", 0) or 0)

    for i, seg in enumerate(segments):
        seg_start = float(seg.get("start", 0) or 0)
        seg_text  = str(seg.get("text", "") or "").strip()
        seg_words = len(seg_text.split()) if seg_text else 0

        switch = False

        if i > 0:
            prev_seg          = segments[i - 1]
            prev_end          = float(prev_seg.get("end", 0) or 0)
            gap               = max(0.0, seg_start - prev_end)
            same_spk_duration = seg_start - current_speaker_start

            # Rule 1: Long pause → always switch
            if gap >= PAUSE_LONG_SEC:
                switch = True
            # Rule 2: Medium pause + word-count contrast → switch
            elif gap >= PAUSE_SHORT_SEC:
                prev_words = len(str(prev_seg.get("text", "") or "").split())
                if seg_words > 0 and prev_words > 0:
                    ratio = max(seg_words, prev_words) / max(1, min(seg_words, prev_words))
                    if ratio >= 3.0:
                        switch = True
            # Rule 3: Same speaker running too long → force switch
            if not switch and same_spk_duration >= MAX_SAME_SPEAKER_SEC:
                switch = True

        if switch:
            current_speaker = 2 if current_speaker == 1 else 1
            current_speaker_start = seg_start

        result.append({
            **seg,
            "speaker_id": f"SPEAKER_{current_speaker}",
            "speaker":    f"Speaker {current_speaker}",
        })

    unique_speakers = {s["speaker_id"] for s in result}
    if len(unique_speakers) < 2:
        return [{**s, "speaker_id": "SPEAKER_1", "speaker": "Speaker 1"} for s in segments]

    log.info(f"[SPEAKER_SPLIT] pause-based → {len(unique_speakers)} speakers, {len(result)} segs")
    return result

def _cleanup_with_lm_studio(conversation_text: str, language: str) -> str:
    if not ENABLE_LM_STUDIO_CLEANUP or not conversation_text.strip():
        return conversation_text
    try:
        payload = {
            "model": LM_STUDIO_MODEL,
            "messages": [
                {"role": "system", "content": "Clean transcript formatting only. Preserve every word, language, meaning. Do not translate."},
                {"role": "user", "content": conversation_text},
            ],
            "temperature": 0,
            "max_tokens": max(128, len(conversation_text.split()) * 3),
        }
        r = requests.post(f"{LM_STUDIO_BASE_URL}/chat/completions", json=payload, timeout=8)
        if r.status_code == 200:
            cleaned = r.json().get("choices", [{}])[0].get("message", {}).get("content", "").strip()
            if cleaned and len(cleaned) >= len(conversation_text) * 0.55:
                return cleaned
    except Exception:
        pass
    return conversation_text

# ── Core pipeline ─────────────────────────────────────────────────────────────
def _run_transcription(
    audio_path: str, language: str, speaker_id: str,
    request_diarization: bool = False,
) -> "TranscribeResponse":
    audio_path = str(audio_path).strip()
    if not Path(audio_path).exists():
        raise HTTPException(status_code=400, detail=f"File not found: {audio_path}")

    file_size = Path(audio_path).stat().st_size
    log.info(f"[INPUT] file={audio_path} size={file_size}")

    if file_size < 5_000:
        return TranscribeResponse(
            success=False, status="skipped", transcript_status="no_speech", text="",
            rejection_reason="file_too_small", speaker_id=speaker_id, needs_review=True,
            diarization={"attempted": False, "applied": False, "speaker_count": 1,
                         "method": "none", "segments": [], "reason": "file too small", "error": None})

    repaired_path = validate_and_repair_chunk(audio_path)
    _temp_remux   = repaired_path if (repaired_path and repaired_path != audio_path) else None
    vocal_source_path = None

    if repaired_path is None:
        return TranscribeResponse(
            success=False, status="skipped", transcript_status="error", text="",
            rejection_reason="chunk_too_short_or_corrupt", speaker_id=speaker_id, needs_review=True,
            diarization={"attempted": False, "applied": False, "speaker_count": 1,
                         "method": "none", "segments": [], "reason": "chunk_too_short_or_corrupt", "error": None})

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav_path = tmp.name

    try:
        vocal_source_path = maybe_extract_vocals(repaired_path)
        if not convert_to_wav(vocal_source_path, wav_path):
            raise HTTPException(status_code=500, detail="ffmpeg conversion failed")

        # FIX: Optional DeepFilterNet noise enhancement (enabled via ENABLE_DEEPFILTERNET=true)
        # Helps with cricket commentary, TV audio, crowd noise
        df_enhanced_path = maybe_apply_deepfilter(wav_path)
        if df_enhanced_path != wav_path:
            # Use enhanced audio for transcription
            shutil.copyfile(df_enhanced_path, wav_path)
            try:
                os.unlink(df_enhanced_path)
            except OSError:
                pass

        duration = get_audio_duration(wav_path)
        wav_rms  = get_wav_rms(wav_path)
        log.info(f"[INPUT] wav_duration={duration:.2f}s wav_rms={wav_rms:.1f} preprocess={AUDIO_PREPROCESS_MODE}")

        if duration < MIN_CHUNK_DURATION_SEC:
            return TranscribeResponse(
                success=False, status="skipped_too_short", transcript_status="no_speech", text="",
                rejection_reason="audio_too_short_after_conversion",
                speaker_id=speaker_id, needs_review=True, confidence="rejected",
                diarization={"attempted": False, "applied": False, "speaker_count": 1,
                             "method": "none", "segments": [], "reason": "audio_too_short", "error": None})

        raw_result = transcribe_with_retry(wav_path, language, audio_duration=duration)

        # TRANSCRIPT-FIRST VAD POLICY (Fix #1 + #2):
        # Run VAD AFTER Gemini. If Gemini returned meaningful text, ALWAYS keep the chunk.
        # Only apply VAD rejection when Gemini returned empty/no-speech.
        # Gemini's transcript is higher authority than VAD speech ratio.
        _gemini_text = str(raw_result.get("text", "") or raw_result.get("raw_text", "") or "").strip()
        _gemini_has_content = len(_gemini_text) > 30

        if VAD_STANDALONE_ENABLED and _silero_vad_loaded:
            speech_ratio = check_speech_ratio_silero(wav_path)
            if speech_ratio < VAD_MIN_SPEECH_RATIO:
                if _gemini_has_content:
                    # Gemini returned a real transcript — trust it, ignore low VAD ratio
                    log.info(
                        f"[SILERO_VAD] speech_ratio={speech_ratio:.3f} < {VAD_MIN_SPEECH_RATIO} "
                        f"BUT Gemini returned {len(_gemini_text)} chars — keeping chunk (transcript-first policy)"
                    )
                else:
                    # Gemini returned nothing AND VAD says mostly-silence → genuine silence
                    log.info(f"[SILERO_VAD] Rejecting chunk: speech_ratio={speech_ratio:.3f} < {VAD_MIN_SPEECH_RATIO} and Gemini returned no text")
                    return TranscribeResponse(
                        success=False, status="mostly_silence", transcript_status="no_speech", text="",
                        rejection_reason="silero_vad_mostly_silence", duration_sec=round(duration, 3),
                        speaker_id=speaker_id, needs_review=False, confidence="rejected",
                        diarization={"attempted": False, "applied": False, "speaker_count": 1,
                                     "method": "none", "segments": [], "reason": "mostly_silence", "error": None})

        if not raw_result["success"]:
            log.warning(f"[TRANSCRIPTION] No speech detected. duration={duration:.1f}s file_size={file_size}")
            fail_reason = raw_result.get("_rejected_reason", "no_valid_speech_or_rejected")
            fail_status = (
                "rejected_hallucination" if fail_reason in {
                    "empty_or_hallucinated", "banned_phrase", "repeated_phrase",
                    "low_unique_word_ratio", "low_confidence_hallucination",
                    "mostly_no_speech", "cross_chunk_repeat"
                } or str(fail_reason).startswith("selected_language_script_mismatch")
                else fail_reason
            )
            return TranscribeResponse(
                success=False, status=fail_status, transcript_status=fail_status, text="",
                rejection_reason=fail_reason, duration_sec=round(duration, 3),
                speaker_id=speaker_id, needs_review=True, confidence="rejected",
                diarization={"attempted": False, "applied": False, "speaker_count": 1,
                             "method": "none", "segments": [],
                             "reason": fail_reason, "error": None})

        final_reject_reason = _strict_quality_reject_reason(
            raw_result.get("text", ""), raw_result.get("segments", []),
            language or "auto", raw_result.get("detected_language", raw_result.get("language", "")))
        if final_reject_reason:
            log.warning(f"[TRANSCRIPTION] Rejected before display: {final_reject_reason}")
            return TranscribeResponse(
                success=False, status=final_reject_reason, transcript_status=final_reject_reason,
                text="", rejection_reason=final_reject_reason, duration_sec=round(duration, 3),
                speaker_id=speaker_id, needs_review=True, confidence="rejected",
                diarization={"attempted": False, "applied": False, "speaker_count": 1,
                             "method": "none", "segments": [], "reason": final_reject_reason, "error": None})

        use_diar    = request_diarization or ENABLE_DIARIZATION
        diar_result = run_diarization(wav_path) if use_diar else {
            "attempted": False, "applied": False, "speaker_count": 1,
            "method": "none", "segments": [], "reason": "not_requested", "error": None}

        normalized    = postprocess(raw_result)
        norm_segments = normalized.get("segments", [])
        detected_lang = normalized.get("language", language)

        diar_applied = diar_result.get("applied", False)
        diar_segs    = diar_result.get("segments", [])

        if diar_applied and diar_segs:
            norm_diar_segs, _ = normalize_speaker_ids(diar_segs)
            assigned_segments = assign_speakers_by_time_overlap(norm_segments, norm_diar_segs)
            needs_review      = False
        else:
            assigned_segments = _heuristic_speaker_split(norm_segments)
            needs_review      = True

        all_text          = " ".join(s.get("text", "") for s in assigned_segments)
        assigned_segments = _apply_role_inference(assigned_segments, all_text)
        quality           = assess_confidence(norm_segments)
        if quality["needs_review"]:
            needs_review = True

        turns             = group_segments_into_turns(assigned_segments)
        conversation_text = build_conversation_text(turns, diarization_applied=diar_applied)
        conversation_text = _cleanup_with_lm_studio(conversation_text, detected_lang)
        speaker_count     = count_unique_speakers(turns)
        normalized_text   = normalized.get("normalized_text", "")

        grouped_chars  = sum(len(t.get("text", "")) for t in turns)
        coverage_ratio = round(min(1.0, grouped_chars / max(1, len(normalized_text))), 3)

        log.info(
            f"[FINAL] segs={len(norm_segments)} turns={len(turns)} "
            f"speakers={speaker_count} coverage={coverage_ratio} "
            f"confidence={quality.get('confidence', '?')}"
        )
        # Fix #8: Coverage logging
        transcribed_sec = round(coverage_ratio * duration, 1)
        coverage_pct = round(coverage_ratio * 100, 1)
        if coverage_pct < 80:
            log.warning(
                f"[COVERAGE] Meeting Duration: {duration:.0f}s | "
                f"Transcript Coverage: {transcribed_sec}s | Coverage: {coverage_pct}% — BELOW 80%"
            )
        else:
            log.info(
                f"[COVERAGE] Meeting Duration: {duration:.0f}s | "
                f"Transcript Coverage: {transcribed_sec}s | Coverage: {coverage_pct}%"
            )
        log.info(f"[FINAL CONVERSATION]\n{conversation_text[:600]}")

        segment_out = [
            SegmentOut(
                start=s.get("start", 0.0), end=s.get("end", 0.0),
                text=s.get("text", ""), source_text=s.get("source_text", ""),
                speaker=s.get("speaker", "Speaker 1"), speaker_id=s.get("speaker_id", "SPEAKER_1"),
                language=s.get("language", detected_lang), confidence=s.get("confidence"),
            ) for s in assigned_segments
        ]

        turn_out = [
            TurnOut(
                # FIX v20: normalize to "speaker N" without double-space bug
                speaker=re.sub(r"speaker\s*(\d+)", lambda m: f"Speaker {m.group(1)}", str(t.get("speaker", "Speaker 1")).lower().strip()) or "Speaker 1",
                speaker_id=t.get("speaker_id", "SPEAKER_1"),
                start=round(t.get("start", 0.0), 3), end=round(t.get("end", 0.0), 3),
                text=t.get("text", ""), segment_count=t.get("segment_count", 1),
            ) for t in turns
        ]

        dens = _script_density(normalized_text)
        detected_languages = [k for k, v in dens.items() if v > 0.05]

        return TranscribeResponse(
            success=True, status="ok", transcript_status="accepted",
            text=normalized_text, conversation_text=conversation_text,
            segments=segment_out, turns=turn_out, language=detected_lang,
            detected_languages=detected_languages, speaker_id="SPEAKER_1",
            speaker_count=speaker_count, needs_review=needs_review,
            diarization=diar_result, raw_text=normalized.get("raw_text", ""),
            normalized_text=normalized_text, coverage_ratio=coverage_ratio,
            confidence=quality.get("confidence", "unknown"),
            model_used=raw_result.get("model_used") or GEMINI_MODEL,
            fallback_used=bool(raw_result.get("fallback_used", False)),
            rejection_reason="", duration_sec=round(duration, 3),
        )

    finally:
        try:
            os.unlink(wav_path)
        except OSError:
            pass
        if vocal_source_path and vocal_source_path != audio_path and os.path.exists(vocal_source_path):
            try:
                os.unlink(vocal_source_path)
            except OSError:
                pass
        if _temp_remux:
            try:
                os.unlink(_temp_remux)
            except OSError:
                pass
        gc.collect()

# ── FastAPI ───────────────────────────────────────────────────────────────────
app = FastAPI(title="VoiceMind Transcription Service", version="19.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

@app.get("/")
def root():
    return {"status": "ok", "version": "19.0.0", "health": "/health", "upload_endpoint": "/transcribe-upload"}

@app.get("/health")
def health():
    ffmpeg_ok = subprocess.run(
        [FFMPEG_BIN, "-version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    ).returncode == 0
    return {
        "status": "ok", "version": "19.0.0",
        "transcribe_model": GEMINI_MODEL,
        "gemini_configured": bool(GOOGLE_API_KEY),
        "ffmpeg": "OK" if ffmpeg_ok else f"MISSING ({FFMPEG_BIN})",
        "normalizer": "available" if _HAS_NORMALIZER else "missing",
        "gujarati_lexicon": gujarati_lexicon_status(),
        "hindi_lexicon":    hindi_lexicon_status(),
        "diarization_enabled": ENABLE_DIARIZATION,
        "output_script_mode": OUTPUT_SCRIPT_MODE,
        # FIX (Improvement 5): expose real-time concurrency count
        "active_transcriptions": _active_transcriptions,
        "runtime_config": {
            "output_script_mode": OUTPUT_SCRIPT_MODE,
            "transcribe_model": GEMINI_MODEL,
        },
        "fix_applied": "v19.0.1 — Bugs 1-5 fixed: ffprobe stream-level fallback, AudioContext duration, concurrency tracking, conditional remux, durationSec priority.",
    }

@app.post("/transcribe", response_model=TranscribeResponse)
def transcribe(req: TranscribeRequest):
    return _run_transcription(req.audio_path, req.language, req.speaker_id)

# FIX (Improvement 5): Python-side concurrency counter for /transcribe-upload.
# Previously no tracking — logs showed concurrencyActive=0 always.
import asyncio as _asyncio
_active_transcriptions: int = 0
_transcription_lock = _asyncio.Lock()

@app.post("/transcribe-upload", response_model=TranscribeResponse)
@app.post("/transcribe-upload/transcribe-upload", response_model=TranscribeResponse)
async def transcribe_upload(
    file:                 UploadFile = File(...),
    language:             str = Form(default="auto"),
    speaker_id:           str = Form(default="SPEAKER_1"),
    meetingContext:       str = Form(default=""),
    diarization:          str = Form(default="false"),
    analysisWindowSec:    str = Form(default=""),
    focusFirstWindowOnly: str = Form(default="false"),
    chunkDiagnosticsJson: str = Form(default=""),
    meetingId:            str = Form(default=""),
):
    global _active_transcriptions
    async with _transcription_lock:
        _active_transcriptions += 1
        active = _active_transcriptions
    log.info(f"[CONCURRENCY] active={active} (request started) meetingId={meetingId or 'unknown'}")

    if not file or not file.filename:
        async with _transcription_lock:
            _active_transcriptions -= 1
        raise HTTPException(status_code=400, detail="No file uploaded")
    ext = Path(file.filename).suffix.lower() if file.filename else ".webm"
    if not ext:
        ct  = (file.content_type or "").lower()
        ext = ".webm" if "webm" in ct else ".wav" if "wav" in ct else ".ogg" if "ogg" in ct else ".webm"
    req_diar = str(diarization).strip().lower() in ("1", "true", "yes")
    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
        tmp_path = tmp.name
    try:
        file_content = await file.read()
        log.info(f"[INPUT] filename={file.filename} size={len(file_content)} lang={language} diarization={req_diar}")
        if len(file_content) < 512:
            return TranscribeResponse(
                success=False, status="skipped", transcript_status="no_speech", text="",
                rejection_reason="file_too_small", speaker_id=speaker_id, needs_review=True,
                diarization={"attempted": False, "applied": False, "speaker_count": 1,
                             "method": "none", "segments": [], "reason": "file too small", "error": None})
        with open(tmp_path, "wb") as f:
            f.write(file_content)
        return _run_transcription(tmp_path, language, speaker_id, request_diarization=req_diar)
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        async with _transcription_lock:
            _active_transcriptions -= 1
        log.info(f"[CONCURRENCY] active={_active_transcriptions} (request finished) meetingId={meetingId or 'unknown'}")

if __name__ == "__main__":
    import uvicorn
    host = os.getenv("SERVICE_HOST", "0.0.0.0")
    uvicorn.run(app, host=host, port=PORT, reload=False)