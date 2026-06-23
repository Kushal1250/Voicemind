"""
classifier.py — VoiceMind QA Service v9.0
==========================================
Question classification → 10 categories → specialized prompt templates.

Categories
----------
1.  speaker_identification   — "Who said X?" / "Which speaker spoke Gujarati?"
2.  translation              — "Translate X" / "What does X mean?"
3.  entity_extraction        — "List all names / companies / projects"
4.  personal_information     — "What is Kushal studying?" / "What is Suketu's role?"
5.  timeline_question        — "When did X happen?" / "How long was the meeting?"
6.  summary                  — "Summarize" / "Give me an overview"
7.  meeting_notes            — "Meeting notes" / "Action items"
8.  language_detection       — "Who spoke Gujarati?" / "List Gujarati sentences"
9.  organization_detection   — "What company was mentioned?"
10. general_qa               — everything else
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple

# ─── Category constants ───────────────────────────────────────────────────────

SPEAKER_IDENTIFICATION = "speaker_identification"
TRANSLATION            = "translation"
ENTITY_EXTRACTION      = "entity_extraction"
PERSONAL_INFORMATION   = "personal_information"
TIMELINE_QUESTION      = "timeline_question"
SUMMARY                = "summary"
MEETING_NOTES          = "meeting_notes"
LANGUAGE_DETECTION     = "language_detection"
ORGANIZATION_DETECTION = "organization_detection"
GENERAL_QA             = "general_qa"

# ─── Classification patterns ─────────────────────────────────────────────────

_PATTERNS: List[Tuple[str, re.Pattern]] = [
    # Speaker identification with non-ASCII quote (must come BEFORE translation)
    # e.g. 'Who said "મારું નામ સુકેતુ પટેલ છે"?'
    (SPEAKER_IDENTIFICATION, re.compile(
        r"\b(who said|who spoke|who mentioned|who introduced|who asked|who answered"
        r"|which speaker said|identify speaker)\b.{0,80}[^\x00-\x7F]",
        re.I,
    )),
    # Translation: explicit translate keywords OR standalone non-ASCII phrase
    (TRANSLATION, re.compile(
        r"\b(translate|translation|what does .{1,50} mean|meaning of|"
        r"what is the meaning|in english|interpret)\b",
        re.I,
    )),
    # Language detection
    (LANGUAGE_DETECTION, re.compile(
        r"\b(gujarati|hindi|english|language|multilingual|"
        r"spoke in|spoken in|script|list .{0,30}sentences|"
        r"gujarati sentences|hindi sentences|non-english|"
        r"how many languages|which language)\b",
        re.I,
    )),
    # Speaker identification
    (SPEAKER_IDENTIFICATION, re.compile(
        r"\b(who said|who spoke|who mentioned|who introduced|who was speaking|"
        r"which speaker|speaker \d+|who is speaker|identify the speaker|"
        r"who talked about|whose voice|who used|who narrated|who asked|who answered)\b",
        re.I,
    )),
    # Personal information
    (PERSONAL_INFORMATION, re.compile(
        r"\b(studying|studied|major|degree|education|university|college|"
        r"role|position|job|title|profession|background|expertise|"
        r"working on|works on|project by|age|year|batch|semester|"
        r"who is [A-Z][a-z]+|what does [A-Z][a-z]+ do|"
        r"tell me about [A-Z][a-z]+)\b",
        re.I,
    )),
    # Organization detection
    (ORGANIZATION_DETECTION, re.compile(
        r"\b(company|organization|organisation|startup|firm|enterprise|"
        r"institution|university|college|school|corp|inc|ltd|pvt|"
        r"what (?:company|org)|which company|which organization|"
        r"employer|employer|brand|product)\b",
        re.I,
    )),
    # Entity extraction
    (ENTITY_EXTRACTION, re.compile(
        r"\b(list all|extract|all names|all speakers|participants|"
        r"list.*(?:names?|speakers?|people|persons?|places?|locations?|"
        r"projects?|companies|technologies|tools)|"
        r"who (?:are|were) (?:the )?(?:participants|speakers|people|attendees))\b",
        re.I,
    )),
    # Timeline
    (TIMELINE_QUESTION, re.compile(
        r"\b(when|how long|duration|start time|end time|at what time|"
        r"timestamp|time of|first|last|earliest|latest|before|after|"
        r"sequence|order|beginning|ending|start|finish)\b",
        re.I,
    )),
    # Meeting notes
    (MEETING_NOTES, re.compile(
        r"\b(meeting notes|action items|follow.?ups|decisions|"
        r"next steps|to.?do|todos|deliverables|outcomes|"
        r"minutes of the meeting|mom|agenda|takeaways)\b",
        re.I,
    )),
    # Summary
    (SUMMARY, re.compile(
        r"\b(summarize|summary|summarise|overview|brief|recap|"
        r"what was discussed|what happened|main points|key points|"
        r"executive summary|tl;dr|tldr|gist|highlight)\b",
        re.I,
    )),
]


def classify_question(question: str) -> str:
    """Return one of the 10 question category constants."""
    q = str(question or "").strip()
    for category, pattern in _PATTERNS:
        if pattern.search(q):
            return category
    return GENERAL_QA


# ─── Prompt templates ─────────────────────────────────────────────────────────

_BASE_RULE = (
    "You are a transcript QA assistant for a multilingual meeting system. "
    "You must ONLY answer from the provided transcript evidence. "
    "NEVER invent, guess, or hallucinate facts. "
    "If the answer is not in the evidence, respond exactly: 'Not found in transcript.' "
    "The transcript may contain English, Gujarati (ગુજરાતી), or Hindi (हिंदी). "
    "Preserve non-Latin script exactly as it appears. "
)

_FORMAT_RULE = (
    "Format your answer as:\n"
    "Answer: <direct answer>\n"
    "Evidence: <exact quote from transcript with speaker and timestamp>\n"
    "Speaker: <speaker label(s)>\n"
    "Timestamp: <HH:MM:SS>\n"
)

PROMPT_TEMPLATES: Dict[str, str] = {
    SPEAKER_IDENTIFICATION: (
        _BASE_RULE
        + "TASK: Identify exactly WHICH SPEAKER(S) said the content in the question. "
        + "Look at speaker labels in [HH:MM:SS-HH:MM:SS] SpeakerN: format. "
        + "List ALL speakers who match — do not stop at the first one. "
        + _FORMAT_RULE
    ),
    TRANSLATION: (
        _BASE_RULE
        + "TASK: Translate or explain the phrase/sentence. "
        + "If the phrase is in Gujarati or Hindi, provide the English translation. "
        + "Also identify WHICH SPEAKER used this phrase and at what timestamp. "
        + "If a direct translation is obvious, give it even without full transcript evidence. "
        + "Format: Answer: <translation>\nSpeaker: <who said it>\nTimestamp: <when>"
    ),
    ENTITY_EXTRACTION: (
        _BASE_RULE
        + "TASK: Extract ALL matching entities from the transcript evidence. "
        + "Be thorough — scan every line. "
        + "List each entity on a new line with the speaker and timestamp where it appears. "
        + "Format:\nEntity type:\n- EntityName (Speaker N, HH:MM:SS)\n"
    ),
    PERSONAL_INFORMATION: (
        _BASE_RULE
        + "TASK: Find personal information about the person mentioned. "
        + "Look for education, role, project, university, company, background details. "
        + "Quote the exact transcript segment as evidence. "
        + _FORMAT_RULE
    ),
    TIMELINE_QUESTION: (
        _BASE_RULE
        + "TASK: Answer a time-based question using transcript timestamps. "
        + "Timestamps are in [HH:MM:SS-HH:MM:SS] format before each segment. "
        + "Be precise with the timestamps you find. "
        + _FORMAT_RULE
    ),
    SUMMARY: (
        _BASE_RULE
        + "TASK: Produce a meeting summary that draws on the FULL transcript — beginning, "
        + "middle, and end — not just the opening lines. Cover, where relevant: an overview, "
        + "key discussion points (with speakers), notable speaker or language changes (e.g. "
        + "code-switching between English/Gujarati/Hindi) if they matter to the discussion, "
        + "participants, decisions made, and action items if present. "
        + "Choose a format that fits the requested length: a short word-limited summary should "
        + "be tight flowing prose; a longer or unconstrained summary may use numbered/bulleted "
        + "sections. Never sacrifice transcript coverage just to fill out a section template. "
        + "Do NOT open with a stock phrase such as 'The transcript captures' or 'This meeting "
        + "discusses' — vary your wording each time. Do NOT repeat the same sentence or "
        + "paragraph multiple times, and do not pad with filler."
    ),
    MEETING_NOTES: (
        _BASE_RULE
        + "TASK: Generate formal meeting notes using the FULL transcript, not just the opening "
        + "lines. Sections: Attendees, Agenda, Discussion Points, Decisions, Action Items, Next "
        + "Steps. Attribute each point to the correct speaker, and note any meaningful speaker "
        + "or language changes. "
        + "Use evidence spread across the whole conversation. Do NOT repeat content or open "
        + "with the same boilerplate phrase every time."
    ),
    LANGUAGE_DETECTION: (
        _BASE_RULE
        + "TASK: Analyze language usage in the transcript. "
        + "Identify: which speaker(s) spoke Gujarati, which spoke Hindi, which spoke English. "
        + "List ALL Gujarati sentences with their speaker and timestamp. "
        + "List ALL Hindi sentences with their speaker and timestamp. "
        + "Provide a language breakdown: English %, Gujarati %, Hindi %. "
        + "Format:\nGujarati Speakers: ...\nHindi Speakers: ...\nGujarati Sentences:\n- ...\n"
    ),
    ORGANIZATION_DETECTION: (
        _BASE_RULE
        + "TASK: Identify ALL organizations, companies, universities, or institutions mentioned. "
        + "For each, provide the context and speaker. "
        + "Format:\nOrganization: <name>\nContext: <what was said>\nSpeaker: <who mentioned it>\nTimestamp: <when>"
    ),
    GENERAL_QA: (
        _BASE_RULE
        + "TASK: Answer the question using only the transcript evidence. "
        + "Be direct and specific. "
        + _FORMAT_RULE
    ),
}


def get_prompt(question: str) -> Tuple[str, str]:
    """Return (category, system_prompt) for this question."""
    category = classify_question(question)
    prompt = PROMPT_TEMPLATES.get(category, PROMPT_TEMPLATES[GENERAL_QA])
    return category, prompt


# ─── Explicit length requests ("...in 200 words", "2000-word summary") ───────
#
# ROOT-CAUSE FIX: previously nothing in the pipeline ever looked for a
# requested word count, so "summarize in 200 words" and "summarize in 2000
# words" produced the same answer, truncated to whatever QA_MAX_LLM_TOKENS
# happened to be (default as low as ~500 tokens — nowhere near 2000 words).

_WORD_TARGET_RE = re.compile(r"(\d{1,5})\s*[- ]?\s*words?\b", re.I)


def extract_word_target(question: str) -> Optional[int]:
    """
    Parse an explicit word-count request from the question, e.g.
    "summarize in 200 words", "200-word summary", "in 2000 words".
    Returns None if no explicit count is found. Clamped to a sane range so
    a typo or adversarial input can't request an unbounded generation.
    """
    match = _WORD_TARGET_RE.search(str(question or ""))
    if not match:
        return None
    try:
        value = int(match.group(1))
    except (TypeError, ValueError):
        return None
    if value <= 0:
        return None
    return max(10, min(value, 3000))


def build_length_instruction(word_target: Optional[int]) -> str:
    """Build a system-prompt addendum enforcing the requested word count."""
    if not word_target:
        return ""
    tolerance = max(8, round(word_target * 0.12))
    lo, hi = max(5, word_target - tolerance), word_target + tolerance
    return (
        f"LENGTH REQUIREMENT: Write the answer at approximately {word_target} words "
        f"(acceptable range: {lo}-{hi} words). Draw evidence from across the FULL "
        f"transcript, not just the opening lines. A shorter target should be a tight, "
        f"high-level synthesis; a longer target should cover more discussion points and "
        f"more supporting detail pulled from across the whole conversation — do not "
        f"reach the target by padding with repetition or filler, and do not stop short "
        f"of it. Vary your opening sentence — never start with a stock phrase such as "
        f"'The transcript captures' or 'This meeting discusses'."
    )
