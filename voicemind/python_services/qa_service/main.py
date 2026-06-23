"""
main.py — VoiceMind QA Service v9.1
=====================================
Production-ready FastAPI service.

Providers:  Google Gemini (primary)  →  Ollama qwen2.5:latest (fallback)
No LM Studio. No other providers.

Changes from v9.0 (root-cause fixes)
-------------------------------------
- Explicit word-count requests ("...in 200 words", "2000-word summary") are
  now parsed (classifier.extract_word_target) and turned into both a prompt
  instruction and a dynamically computed output token budget
  (compute_max_tokens). Previously every request shared one fixed
  QA_MAX_LLM_TOKENS cap (as low as ~500 in this deployment's .env — nowhere
  near enough for a 2000-word summary), so longer requests were silently
  truncated to roughly the same length as short ones.
- `sources` (the evidence shown to the user) is no longer just
  `evidence[:12]`. For summary/notes/language questions, where `evidence`
  was every segment in chronological order, that meant the same opening
  lines every time regardless of the question — fixed by
  retrieval.select_representative_evidence(), which spreads picks across
  the whole transcript. For general QA, sources are now ranked by actual
  relevance score (retrieval.select_top_scored()) instead of by transcript
  position. `context_block` fed to the LLM is unchanged in both cases.
- SUMMARY/MEETING_NOTES prompts now explicitly ask for full-transcript
  coverage, note speaker/language changes, and forbid repeating a stock
  opening sentence across answers.

Changes from v7.0
-----------------
- Modular: providers.py / retrieval.py / classifier.py
- Hybrid retrieval: TF-IDF + Unicode script matching + entity boosting + neighbors
- 10-category question classifier → specialized prompt templates
- Language breakdown endpoint (/qa/language-analysis)
- Entity extraction endpoint (/qa/entities)
- Full multilingual support: English / Gujarati / Hindi
- Evidence-only answering — "Not found in transcript." on no evidence
- QA_MAX_EVIDENCE_CHUNKS raised to 10 (with ±1 neighbor expansion)
- All LM Studio code removed
"""

from __future__ import annotations

import os
import re
import time
from typing import Any, Dict, List, Optional

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

load_dotenv()

# Import internal modules
from providers import PROVIDER_ORDER, get_providers_health, GeminiProvider, QwenProvider
from retrieval import (
    build_context_block,
    build_full_context,
    detect_language,
    hybrid_retrieve,
    select_representative_evidence,
    select_top_scored,
    GUJARATI_RE,
    DEVANAGARI_RE,
    format_ms,
)
from classifier import (
    classify_question, get_prompt, SUMMARY, MEETING_NOTES, LANGUAGE_DETECTION,
    extract_word_target, build_length_instruction,
)

# ─── App config ───────────────────────────────────────────────────────────────

DEBUG             = os.getenv("DEBUG", "false").strip().lower() in {"1", "true", "yes", "on"}
PORT              = int(os.getenv("PORT", "8002"))
MAX_CONTEXT_CHARS = int(os.getenv("QA_CONTEXT_CHARS", "32000"))
TOP_K_CHUNKS      = int(os.getenv("QA_TOP_K_CHUNKS", "10"))
NEIGHBOR_WINDOW   = int(os.getenv("QA_NEIGHBOR_WINDOW", "1"))
QA_MAX_LLM_TOKENS = int(os.getenv("QA_MAX_LLM_TOKENS", "1000"))

app = FastAPI(title="VoiceMind Q&A Service", version="9.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _debug(tag: str, **kwargs: Any) -> None:
    if DEBUG:
        print(f"[qa:{tag}]", kwargs or "")


# ─── Pydantic models ──────────────────────────────────────────────────────────

class SourceModel(BaseModel):
    startMs: int = 0
    endMs: int = 0
    textSnippet: str
    confidence: Optional[float] = None
    speaker: Optional[str] = None


class QARequest(BaseModel):
    question: str
    context: str
    meetingId: Optional[str] = None
    sources: Optional[List[SourceModel]] = None
    systemPrompt: Optional[str] = None


class QAResponse(BaseModel):
    answer: str
    sources: List[SourceModel]
    processingTime: float
    confidence: str = "medium"
    mode: str = "fallback_rule_based"
    questionCategory: Optional[str] = None


class EntityRequest(BaseModel):
    context: str


class LanguageRequest(BaseModel):
    context: str


# ─── Transcript parsing ───────────────────────────────────────────────────────

_TS_LINE_RE = re.compile(
    r"^\[(\d{2}:\d{2}:\d{2})-(\d{2}:\d{2}:\d{2})\]\s+([^:]+):\s*(.+)$"
)


def _tc_to_ms(tc: str) -> int:
    hh, mm, ss = (int(p) for p in tc.split(":"))
    return ((hh * 60 + mm) * 60 + ss) * 1000


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def parse_context(context: str) -> List[Dict[str, Any]]:
    """
    Parse the formatted transcript context into segment dicts.

    Supported format:  [HH:MM:SS-HH:MM:SS] Speaker N: text
    Falls back to bare lines with synthetic timestamps.
    """
    segments: List[Dict[str, Any]] = []
    for idx, raw_line in enumerate(str(context or "").splitlines()):
        line = _normalize(raw_line)
        if not line:
            continue
        m = _TS_LINE_RE.match(line)
        if m:
            start_tc, end_tc, speaker, text = m.groups()
            segments.append({
                "index":   idx,
                "startMs": _tc_to_ms(start_tc),
                "endMs":   _tc_to_ms(end_tc),
                "speaker": _normalize(speaker) or "Speaker 1",
                "text":    _normalize(text),
            })
        else:
            segments.append({
                "index":   idx,
                "startMs": idx * 5000,
                "endMs":   idx * 5000 + 4000,
                "speaker": "Speaker 1",
                "text":    line,
            })
    return [s for s in segments if s["text"]]


def build_sources(items: List[Dict[str, Any]]) -> List[SourceModel]:
    return [
        SourceModel(
            startMs=int(item.get("startMs", 0) or 0),
            endMs=int(item.get("endMs", item.get("startMs", 0)) or 0),
            textSnippet=_normalize(item.get("text", ""))[:320],
            confidence=float(item.get("confidence", 0.75) or 0.75),
            speaker=_normalize(item.get("speaker", "")) or None,
        )
        for item in items
        if _normalize(item.get("text", ""))
    ]


# ─── Rule-based answers (no-LLM fallback) ────────────────────────────────────

def _rule_based_answer(
    question: str,
    segments: List[Dict[str, Any]],
    evidence: List[Dict[str, Any]],
) -> Optional[str]:
    """
    Lightweight rule-based answerer for edge cases.
    Returns None if no confident rule applies.
    """
    q = _normalize(question).lower()
    combined = " ".join(s["text"] for s in segments)

    # Speaker count
    if re.search(r"how many speakers|speaker count|number of speakers", q):
        speakers = sorted({_normalize(s.get("speaker", "")) for s in segments if s.get("speaker")})
        return f"The transcript contains {len(speakers)} speaker(s): {', '.join(speakers)}."

    # Word count
    if re.search(r"how many words|word count", q):
        wc = len(combined.split())
        return f"The transcript contains approximately {wc} words."

    # Duration
    if re.search(r"how long|duration|how many minutes", q) and segments:
        start_ms = min(s["startMs"] for s in segments)
        end_ms   = max(s.get("endMs", s["startMs"]) for s in segments)
        total_s  = max(0, (end_ms - start_ms) // 1000)
        mins, secs = divmod(total_s, 60)
        return f"The transcript covers approximately {mins} minute(s) and {secs} second(s)."

    return None


# ─── Weak answer detection ────────────────────────────────────────────────────

_WEAK_RE = re.compile(
    r"(transcript does not contain|not enough information|insufficient information"
    r"|i (cannot|can't) (identify|find|determine)|no information available"
    r"|information is not (available|present)"
    r"|not mentioned in the transcript|no .{0,40} found in the transcript)",
    re.I,
)


def _is_weak(answer: Optional[str]) -> bool:
    if not answer or len(answer.strip()) < 6:
        return True
    return bool(_WEAK_RE.search(answer))


# ─── Output token budget ──────────────────────────────────────────────────────
#
# ROOT-CAUSE FIX: every request previously used the same fixed
# QA_MAX_LLM_TOKENS cap (configured as low as ~500 in this deployment's
# .env — well under 400 words). That made a 200-word summary borderline and
# a 2000-word summary structurally impossible no matter what the prompt
# said. The cap is now computed per-request: an explicit word target gets a
# generous, script-aware token estimate (Gujarati/Hindi text needs more
# tokens per word than English), and summary/notes questions without an
# explicit target still get more room than a one-line answer needs.

def compute_max_tokens(word_target: Optional[int], category: str) -> int:
    if word_target:
        estimated = int(word_target * 2.2) + 200
        return max(QA_MAX_LLM_TOKENS, min(estimated, 8000))
    if category in (SUMMARY, MEETING_NOTES):
        return max(QA_MAX_LLM_TOKENS, 1600)
    return QA_MAX_LLM_TOKENS


# ─── Main QA pipeline ─────────────────────────────────────────────────────────

def run_qa_pipeline(request: QARequest) -> QAResponse:
    started = time.perf_counter()
    question = _normalize(request.question)
    segments = parse_context(request.context)

    if not segments:
        return QAResponse(
            answer="I do not have transcript evidence yet for this question.",
            sources=[],
            processingTime=time.perf_counter() - started,
            confidence="low",
            mode="no_transcript",
            questionCategory="general_qa",
        )

    # Step 1: Classify question
    category, system_prompt = get_prompt(question)

    # Detect an explicit requested length ("...in 200 words", "2000-word
    # summary") and fold it into the system prompt. Previously nothing
    # parsed this at all, so a 200-word and a 2000-word request produced
    # the same (often truncated) answer.
    word_target = extract_word_target(question)
    length_instruction = build_length_instruction(word_target)
    if length_instruction:
        system_prompt = f"{system_prompt}\n\n{length_instruction}"

    # Override with user-supplied system prompt if provided
    if request.systemPrompt:
        system_prompt = request.systemPrompt

    _debug("classify", question=question[:80], category=category, word_target=word_target)

    # Step 2: Hybrid retrieval
    # For summary / meeting_notes / language_detection → use ALL segments (full context)
    if category in (SUMMARY, MEETING_NOTES, LANGUAGE_DETECTION):
        evidence = segments
        context_block = build_full_context(segments, MAX_CONTEXT_CHARS)
        # Display sources spread across the WHOLE transcript (not just the
        # opening lines) so the proof cards reflect the whole conversation.
        source_pool = select_representative_evidence(segments, limit=12)
    else:
        evidence = hybrid_retrieve(
            question, segments,
            top_k=TOP_K_CHUNKS,
            neighbor_window=NEIGHBOR_WINDOW,
        )
        context_block = build_context_block(evidence, MAX_CONTEXT_CHARS)
        # Display sources ranked by relevance score, not by transcript
        # position — the LLM still gets `context_block` in chronological
        # order, this only changes what's surfaced as proof cards.
        source_pool = select_top_scored(evidence, limit=12)

    _debug("retrieval", evidence_count=len(evidence), source_count=len(source_pool))

    sources = build_sources(source_pool)

    # Step 3: Rule-based answer for trivial queries
    rule_answer = _rule_based_answer(question, segments, evidence)
    if rule_answer:
        return QAResponse(
            answer=rule_answer,
            sources=sources,
            processingTime=time.perf_counter() - started,
            confidence="high",
            mode="rule_based",
            questionCategory=category,
        )

    # Step 4: LLM providers (Gemini → Qwen)
    max_tokens = compute_max_tokens(word_target, category)
    final_answer: Optional[str] = None
    mode = "fallback_rule_based"
    saw_weak = False

    for provider in PROVIDER_ORDER:
        _debug("try_provider", name=provider.name, max_tokens=max_tokens)
        llm_answer = provider.answer_question(
            question,
            context_block,
            system_prompt,
            max_tokens,
        )
        if not llm_answer:
            _debug("provider_empty", name=provider.name)
            continue
        if _is_weak(llm_answer) and len(evidence) > 0:
            _debug("provider_weak", name=provider.name, answer=llm_answer[:80])
            saw_weak = True
            continue
        final_answer = llm_answer
        mode = provider.name
        break

    # Step 5: Compose final response
    if final_answer:
        confidence = "high" if len(evidence) >= 3 else "medium"
    elif saw_weak and evidence:
        # LLM gave a weak refusal but we DO have evidence — return clean extractive answer.
        # Use the same well-distributed source_pool (not raw `evidence`) so this
        # fallback doesn't collapse back to the first few transcript lines.
        # Timestamps are excluded from the answer text; they are preserved in sources field.
        lines = [
            f"{s['speaker']}: {s['text']}"
            for s in source_pool[:5]
        ]
        final_answer = "Based on the transcript:\n" + "\n".join(lines)
        confidence = "medium"
        mode = "extractive_fallback"
    else:
        final_answer = (
            "Not found in transcript."
            if not evidence
            else "Based on the transcript:\n" + "\n".join(s["text"] for s in source_pool[:3])
        )
        confidence = "low"
        mode = "fallback_rule_based"

    return QAResponse(
        answer=final_answer,
        sources=sources,
        processingTime=time.perf_counter() - started,
        confidence=confidence,
        mode=mode,
        questionCategory=category,
    )


# ─── Language analysis ────────────────────────────────────────────────────────

def _analyze_languages(segments: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Per-segment language detection → aggregate breakdown.
    Detects Gujarati, Hindi/Devanagari, English, Mixed.
    """
    lang_counter: Dict[str, int] = {"gujarati": 0, "devanagari": 0, "latin": 0, "mixed": 0}
    per_speaker: Dict[str, Dict[str, int]] = {}
    gujarati_segs: List[Dict[str, str]] = []
    devanagari_segs: List[Dict[str, str]] = []

    for seg in segments:
        text = seg["text"]
        speaker = seg.get("speaker", "Speaker 1")
        lang = detect_language(text)
        primary = lang.split("_")[0]  # "mixed_gujarati" → "gujarati" for counting
        lang_counter[primary] = lang_counter.get(primary, 0) + 1
        if speaker not in per_speaker:
            per_speaker[speaker] = {}
        per_speaker[speaker][primary] = per_speaker[speaker].get(primary, 0) + 1

        if GUJARATI_RE.search(text):
            gujarati_segs.append({
                "speaker": speaker,
                "timestamp": format_ms(seg.get("startMs", 0)),
                "text": text,
            })
        if DEVANAGARI_RE.search(text):
            devanagari_segs.append({
                "speaker": speaker,
                "timestamp": format_ms(seg.get("startMs", 0)),
                "text": text,
            })

    total = max(1, sum(lang_counter.values()))
    speakers_by_lang: Dict[str, List[str]] = {"gujarati": [], "devanagari": [], "latin": []}
    for sp, counts in per_speaker.items():
        dominant = max(counts, key=counts.get)
        if dominant in speakers_by_lang:
            speakers_by_lang[dominant].append(sp)

    return {
        "breakdown": {
            k: {"count": v, "percentage": round(100 * v / total, 1)}
            for k, v in lang_counter.items()
            if v > 0
        },
        "speakersByLanguage": speakers_by_lang,
        "gujaratiSegments": gujarati_segs,
        "hindiSegments": devanagari_segs,
    }


# ─── Routes ───────────────────────────────────────────────────────────────────

@app.get("/")
def root() -> Dict[str, Any]:
    return {
        "success": True,
        "service": "voicemind_qa_service",
        "version": "9.1.0",
        "status": "ok",
        "providers": [p.name for p in PROVIDER_ORDER],
    }


@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "status": "healthy",
        "providers": get_providers_health(),
        "version": "9.1.0",
    }


@app.post("/qa", response_model=QAResponse)
def qa(request: QARequest) -> QAResponse:
    """Main QA endpoint. Called by backend for every meeting question."""
    return run_qa_pipeline(request)


@app.post("/qa/language-analysis")
def language_analysis(request: LanguageRequest) -> Dict[str, Any]:
    """
    Analyse languages used in a transcript.
    Returns breakdown, per-speaker stats, and all Gujarati/Hindi sentences.
    """
    segments = parse_context(request.context)
    if not segments:
        raise HTTPException(status_code=400, detail="No transcript content provided.")
    return {"success": True, "data": _analyze_languages(segments)}


@app.post("/qa/entities")
def entities(request: EntityRequest) -> Dict[str, Any]:
    """
    Extract named entities from transcript using the primary LLM provider.
    Fallback to regex-based extraction if LLM unavailable.
    """
    segments = parse_context(request.context)
    if not segments:
        raise HTTPException(status_code=400, detail="No transcript content provided.")
    full_text = build_full_context(segments, MAX_CONTEXT_CHARS)

    # Try LLM first
    for provider in PROVIDER_ORDER:
        result = provider.extract_entities(full_text)
        if result:
            return {"success": True, "data": {"raw": result, "provider": provider.name}}

    # Fallback: regex-based entity extraction
    from retrieval import extract_entities_from_text
    combined = " ".join(s["text"] for s in segments)
    entities_list = extract_entities_from_text(combined)
    return {
        "success": True,
        "data": {
            "raw": "\n".join(entities_list),
            "provider": "regex_fallback",
            "entities": entities_list,
        },
    }


@app.post("/qa/summarize")
def summarize_transcript(request: LanguageRequest) -> Dict[str, Any]:
    """Generate a meeting summary using the full transcript."""
    segments = parse_context(request.context)
    if not segments:
        raise HTTPException(status_code=400, detail="No transcript content provided.")
    full_text = build_full_context(segments, MAX_CONTEXT_CHARS)

    for provider in PROVIDER_ORDER:
        result = provider.summarize(full_text)
        if result:
            return {"success": True, "data": {"summary": result, "provider": provider.name}}

    raise HTTPException(status_code=503, detail="No LLM provider available for summarization.")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT, reload=False)
