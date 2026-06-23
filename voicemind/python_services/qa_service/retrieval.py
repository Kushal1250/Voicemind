"""
retrieval.py — VoiceMind QA Service v9.0
==========================================
Hybrid retrieval: TF-IDF scoring + Unicode keyword matching + neighboring chunks.
Handles English, Gujarati (0x0A80–0x0AFF), and Hindi/Devanagari (0x0900–0x097F).

Architecture
-----------
Step 1  – Semantic/TF-IDF: score each segment against the question using
           term frequency with IDF weighting across the corpus.
Step 2  – Keyword: detect non-ASCII script matches (Gujarati / Devanagari)
           that TF-IDF misses because they are rare.
Step 3  – Entity boosting: boost segments that match extracted proper nouns
           from the question.
Step 4  – Merge + rerank: combine scores, return top-k with their neighbors.
"""

from __future__ import annotations

import math
import re
import unicodedata
from collections import Counter, defaultdict
from typing import Any, Dict, List, Optional, Set, Tuple

# ─── Script detection ─────────────────────────────────────────────────────────

GUJARATI_RE   = re.compile(r"[\u0A80-\u0AFF]+")
DEVANAGARI_RE = re.compile(r"[\u0900-\u097F]+")
LATIN_TOKEN_RE = re.compile(r"[A-Za-z0-9_'-]+")
ANY_WORD_RE    = re.compile(r"\S+")  # for non-ASCII scripts

SCRIPT_NAMES = {
    "latin": LATIN_TOKEN_RE,
    "gujarati": GUJARATI_RE,
    "devanagari": DEVANAGARI_RE,
}


def detect_language(text: str) -> str:
    """Return dominant script: 'gujarati', 'devanagari', 'latin', or 'mixed'."""
    gu_chars = len(GUJARATI_RE.findall(text))
    dv_chars = len(DEVANAGARI_RE.findall(text))
    la_chars = len(LATIN_TOKEN_RE.findall(text))
    total = gu_chars + dv_chars + la_chars
    if total == 0:
        return "unknown"
    gu_r = gu_chars / total
    dv_r = dv_chars / total
    la_r = la_chars / total
    if gu_r > 0.4:
        return "gujarati" if la_r < 0.3 else "mixed_gujarati"
    if dv_r > 0.4:
        return "devanagari" if la_r < 0.3 else "mixed_devanagari"
    return "latin"


# ─── Tokenization (Unicode-aware) ────────────────────────────────────────────

EN_STOP_WORDS: Set[str] = {
    "the", "a", "an", "and", "or", "but", "for", "with", "from", "that", "this",
    "these", "those", "is", "are", "was", "were", "be", "been", "have", "has",
    "had", "do", "does", "did", "will", "would", "shall", "should", "could",
    "may", "might", "must", "can", "i", "we", "you", "he", "she", "it", "they",
    "me", "us", "him", "her", "them", "my", "your", "his", "its", "our", "their",
    "in", "on", "at", "by", "of", "to", "up", "out", "if", "as", "so", "yet",
    "nor", "not", "what", "when", "where", "which", "who", "whom", "whose",
    "why", "how", "tell", "show", "meeting", "transcript", "question", "answer",
    "about", "please", "give", "list", "all", "any",
}


def _tokenize_text(text: str) -> List[str]:
    """Unicode-aware tokenizer: handles Latin, Gujarati, Devanagari."""
    normalized = re.sub(r"\s+", " ", str(text or "")).strip()
    tokens: List[str] = []

    # Gujarati tokens (keep as-is)
    for m in GUJARATI_RE.finditer(normalized):
        tokens.append(m.group())

    # Devanagari tokens (keep as-is)
    for m in DEVANAGARI_RE.finditer(normalized):
        tokens.append(m.group())

    # Latin tokens (lowercase, filter stop words)
    for m in LATIN_TOKEN_RE.finditer(normalized.lower()):
        tok = m.group()
        if len(tok) > 1 and tok not in EN_STOP_WORDS:
            tokens.append(tok)

    return tokens


def _extract_non_ascii_chunks(text: str) -> List[str]:
    """Extract all non-ASCII word sequences for direct script matching."""
    chunks: List[str] = []
    for m in GUJARATI_RE.finditer(text):
        chunks.append(m.group())
    for m in DEVANAGARI_RE.finditer(text):
        chunks.append(m.group())
    return chunks


# ─── TF-IDF scoring ───────────────────────────────────────────────────────────

class TFIDFIndex:
    def __init__(self, segments: List[Dict[str, Any]]) -> None:
        self._segments = segments
        self._doc_tokens: List[List[str]] = [_tokenize_text(s["text"]) for s in segments]
        self._idf: Dict[str, float] = {}
        self._build_idf()

    def _build_idf(self) -> None:
        N = len(self._doc_tokens)
        if N == 0:
            return
        df: Counter = Counter()
        for tokens in self._doc_tokens:
            for tok in set(tokens):
                df[tok] += 1
        for tok, count in df.items():
            self._idf[tok] = math.log((N + 1) / (count + 1)) + 1.0

    def score(self, query_tokens: List[str], doc_idx: int) -> float:
        doc_toks = self._doc_tokens[doc_idx]
        if not doc_toks:
            return 0.0
        tf_counter = Counter(doc_toks)
        doc_len = len(doc_toks)
        score = 0.0
        # BM25-inspired TF normalization
        k1, b = 1.5, 0.75
        avg_len = sum(len(t) for t in self._doc_tokens) / max(1, len(self._doc_tokens))
        for tok in query_tokens:
            if tok not in tf_counter:
                continue
            tf = tf_counter[tok]
            idf = self._idf.get(tok, 1.0)
            tf_norm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * doc_len / max(1, avg_len)))
            score += idf * tf_norm
        return score


# ─── Keyword / script matching ────────────────────────────────────────────────

def _exact_script_score(query_text: str, segment_text: str) -> float:
    """
    Score non-ASCII (Gujarati / Devanagari) overlap between query and segment.
    Each matching Unicode word adds to the score.
    """
    q_chunks = set(_extract_non_ascii_chunks(query_text))
    s_chunks = set(_extract_non_ascii_chunks(segment_text))
    if not q_chunks:
        return 0.0
    matched = q_chunks & s_chunks
    return 10.0 * len(matched) / max(1, len(q_chunks))


def _substring_script_score(query_text: str, segment_text: str) -> float:
    """Partial match: any query non-ASCII chunk that appears as substring of segment."""
    q_chunks = _extract_non_ascii_chunks(query_text)
    if not q_chunks:
        return 0.0
    score = 0.0
    for chunk in q_chunks:
        if chunk in segment_text:
            score += 5.0
    return score


# ─── Entity / proper noun boosting ───────────────────────────────────────────

# Patterns that suggest a proper noun follows
NAME_PATTERNS = [
    re.compile(r"\bmy name is ([A-Za-z][A-Za-z\s]{1,40})\b", re.I),
    re.compile(r"\bi am ([A-Za-z][A-Za-z\s]{1,40})\b", re.I),
    re.compile(r"\bthis is ([A-Za-z][A-Za-z\s]{1,40})\b", re.I),
    re.compile(r"\bname (?:is|was) ([A-Za-z][A-Za-z\s]{1,40})\b", re.I),
    re.compile(r"\bmारं नाम (?:छे )?([A-Za-z\u0A80-\u0AFF\u0900-\u097F][A-Za-z\u0A80-\u0AFF\u0900-\u097F\s]{1,40})\b"),
    re.compile(r"\bमारू नामू ([A-Za-z\u0A80-\u0AFF\u0900-\u097F]+)", re.I),
    # Gujarati name pattern: "મારું નામ X છે"
    re.compile(r"મારું\s+નામ\s+([^\s]+(?:\s+[^\s]+)?)\s+છે"),
    re.compile(r"मारा नाम ([^\s]+(?:\s+[^\s]+)?)"),
]


def extract_entities_from_text(text: str) -> List[str]:
    """Extract candidate proper nouns / entities from text."""
    entities: List[str] = []
    for pat in NAME_PATTERNS:
        for m in pat.finditer(text):
            ent = m.group(1).strip()
            if ent:
                entities.append(ent)
    # Also grab capitalised sequences (potential names)
    for m in re.finditer(r"\b([A-Z][a-z]+ (?:[A-Z][a-z]+)(?:\s+[A-Z][a-z]+)*)\b", text):
        entities.append(m.group(1))
    return entities


def _entity_boost(question: str, segment_text: str) -> float:
    """Boost score when question entity appears in segment."""
    q_entities = extract_entities_from_text(question)
    if not q_entities:
        return 0.0
    score = 0.0
    for ent in q_entities:
        if ent.lower() in segment_text.lower():
            score += 6.0
        elif any(part.lower() in segment_text.lower() for part in ent.split() if len(part) > 2):
            score += 3.0
    return score


# ─── Speaker matching ─────────────────────────────────────────────────────────

def _speaker_score(question: str, segment: Dict[str, Any]) -> float:
    """Boost when question mentions a speaker label."""
    q_lower = question.lower()
    speaker = str(segment.get("speaker", "")).lower()
    if not speaker:
        return 0.0
    score = 0.0
    # Explicit "speaker 2" style
    if re.search(r"speaker\s*\d+", q_lower) and re.search(r"speaker\s*\d+", speaker):
        q_nums = set(re.findall(r"\d+", q_lower))
        s_nums = set(re.findall(r"\d+", speaker))
        if q_nums & s_nums:
            score += 8.0
    # General speaker mention
    if speaker and speaker in q_lower:
        score += 5.0
    return score


# ─── Main hybrid retrieval ────────────────────────────────────────────────────

def hybrid_retrieve(
    question: str,
    segments: List[Dict[str, Any]],
    top_k: int = 8,
    neighbor_window: int = 1,
) -> List[Dict[str, Any]]:
    """
    Hybrid retrieval: TF-IDF + Unicode script matching + entity boosting.

    Returns top_k segments (with neighbors) sorted by timestamp.
    """
    if not segments:
        return []

    index = TFIDFIndex(segments)
    q_tokens = _tokenize_text(question)

    raw_scores: List[float] = []
    for i, seg in enumerate(segments):
        tfidf_s = index.score(q_tokens, i)
        script_s = _exact_script_score(question, seg["text"])
        substr_s = _substring_script_score(question, seg["text"])
        entity_s = _entity_boost(question, seg["text"])
        speaker_s = _speaker_score(question, seg)
        total = tfidf_s + script_s + substr_s + entity_s + speaker_s
        raw_scores.append(total)

    # Pick top_k indices by score
    indexed_scores = sorted(
        enumerate(raw_scores), key=lambda x: -x[1]
    )
    top_indices: Set[int] = set()
    for idx, score in indexed_scores[:top_k]:
        if score > 0:
            top_indices.add(idx)
            # Expand with neighbors
            for offset in range(-neighbor_window, neighbor_window + 1):
                nbr = idx + offset
                if 0 <= nbr < len(segments):
                    top_indices.add(nbr)

    if not top_indices:
        # No positive scores — return top segments by raw TF-IDF
        top_indices = {i for i, _ in indexed_scores[: min(top_k, len(segments))]}

    # Sort by original position (timestamp order)
    result = [
        {**segments[i], "_score": raw_scores[i]}
        for i in sorted(top_indices)
    ]
    return result


# ─── Context block builder ────────────────────────────────────────────────────

def format_ms(ms: int) -> str:
    total = max(0, int(ms) // 1000)
    return f"{total // 3600:02d}:{(total % 3600) // 60:02d}:{total % 60:02d}"


def build_context_block(
    evidence: List[Dict[str, Any]],
    max_chars: int = 24000,
) -> str:
    """Build a formatted context block with speaker, timestamps, and text."""
    lines: List[str] = []
    for item in evidence:
        start = format_ms(int(item.get("startMs", 0) or 0))
        end   = format_ms(int(item.get("endMs", item.get("startMs", 0)) or 0))
        speaker = str(item.get("speaker", "Speaker")).strip() or "Speaker"
        text = str(item.get("text", "")).strip()
        if text:
            lines.append(f"[{start}-{end}] {speaker}: {text}")
    block = "\n".join(lines)
    return block[:max_chars]


def build_full_context(
    segments: List[Dict[str, Any]],
    max_chars: int = 48000,
) -> str:
    """Full transcript formatted context (for summaries, notes)."""
    return build_context_block(segments, max_chars)


# ─── Evidence/source selection for DISPLAY (separate from LLM context) ───────
#
# ROOT-CAUSE FIX: the old code built `sources` from `evidence[:12]` directly.
# For summary-type questions `evidence` was simply ALL segments in transcript
# order, so the first N (and therefore the 4 the frontend actually renders)
# were always the literal opening lines of the transcript — identical for
# every question, regardless of wording or requested length. For general QA,
# `evidence` was relevance-filtered but then re-sorted by timestamp, so the
# *displayed* sources were the earliest relevant matches rather than the
# *best* relevant matches.
#
# The two functions below fix this without touching how `context_block` is
# built for the LLM (that logic — full transcript for summaries, retrieved
# chunks for general QA — is unchanged and correct).

def _norm_key(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip().lower()


def _spread_order(n: int) -> List[int]:
    """
    Return an index ordering 0..n-1 such that ANY PREFIX of the sequence is
    itself a roughly-even spread across the full range (start, end, middle,
    quarter points, ...). The frontend only ever renders the first 4 items
    of `sources`, so this guarantees those 4 already span the beginning,
    middle, and end of the transcript instead of being clustered together.
    """
    if n <= 0:
        return []
    if n == 1:
        return [0]
    order = [0, n - 1]
    seen = {0, n - 1}
    queue: List[Tuple[int, int]] = [(0, n - 1)]
    while len(order) < n and queue:
        next_queue: List[Tuple[int, int]] = []
        for lo, hi in queue:
            if hi - lo <= 1:
                continue
            mid = (lo + hi) // 2
            if mid not in seen:
                order.append(mid)
                seen.add(mid)
            next_queue.append((lo, mid))
            next_queue.append((mid, hi))
        queue = next_queue
    for i in range(n):
        if i not in seen:
            order.append(i)
            seen.add(i)
    return order


def select_representative_evidence(
    segments: List[Dict[str, Any]],
    limit: int = 12,
) -> List[Dict[str, Any]]:
    """
    Pick up to `limit` segments spread across the ENTIRE transcript for
    summary-type questions ("Evidence should come from spread-out parts of
    the transcript so the user sees proof from the whole conversation").

    Strategy: split the transcript into `limit` position buckets, visit the
    buckets in a start/end/middle "spread order" (see _spread_order) so
    even a short prefix is well-distributed, and from each bucket pick the
    longest not-yet-seen segment (longer lines tend to carry more usable
    evidence). Near-duplicate text is skipped.
    """
    n = len(segments)
    if n == 0:
        return []
    if n <= limit:
        return list(segments)

    bucket_count = limit
    bucket_size = n / float(bucket_count)
    chosen: List[Dict[str, Any]] = []
    seen_text: Set[str] = set()

    for bucket_idx in _spread_order(bucket_count):
        start = int(bucket_idx * bucket_size)
        end = int((bucket_idx + 1) * bucket_size) if bucket_idx < bucket_count - 1 else n
        end = max(end, start + 1)
        bucket = segments[start:min(end, n)]
        if not bucket:
            continue
        bucket_sorted = sorted(bucket, key=lambda s: len(str(s.get("text", ""))), reverse=True)
        picked = next((s for s in bucket_sorted if _norm_key(s.get("text", "")) not in seen_text), None)
        if picked is None:
            continue
        seen_text.add(_norm_key(picked.get("text", "")))
        chosen.append(picked)
        if len(chosen) >= limit:
            break

    return chosen


def select_top_scored(evidence: List[Dict[str, Any]], limit: int = 12) -> List[Dict[str, Any]]:
    """
    Rank already-retrieved evidence (which carries a `_score` from
    hybrid_retrieve) by relevance, highest first, for *display* purposes.
    `context_block` for the LLM is still built from the chronologically
    ordered `evidence` list — this only changes what shows up as `sources`.
    """
    seen_text: Set[str] = set()
    ranked = sorted(evidence, key=lambda s: s.get("_score", 0.0), reverse=True)
    out: List[Dict[str, Any]] = []
    for item in ranked:
        key = _norm_key(item.get("text", ""))
        if not key or key in seen_text:
            continue
        seen_text.add(key)
        out.append(item)
        if len(out) >= limit:
            break
    return out
