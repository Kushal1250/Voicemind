# python_services/transcription_service/transcript_grouping.py
import re
from typing import Any, Dict, List, Optional


def normalize_text(text: Any = "") -> str:
    return " ".join(str(text or "").replace("\n", " ").replace("\r", " ").split()).strip()


def format_timecode(seconds: float) -> str:
    total = max(0, int(float(seconds or 0)))
    h = str(total // 3600).zfill(2)
    m = str((total % 3600) // 60).zfill(2)
    s = str(total % 60).zfill(2)
    return f"{h}:{m}:{s}"


BAD_PATTERNS = [
    # ── prompt-leak detection — keep in sync with main.py PLACEHOLDER_PATTERNS ──
    re.compile(r"gujarati\s+speech\s+detected", re.I),
    re.compile(r"possible\s+interpretation", re.I),
    re.compile(r"this\s+appears\s+to\s+be", re.I),
    re.compile(r"the\s+speaker\s+says", re.I),
    re.compile(r"do\s+not\s+summarize", re.I),
    re.compile(r"return\s+only", re.I),
    re.compile(r"translate\s+the\s+following", re.I),
    re.compile(r"transcribe\s+in\s+gujarati", re.I),
    re.compile(r"render\s+hindi\s+words\s+in\s+gujarati\s+script", re.I),
    re.compile(r"multi[\s\-]+speaker\s+meeting", re.I),
    re.compile(r"preserve\s+speaker\s+changes", re.I),
    re.compile(r"avoid\s+collapsing\s+different\s+voices", re.I),
    re.compile(r"avoid\s+collapsing\s+(the\s+)?speakers", re.I),
    re.compile(r"gujarati[\s\-]+first\s+multilingual", re.I),
    re.compile(r"hindi[\s\-]+first\s+multilingual", re.I),
    re.compile(r"english[\s\-]+priority\s+multilingual", re.I),
    re.compile(r"automatic\s+multilingual\s+meeting\s+decoding", re.I),
    re.compile(r"prefer\s+exact\s+meeting\s+terms", re.I),
    re.compile(r"production.grade\s+(multilingual|transcription)", re.I),
    re.compile(r"speech\s+pipeline", re.I),
    re.compile(r"^\[?(?:અસ્પષ્ટ|unclear|inaudible)\]?$", re.I),
]


def is_bad_text(text: Any = "") -> bool:
    value = normalize_text(text)
    if not value:
        return True

    if any(pattern.search(value) for pattern in BAD_PATTERNS):
        return True

    compact = re.sub(r"\s+", "", value)
    if re.fullmatch(r"(?:\d+[-–—,.:/]*){12,}", compact):
        return True

    tokens = re.findall(r"[\w%:._'-]+", value.lower(), flags=re.UNICODE)
    if len(tokens) >= 10:
        unique_ratio = len(set(tokens)) / max(1, len(tokens))
        max_count = max(tokens.count(t) for t in set(tokens))
        if unique_ratio < 0.20 or max_count >= max(6, len(tokens) // 2):
            return True

    return False


def best_segment_text(segment: Dict[str, Any]) -> str:
    """
    Important fix:
    Prefer visible display fields first, but never throw away sourceText.
    Your old grouping could return 0 turns when the chosen field became empty.
    """
    candidates = [
        segment.get("displayText"),
        segment.get("finalValidatedText"),
        segment.get("text"),
        segment.get("normalizedText"),
        segment.get("sourceText"),
        segment.get("rawSourceText"),
        segment.get("englishText"),
        segment.get("translatedText"),
    ]

    for item in candidates:
        value = normalize_text(item)
        if value and not is_bad_text(value):
            return value

    return ""


def average_confidence(items: List[Dict[str, Any]]) -> Optional[float]:
    values = []
    for item in items:
        try:
            if item.get("confidence") is not None:
                values.append(float(item["confidence"]))
        except Exception:
            pass
    if not values:
        return None
    return round(sum(values) / len(values), 4)


def confidence_label(confidence: Optional[float]) -> str:
    if confidence is None:
        return "unknown"
    if confidence < 0.45:
        return "low"
    if confidence < 0.72:
        return "medium"
    return "high"


def clean_segment(segment: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    text = best_segment_text(segment)
    if not text:
        return None

    start = float(segment.get("start", 0.0) or 0.0)
    end = float(segment.get("end", start) or start)
    if end < start:
        end = start

    speaker = normalize_text(segment.get("speaker")) or "Speaker 1"

    return {
        **segment,
        "start": start,
        "end": end,
        "startMs": int(round(start * 1000)),
        "endMs": int(round(end * 1000)),
        "speaker": speaker,
        "text": text,
        "displayText": text,
        "finalValidatedText": text,
        "sourceText": normalize_text(segment.get("sourceText")) or text,
        "englishText": normalize_text(segment.get("englishText")),
        "words": list(segment.get("words") or []),
    }


def should_merge(previous: Dict[str, Any], current: Dict[str, Any]) -> bool:
    if previous.get("speaker") != current.get("speaker"):
        return False

    gap = float(current.get("start", 0.0) or 0.0) - float(previous.get("end", 0.0) or 0.0)
    if gap < 0:
        gap = 0

    # 0.8 s is tight enough to prevent cross-speaker collapse while still joining
    # naturally-paced same-speaker utterances.  2.0 s was too wide and caused
    # different speakers separated by a short pause to merge into one turn.
    return gap <= 0.8


def group_speaker_turns(segments: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    cleaned = [
        item
        for item in (clean_segment(segment) for segment in list(segments or []))
        if item is not None
    ]

    cleaned.sort(key=lambda item: (item["start"], item["end"], item["speaker"]))

    grouped: List[Dict[str, Any]] = []

    for segment in cleaned:
        if not grouped:
            grouped.append({**segment, "segments": [{**segment}]})
            continue

        previous = grouped[-1]
        if should_merge(previous, segment):
            previous["end"] = max(float(previous["end"]), float(segment["end"]))
            previous["endMs"] = int(round(previous["end"] * 1000))
            previous["text"] = normalize_text(f"{previous.get('text', '')} {segment.get('text', '')}")
            previous["displayText"] = previous["text"]
            previous["finalValidatedText"] = previous["text"]
            previous["sourceText"] = normalize_text(f"{previous.get('sourceText', '')} {segment.get('sourceText', '')}")
            previous["englishText"] = normalize_text(f"{previous.get('englishText', '')} {segment.get('englishText', '')}")
            previous["words"].extend(segment.get("words") or [])
            previous["segments"].append({**segment})
        else:
            grouped.append({**segment, "segments": [{**segment}]})

    output: List[Dict[str, Any]] = []
    for index, turn in enumerate(grouped):
        confidence = average_confidence(turn.get("segments") or [])
        start = float(turn.get("start", 0.0) or 0.0)
        end = float(turn.get("end", start) or start)
        text = normalize_text(turn.get("text"))

        if not text:
            continue

        output.append({
            **turn,
            "id": index,
            "start": start,
            "end": end,
            "startMs": int(round(start * 1000)),
            "endMs": int(round(end * 1000)),
            "speaker": normalize_text(turn.get("speaker")) or f"Speaker {index + 1}",
            "text": text,
            "displayText": text,
            "finalValidatedText": text,
            "confidence": confidence,
            "confidenceLabel": confidence_label(confidence),
            "segmentCount": len(turn.get("segments") or []),
            "timecode": f"{format_timecode(start)} - {format_timecode(end)}",
        })

    return output