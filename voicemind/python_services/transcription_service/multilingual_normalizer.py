# python_services/transcription_service/multilingual_normalizer.py
"""
VoiceMind Multilingual Normalizer — v6.0
=========================================

CHANGES IN v6.0
-----------------

FIX 1 — LANGUAGE ROUTING IN apply_desired_normalization()
  The old v5.0 code applied Gujarati post-corrections whenever lang was "mixed"
  OR whenever Devanagari was detected in the source. This caused Hindi romanized
  text to be mangled by Gujarati correction tables.
  FIXED: Gujarati post-corrections are applied only for lang="gu" or when the
  text actually contained Gujarati script characters.

FIX 2 — REPETITION CLEANER (stronger)
  Detects and removes "au matra", "ndi ndi", "ૌ ૌ", "। ।" and similar patterns
  that Whisper produces when encountering silence or wrong-language audio.

FIX 3 — ENGLISH CORRECTION EXPANDED
  More grammar fixes for common Indian English patterns:
    "I coming for interview" → "I am coming for an interview"
    "what position you applying for" → "What position are you applying for"
    "I have applied" normalization

FIX 4 — detect_language() RELIABILITY
  Improved scoring: Gujarati markers have higher priority over Hindi markers
  when both appear (mixed → prefer the dominant one if count differs by >2).

Output policy (UNCHANGED):
  - Gujarati speech  → natural Roman Gujarati (no translation)
  - Hindi speech     → natural Roman Hindi    (no translation)
  - English speech   → light grammar fix only
  - Mixed speech     → preserve code-switching
  - NEVER translate, summarize, invent, or drop real words
"""

from __future__ import annotations

import json
import re
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

log = logging.getLogger(__name__)

# ─────────────────────────────────────────────
# Script detectors
# ─────────────────────────────────────────────
_GU_RANGE    = re.compile(r"[઀-૿]")
_HI_RANGE    = re.compile(r"[ऀ-ॿ]")
_LATIN_RANGE = re.compile(r"[A-Za-z]")

GU_DIGITS = str.maketrans("૦૧૨૩૪૫૬૭૮૯", "0123456789")
HI_DIGITS = str.maketrans("०१२३४५६७८९", "0123456789")

# ─────────────────────────────────────────────
# LEXICON LOADING
# ─────────────────────────────────────────────
_RESOURCES_DIR = Path(__file__).parent / "resources"


def _load_lexicon(filename: str) -> Dict[str, str]:
    path = _RESOURCES_DIR / filename
    try:
        if path.exists():
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            log.info(f"[normalizer] Loaded lexicon: {filename} ({len(data)} entries)")
            return {str(k): str(v) for k, v in data.items() if k and v}
    except Exception as e:
        log.warning(f"[normalizer] Could not load {filename}: {e}")
    return {}


_GU_LEXICON: Dict[str, str] = _load_lexicon("gujarati_lexicon.json")
_HI_LEXICON: Dict[str, str] = _load_lexicon("hindi_lexicon.json")


def gujarati_lexicon_status() -> str:
    return f"available ({len(_GU_LEXICON)} entries)" if _GU_LEXICON else "missing"


def hindi_lexicon_status() -> str:
    return f"available ({len(_HI_LEXICON)} entries)" if _HI_LEXICON else "missing"


# ─────────────────────────────────────────────
# GUJARATI PHONETIC TABLES
# ─────────────────────────────────────────────
_GU_VOWELS: Dict[str, str] = {
    "અ": "a", "આ": "aa", "ઇ": "i", "ઈ": "ee", "ઉ": "u",
    "ઊ": "oo", "એ": "e", "ઐ": "ai", "ઓ": "o", "ઔ": "au", "ઋ": "ru",
}
_GU_MATRAS: Dict[str, str] = {
    "ા": "aa", "િ": "i", "ી": "ee", "ુ": "u", "ૂ": "oo",
    "ૃ": "ru", "ે": "e", "ૈ": "ai", "ો": "o", "ૌ": "au",
    "ં": "n", "ઃ": "h", "્": "",
    "\u0ACD": "", "\u0A82": "n", "\u0A83": "h",
}
_GU_CONSONANTS: Dict[str, str] = {
    "ક": "k", "ખ": "kh", "ગ": "g", "ઘ": "gh", "ઙ": "ng",
    "ચ": "ch", "છ": "chh", "જ": "j", "ઝ": "jh", "ઞ": "ny",
    "ટ": "t", "ઠ": "th", "ડ": "d", "ઢ": "dh", "ણ": "n",
    "ત": "t", "થ": "th", "દ": "d", "ધ": "dh", "ન": "n",
    "પ": "p", "ફ": "f", "બ": "b", "ભ": "bh", "મ": "m",
    "ય": "y", "ર": "r", "લ": "l", "ળ": "l", "વ": "v",
    "શ": "sh", "ષ": "sh", "સ": "s", "હ": "h",
    "ક઼": "k", "ખ઼": "kh", "ગ઼": "g", "જ઼": "z",
    "ડ઼": "r", "ઢ઼": "rh", "ફ઼": "f", "ળ઼": "l",
}

# ─────────────────────────────────────────────
# HINDI PHONETIC TABLES
# ─────────────────────────────────────────────
_HI_VOWELS: Dict[str, str] = {
    "अ": "a", "आ": "aa", "इ": "i", "ई": "ee", "उ": "u",
    "ऊ": "oo", "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au", "ऋ": "ri",
}
_HI_MATRAS: Dict[str, str] = {
    "ा": "aa", "ि": "i", "ी": "ee", "ु": "u", "ू": "oo",
    "ृ": "ri", "े": "e", "ै": "ai", "ो": "o", "ौ": "au",
    "ं": "n", "ः": "h", "्": "",
    "\u0902": "n", "\u0903": "h", "\u094D": "", "\u093C": "",
    "\u0901": "n",
}
_HI_CONSONANTS: Dict[str, str] = {
    "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "ng",
    "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "ny",
    "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n",
    "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
    "प": "p", "फ": "f", "ब": "b", "भ": "bh", "म": "m",
    "य": "y", "र": "r", "ल": "l", "व": "v",
    "श": "sh", "ष": "sh", "स": "s", "ह": "h",
    "क़": "q", "ख़": "kh", "ग़": "g", "ज़": "z",
    "ड़": "r", "ढ़": "rh", "फ़": "f", "य़": "y",
}

# ─────────────────────────────────────────────
# ROMANIZED LANGUAGE MARKERS
# ─────────────────────────────────────────────
_ROMAN_GU_MARKERS = re.compile(
    r"\b(mane|mare|tame|tamne|shu|kem|kai|ane|pan|pachi|tamari|"
    r"ketlak|divas|thi|chella|chamdi|khanjvaal|khanjwal|laal|daana|"
    r"khub|sathal|thai|rahya|che|chhe|vaadhe|ochhu|pehla|pachhi|"
    r"lagbhag|besho|samasya|samjayu|navi|koi|sharu|kyare|have|vadhu|"
    r"bijou|potanu|temno|emno|ema|tema|avjo|chalo|bahu|khali|"
    r"Gujarat|Titans|wicket|IPL|boundary|sixer|powerplay|over)\b",
    re.I,
)

_ROMAN_HI_MARKERS = re.compile(
    r"\b(kya|mai|mujhe|andar|sakta|hai|hain|hum|tum|aap|"
    r"karo|kiya|nahin|nahi|bhi|yeh|woh|iska|kaise|kab|"
    r"lagaya|pehle|baad|theek|samajh|batao|bolo|aya|aaya|"
    r"gaya|karta|karti|raha|rahi|tha|se|ne|ko|ka|ki|ke|mein|men)\b",
    re.I,
)

# ─────────────────────────────────────────────
# GUJARATI POST-CORRECTIONS
# ─────────────────────────────────────────────
_GU_POST_CORRECTIONS: Dict[str, str] = {
    # Greetings
    "namaaste": "namaste",

    # Doctor / medical
    "saheba": "saheb", "saaheeba": "saheb", "saheeba": "saheb",
    "daaktara": "doctor", "daakatara": "doctor", "dakra": "doctor",

    # Body / skin
    "chaamajeeba": "chamdi ma", "chamajeeba": "chamdi ma",
    "chaamajeba": "chamdi ma", "chamajeba": "chamdi ma",
    "chaamjeba": "chamdi ma", "chaamjib": "chamdi ma",
    "tngrima": "chamdi ma", "chamdima": "chamdi ma",

    # Itching / rash
    "khnjara": "khanjvaal", "kanjara": "khanjvaal",
    "khnjar": "khanjvaal", "khnjaar": "khanjvaal",
    "kanjaar": "khanjvaal", "khanjara": "khanjvaal",
    "khanjwal": "khanjvaal",

    # Days / time
    "chelaaka": "chella", "chelaak": "chella",
    "chelaka": "chella", "chelak": "chella", "chilla": "chella",
    "digaste": "divas", "digaaste": "divas",
    "divaasta": "divas", "divaas": "divas",
    "ketraaka": "ketlak", "ketraak": "ketlak",

    # khub (very)
    "kabacha": "khub", "kaabacha": "khub", "kaabcha": "khub", "kabcha": "khub",

    # Conjunctions / prepositions
    "aura": "ane", "aur": "ane",
    "men": "ma", "mein": "ma",

    # Common Gujarati verbs
    "laala": "laal",
    "thaai": "thai", "thaaee": "thai", "thaee": "thai", "taaee": "thai", "taai": "thai",
    "raha": "rahya", "raahaa": "rahya",
    "the": "che", "chhe": "che", "cha": "che", "je": "che",

    # sit (besho)
    "byaaso": "besho", "byaasho": "besho", "byaashoo": "besho",
    "byaasoo": "besho", "byaashu": "besho", "byaacho": "besho", "vyaasa": "besho",

    # kaho (say/tell)
    "kaao": "kaho", "kaaoo": "kaho", "kaoo": "kaho",

    # samasya (problem)
    "asamasya": "samasya", "samasyaa": "samasya",

    # kyare (when)
    "kyaare": "kyare", "kyaara": "kyare", "kiyaare": "kyare",

    # sharu (start)
    "shaaroo": "sharu", "shaaru": "sharu", "sharoo": "sharu",
    "shaaro": "sharu", "saroo": "sharu",

    # hati (was)
    "haatee": "hati", "haati": "hati",

    # shu (what)
    "soo": "shu", "shoo": "shu",

    # vadhe/ghate
    "vaade": "vadhe", "gade": "ghate", "gadate": "ghate", "gaadhe": "ghate",

    # lagbhag (approximately)
    "lagabaaka": "lagbhag", "lagabak": "lagbhag", "lagbak": "lagbhag",
    "lagabaak": "lagbhag", "lagabhaag": "lagbhag",

    # pehla (before)
    "pahala": "pehla", "pahla": "pehla", "paahala": "pehla",

    # pan (but/also)
    "pana": "pan", "paan": "pan",

    # have (now)
    "ave": "have", "aave": "have",

    # vadhu (more)
    "vajaare": "vadhu", "vazhare": "vadhu", "vajare": "vadhu",

    # felaai (spread)
    "fela": "felaai", "felaa": "felaai", "phelaa": "felaai",
    "phelaai": "felaai", "felaaee": "felaai",

    # hata (was)
    "haate": "hata", "haata": "hata", "aata": "hata",

    # samjayu (understood)
    "samajhaai": "samjayu", "samajhai": "samjayu",
    "samajhaayi": "samjayu", "samajhaaee": "samjayu",

    # tamne/tame (you)
    "tamane": "tamne", "tamaane": "tamne", "utame": "tame",

    # koi (any/some)
    "koee": "koi",

    # navi (new)
    "navee": "navi", "naavee": "navi",

    # cream / dava
    "krima": "cream", "krim": "cream", "kriima": "cream",
    "daavaana": "dava", "daavan": "dava", "daava": "dava",

    # FIX: Cricket commentary vocabulary
    "viket": "wicket", "vicket": "wicket", "vikket": "wicket",
    "baetsaman": "batsman", "baitsaman": "batsman", "betsaman": "batsman",
    "boler": "bowler", "bollar": "bowler",
    "pavar": "power", "pavarapale": "powerplay", "pavaraplei": "powerplay",
    "ovar": "over", "baundar": "boundary", "boundar": "boundary",
    "siksara": "six", "chhaggo": "chhaggo",   # preserve Gujarati
    "choggo": "choggo",                          # preserve Gujarati
    "rana": "run", "rana bana": "run bana",
    "ampaayar": "umpire", "ampaiyar": "umpire",
    "kamantari": "commentary", "kamanttari": "commentary",
    "aisipial": "IPL", "aipial": "IPL",
    "titwanti": "T20", "titwaanti": "T20",
    # Additional common Gujarati
    "haan": "haa",   # yes
    "nahi": "nahi",  # no - preserve
    "tamari": "tamari",
    "amari": "amari",
    # haa/nahi/
    "haana": "haan", "naahi": "nahi",

    # Additional
    "shahiib": "saheb", "shaaheeba": "saheb",
    "sahi rahya hai chya": "thai rahya che",
    "traaeche": "rahe che",
    "gate chya": "ghate che",
}

_GU_SENTENCE_PATTERNS: List[tuple] = [
    (r"\b(chella)\s+\1\b", r"\1"),
    (r"\b(namaste)\s+\1\b", r"\1"),
    (r"\b(che)\s+\1\b", r"\1"),
    (r"\baur\b", "ane"),
    (r"\baura\b", "ane"),
    (r"\baaa\b", "aa"),
    (r"([aeiou])\1{2,}", r"\1\1"),
    (r"\bsahi\s+rahya\s+hai\s+chya\b", "thai rahya che"),
    (r"\btraaeche\b", "rahe che"),
    (r"\bgate\s+chya\b", "ghate che"),
    (r"\bsaroo\s+thai\b", "sharu thai"),
    # FIX: Gujarati phonetic collapsing — remove unnatural vowel stretching
    # that Whisper produces when it elongates Gujarati vowels
    (r"aa{2,}", "aa"),      # aaaa → aa
    (r"ee{2,}", "ee"),      # eeee → ee
    (r"oo{2,}", "oo"),      # oooo → oo
    (r"ii{2,}", "i"),       # iii → i
    # FIX: Common Gujarati speech phrase normalizations
    (r"\bsu che\b", "shu che"),
    (r"\bshu\s+chhe\b", "shu che"),
    (r"\bkem cho\b", "kem cho"),
    (r"\bmajama\b", "maja ma"),
    (r"\bkevi rite\b", "kevi rite"),
    (r"\bshubh\s+prabhat\b", "shubh prabhat"),
    # Cricket commentary fixes
    (r"\bviket\b", "wicket"),
    (r"\bvicket\b", "wicket"),
    (r"\bbaetsaman\b", "batsman"),
    (r"\bbaitsaman\b", "batsman"),
    (r"\bboler\b", "bowler"),
    (r"\bbollar\b", "bowler"),
    (r"\bchoggo\b", "choggo"),      # preserve Gujarati word for four
    (r"\bchhaggo\b", "chhaggo"),    # preserve Gujarati word for six
]

# ITRANS artifact cleanup
_ITRANS_KNOWN_WORDS: Dict[str, str] = {
    "nAbaste": "namaste", "nabaste": "namaste", "nAmaste": "namaste",
    "DaॉkTara": "doctor", "dAktara": "doctor", "Daktar": "doctor",
    "sAheba": "saheb", "sAheb": "saheb", "saaheb": "saheb",
    "mAM": "ma", "thAi": "thai", "ThAi": "thai",
    "kyAre": "kyare", "shArU": "sharu", "shAru": "sharu",
    "samasyA": "samasya", "dAnA": "daana", "lAla": "laal", "lAl": "laal",
    "chAMdI": "chamdi", "chAmdI": "chamdi", "chAMdIma": "chamdi ma",
    "khuba": "khub", "Khuba": "khub", "kuba": "khub",
    "KhAMjavALa": "khanjvaal", "khaMjavaLa": "khanjvaal",
    "chelAka": "chella", "digaste": "divas",
    "krIma": "cream", "AlarzI": "allergy",
    "InphekShana": "infection", "medikeTed": "medicated",
    "TIka": "theek", "thIka": "theek",
    "daॉktara": "doctor", "kaॉbacha": "khub",
}

_ITRANS_SUFFIX_RULES: List[tuple] = [
    (r"\bsAheba\b", "saheb", re.I),
    (r"\bsaheba\b", "saheb", re.I),
    (r"\bmAM\b", "ma", 0),
    (r"\bthAi\b", "thai", 0),
    (r"\bkyAre\b", "kyare", 0),
    (r"\bshArU\b", "sharu", 0),
    (r"\bsamasyA\b", "samasya", 0),
    (r"\bdAnA\b", "daana", 0),
    (r"\blAla\b", "laal", 0),
    (r"\bnAmaste\b", "namaste", re.I),
    (r"\bDaॉkTara\b", "doctor", 0),
    (r"\bdAktara\b", "doctor", re.I),
    (r"\bkrIma\b", "cream", 0),
    (r"\bKhAMjavALa\b", "khanjvaal", 0),
    (r"\bchAMdI\b", "chamdi", 0),
    (r"\bmedikeTed\b", "medicated", re.I),
    (r"\bInphekShana\b", "infection", 0),
    (r"\bkaॉbacha\b", "khub", 0),
    (r"\bdaॉktara\b", "doctor", 0),
]

_ITRANS_REGEX_PATTERNS: List[tuple] = [
    ("।", ". "),
    (r"\|", ", "),
    (r"[ऀ-ॿ઀-૿]", ""),
    (r"[ॉॅॆ॒॑]", ""),
    (r"(?<=[a-z])A\b", "a"),
    (r"(?<=[a-z])A(?=[a-z])", "aa"),
    (r"\bA(?=[a-z])", "a"),
    (r"(?<=[a-z])I\b", "i"),
    (r"(?<=[a-z])I(?=[a-z])", "ee"),
    (r"(?<=[a-z])U\b", "u"),
    (r"(?<=[a-z])U(?=[a-z])", "oo"),
    (r"M̐", "n"),
    (r"(?<=[a-z])M\b", "n"),
    (r"(?<=[a-z])M(?=[a-z])", "m"),
    (r"([.!?,;])\1+", r"\1"),
    (r"  +", " "),
]

# English grammar fixes
_EN_GRAMMAR: List[tuple] = [
    (r"\bI coming for interview\b", "I am coming for an interview"),
    (r"\bI am coming for interview\b", "I am coming for an interview"),
    (r"\bWhat position you applying for\b", "What position are you applying for"),
    (r"\bwhat position you applying\b", "what position are you applying"),
    (r"\bI apply for\b", "I have applied for"),
    (r"\bI applied for\b", "I have applied for"),
    (r"\babout your self\b", "about yourself"),
    (r"\bproblem solving\b", "problem-solving"),
    (r"\bworking in team\b", "working in a team"),
    (r"\bwork in team\b", "work in a team"),
    (r"\bI have complete\b", "I have completed"),
    (r"\bI complete\b", "I have completed"),
    (r"\bI working\b", "I am working"),
    (r"\bI done\b", "I have done"),
    (r"\bplease sit down\b", "Please sit down"),
    (r"\bgood morning sir\b", "Good morning, sir"),
]

_BAD_PATTERNS = [
    r"gujarati speech detected", r"possible interpretation",
    r"this appears to be", r"the speaker says", r"do not summarize",
    r"return only", r"multi.?speaker meeting", r"preserve speaker changes",
    r"automatic multilingual meeting decoding", r"translate the following",
    r"render hindi words", r"transcribe in gujarati",
]

# Repetition cleanup — handles hallucinated sequences
_REPETITION_CLEANUP = re.compile(r"(\b\w{2,}\b)(\s+\1){2,}", re.I)
_MATRA_REPEAT       = re.compile(r"([ૌૈૉ઼ া্ো])\s+\1")
_DANDA_REPEAT       = re.compile(r"।\s+।")
_AU_MATRA           = re.compile(r"\bau\s+matra\b", re.I)
_NDI_REPEAT         = re.compile(r"\bndi\s+ndi\b", re.I)


# ─────────────────────────────────────────────
# UTILITIES
# ─────────────────────────────────────────────
def _squash(text: str) -> str:
    text = str(text or "").translate(GU_DIGITS).translate(HI_DIGITS)
    text = re.sub(r"\s+([,.;:!?।])", r"\1", text)
    text = re.sub(r"([,.;:!?।])([^\s])", r"\1 \2", text)
    return re.sub(r"\s+", " ", text).strip()


def is_placeholder_text(text: str) -> bool:
    normalized = _squash(text).lower()
    if not normalized:
        return False
    return any(re.search(p, normalized) for p in _BAD_PATTERNS)


def _remove_hallucinated_repetitions(text: str) -> str:
    """
    Remove Whisper hallucination patterns:
      - "to to to nekhon nekhon nekhon"
      - "au matra"
      - "ndi ndi"
      - "ૌ ૌ" (Gujarati matra repeats)
      - "। ।" (danda repeats)
    """
    cleaned = _REPETITION_CLEANUP.sub(r"\1", text)
    cleaned = re.sub(r"(\b\w{2,}\s+\w{2,}\b)(\s+\1)+", r"\1", cleaned, flags=re.I)
    cleaned = _MATRA_REPEAT.sub("", cleaned)
    cleaned = _DANDA_REPEAT.sub(". ", cleaned)
    cleaned = _AU_MATRA.sub("", cleaned)
    cleaned = _NDI_REPEAT.sub("", cleaned)
    return _squash(cleaned)


# ─────────────────────────────────────────────
# LANGUAGE DETECTION (v6.0: improved scoring)
# ─────────────────────────────────────────────
def detect_language(text: str) -> str:
    """
    Detect: gu / hi / en / mixed.
    v6.0: Improved — Gujarati markers take priority when count > Hindi markers.
    """
    text = str(text or "")
    gu_script = len(_GU_RANGE.findall(text))
    hi_script = len(_HI_RANGE.findall(text))
    la        = len(_LATIN_RANGE.findall(text))

    # Native script detection
    if gu_script > 0 and hi_script > 0:
        # If one dominates by 3x, return that language
        if gu_script > hi_script * 3:
            return "gu"
        if hi_script > gu_script * 3:
            return "hi"
        return "mixed"
    if gu_script >= max(2, la // 3):
        return "gu"
    if hi_script >= max(2, la // 3):
        return "hi"

    # Romanized text — check word markers
    if la >= 2:
        gu_hits = len(_ROMAN_GU_MARKERS.findall(text))
        hi_hits = len(_ROMAN_HI_MARKERS.findall(text))

        if gu_hits > 0 and hi_hits > 0:
            # v6.0: prefer the dominant one if difference > 2
            if abs(gu_hits - hi_hits) > 2:
                return "gu" if gu_hits > hi_hits else "hi"
            return "mixed"
        if gu_hits > 0:
            return "gu"
        if hi_hits > 0:
            return "hi"
        return "en"
    return "en"


# ─────────────────────────────────────────────
# PHONETIC ROMANIZATION ENGINE
# ─────────────────────────────────────────────
def _phonetic_romanize_token(
    token: str,
    consonants: Dict[str, str],
    matras: Dict[str, str],
    vowels: Dict[str, str],
) -> str:
    out: List[str] = []
    chars = list(token)
    i = 0
    while i < len(chars):
        c = chars[i]
        if c in vowels:
            out.append(vowels[c])
            i += 1
            continue
        if c in consonants:
            base = consonants[c]
            nxt  = chars[i + 1] if i + 1 < len(chars) else ""
            if nxt in matras:
                matra_val = matras[nxt]
                out.append(base if matra_val == "" else base + matra_val)
                i += 2
            elif nxt in consonants or nxt in vowels:
                out.append(base + "a")
                i += 1
            else:
                out.append(base + "a")
                i += 1
            continue
        if c in matras:
            out.append(matras[c])
            i += 1
            continue
        out.append(c)
        i += 1

    value = "".join(out)
    value = re.sub(r"aa\b", "a", value)
    value = re.sub(r"([aeiou])\1{2,}", r"\1\1", value)
    return value


def romanize_gujarati(text: str) -> str:
    text = _squash(text)
    if not text:
        return ""
    pieces = re.findall(
        r"[઀-૿\u0ACD\u0A82\u0A83]+|[A-Za-z0-9@#%&._+\-/]+|[^\w\s]|\s+",
        text, flags=re.UNICODE,
    )
    result = []
    for p in pieces:
        if not _GU_RANGE.search(p):
            result.append(p)
            continue
        if p in _GU_LEXICON:
            result.append(_GU_LEXICON[p])
        else:
            result.append(_phonetic_romanize_token(p, _GU_CONSONANTS, _GU_MATRAS, _GU_VOWELS))
    return _squash("".join(result))


def romanize_hindi(text: str) -> str:
    text = _squash(text)
    if not text:
        return ""
    pieces = re.findall(
        r"[ऀ-ॿ\u0902\u0903\u094D\u093C\u0901]+|[A-Za-z0-9@#%&._+\-/]+|[^\w\s]|\s+",
        text, flags=re.UNICODE,
    )
    result = []
    for p in pieces:
        if not _HI_RANGE.search(p):
            result.append(p)
            continue
        if p in _HI_LEXICON:
            result.append(_HI_LEXICON[p])
        else:
            result.append(_phonetic_romanize_token(p, _HI_CONSONANTS, _HI_MATRAS, _HI_VOWELS))
    return _squash("".join(result))


# ─────────────────────────────────────────────
# GUJARATI POST-CORRECTIONS
# ─────────────────────────────────────────────
def apply_gujarati_post_corrections(text: str) -> str:
    """
    Apply word-level and sentence-level corrections to romanized Gujarati text.
    ONLY call this when lang is "gu" or source had Gujarati script characters.
    Do NOT apply to Hindi or English output.
    """
    if not text:
        return text

    text = _remove_hallucinated_repetitions(text)

    words     = text.split()
    corrected = []
    for w in words:
        m = re.match(r"^([^a-zA-Z0-9]*)(.*?)([^a-zA-Z0-9]*)$", w)
        pre, core, suf = (m.group(1), m.group(2), m.group(3)) if m else ("", w, "")
        core_lower = core.lower()
        if core_lower in _GU_POST_CORRECTIONS:
            corrected.append(pre + _GU_POST_CORRECTIONS[core_lower] + suf)
        else:
            corrected.append(w)
    text = " ".join(corrected)

    for pattern, replacement in _GU_SENTENCE_PATTERNS:
        text = re.sub(pattern, replacement, text, flags=re.I)

    return _squash(text)


# ─────────────────────────────────────────────
# CLEAN ROMAN OUTPUT
# ─────────────────────────────────────────────
def clean_roman_output(text: str) -> str:
    """Strip ITRANS artifacts and mixed-script garbage from Roman text."""
    if not text:
        return ""

    # FIX v18: Remove all Unicode replacement characters
    text = text.replace("\ufffd", "").replace("\u0000", "")
    # Remove any remaining native script characters in Roman output mode
    text = re.sub(r"[ऀ-ॿ઀-૿]", "", text)
    text = re.sub(r"[ॉॅॆ॒॑]", "", text)
    text = text.replace("।", ". ").replace("|", ", ")

    words   = text.split()
    cleaned = []
    for w in words:
        m = re.match(r"^([^a-zA-Z0-9]*)(.*?)([^a-zA-Z0-9]*)$", w)
        pre, core, suf = (m.group(1), m.group(2), m.group(3)) if m else ("", w, "")
        replaced = _ITRANS_KNOWN_WORDS.get(core, core)
        cleaned.append(pre + replaced + suf)
    text = " ".join(cleaned)

    for pattern, replacement, flags in _ITRANS_SUFFIX_RULES:
        text = re.sub(pattern, replacement, text, flags=flags)

    for pattern, replacement in _ITRANS_REGEX_PATTERNS:
        text = re.sub(pattern, replacement, text)

    # Preserve known terms
    text = re.sub(r"\bUPI\b",       "UPI",       text, flags=re.I)
    text = re.sub(r"\bSMS\b",       "SMS",       text, flags=re.I)
    text = re.sub(r"\bOTP\b",       "OTP",       text, flags=re.I)
    text = re.sub(r"\bATM\b",       "ATM",       text)
    text = re.sub(r"\bID\b",        "ID",        text)
    text = re.sub(r"\bAI\b",        "AI",        text)
    text = re.sub(r"\bAPI\b",       "API",       text)
    text = re.sub(r"\bVoice\s*Mind\b", "VoiceMind", text, flags=re.I)

    return _squash(text)


def normalize_roman_mixed(text: str) -> str:
    text = _squash(text)
    if not text:
        return ""
    return clean_roman_output(text)


def clean_english_text(text: str) -> str:
    text = _squash(text)
    if not text:
        return ""
    for pattern, repl in _EN_GRAMMAR:
        text = re.sub(pattern, repl, text, flags=re.I)
    return _squash(text)


# ─────────────────────────────────────────────
# HINDI POST-CORRECTIONS (light cleanup for Devanagari output)
# ─────────────────────────────────────────────
def _apply_hindi_corrections(text: str) -> str:
    """
    Light post-corrections for Hindi Devanagari text.
    Preserves native script — only fixes spacing and digit normalization.
    """
    text = text.translate(HI_DIGITS)
    # Fix common spacing issues around Devanagari punctuation
    text = re.sub(r"\s+।", "।", text)
    text = re.sub(r"।\s*।", "।", text)
    text = re.sub(r"\s{2,}", " ", text)
    return text.strip()


# ─────────────────────────────────────────────
# MASTER NORMALIZATION (v13.0 — language-aware routing)
# ─────────────────────────────────────────────
def apply_desired_normalization(text: str, language: Optional[str] = None) -> str:
    """
    Normalize text with script-aware routing (v13.0).

    OUTPUT_SCRIPT_MODE controls output format:
      - "preserve" (default): keep native Gujarati/Hindi/English scripts
      - "romanize": romanize Gujarati → Latin; preserve Hindi Devanagari; English as-is

    Language routing (v13.0):
      - gu + romanize → _gujarati_to_roman()
      - gu + preserve → preserve native Gujarati script
      - hi → preserve Devanagari (never romanize Hindi unless explicitly asked)
      - en → English grammar corrections only
      - auto/mixed → route by dominant script
    """
    import os
    script_mode = os.getenv("OUTPUT_SCRIPT_MODE", "preserve").strip().lower()
    # Support both "romanize" and legacy "romanized" spelling
    is_romanize = script_mode in ("romanize", "romanized")

    text = _squash(text)
    text = text.replace("\ufffd", "")
    if not text or is_placeholder_text(text):
        return ""

    lang = (language or detect_language(text) or "en").lower().replace("mixed-", "")

    # Step 1: Remove hallucinated repetitions (always)
    text = _remove_hallucinated_repetitions(text)
    if not text:
        return ""

    gu_chars = len(re.findall(r"[઀-૿]", text))
    hi_chars = len(re.findall(r"[ऀ-ॿ]", text))

    # ── GUJARATI ─────────────────────────────────────────────────────────
    if lang == "gu" or (lang == "auto" and gu_chars > hi_chars and gu_chars > 0):
        text = text.translate(GU_DIGITS)
        if is_romanize:
            if gu_chars > 0:
                # Has Gujarati script — romanize directly
                text = romanize_gujarati(text)
                text = apply_gujarati_post_corrections(text)
                text = clean_roman_output(text)
            elif hi_chars > 0:
                # v17 FIX: Language tagged as gu but has Devanagari (Hindi) script
                # This happens when Whisper outputs Hindi for Gujarati speech.
                # Romanize via Hindi romanizer then apply Gujarati corrections.
                text = romanize_hindi(text)
                text = apply_gujarati_post_corrections(text)
                text = clean_roman_output(text)
            else:
                # FIX v18: Already Roman/English (code-switched cricket commentary)
                # For gu sessions with English output, just clean it up — don't mangle
                text = clean_roman_output(text)
        # Remove Unicode replacement character
        text = text.replace("\ufffd", "").replace("?", " ").strip()
        text = re.sub(r"\s{2,}", " ", text).strip()
        log.debug(f"[normalizer:gu] mode={script_mode} preview={text[:80]}")
        return _squash(text)

    # ── HINDI ─────────────────────────────────────────────────────────────
    if lang == "hi" or (lang == "auto" and hi_chars > gu_chars and hi_chars > 0):
        text = text.translate(HI_DIGITS)
        if is_romanize and hi_chars > 0:
            # v17 FIX: Romanize Hindi Devanagari to Roman Hindi
            text = romanize_hindi(text)
            text = clean_roman_output(text)
        else:
            # preserve Devanagari — apply corrections only
            text = _apply_hindi_corrections(text)
        # Remove Unicode replacement character
        text = text.replace("\ufffd", "").strip()
        log.debug(f"[normalizer:hi] preview={text[:80]}")
        return _squash(text)

    # ── ENGLISH ───────────────────────────────────────────────────────────
    if lang == "en" and hi_chars == 0 and gu_chars == 0:
        text = clean_english_text(text)
        log.debug(f"[normalizer:en] preview={text[:80]}")
        return _squash(text)

    # ── MIXED / AUTO ─────────────────────────────────────────────────────
    had_gujarati   = gu_chars > 0
    had_devanagari = hi_chars > 0

    if had_gujarati:
        text = text.translate(GU_DIGITS)
        if is_romanize:
            text = romanize_gujarati(text)
            text = apply_gujarati_post_corrections(text)

    if had_devanagari:
        text = text.translate(HI_DIGITS)
        if is_romanize and had_gujarati:
            # Only romanize Hindi in mixed mode if Gujarati already romanized
            text = romanize_hindi(text)
        # else: preserve Devanagari in Hindi-dominant or preserve mode

    if is_romanize and (had_gujarati or had_devanagari):
        text = clean_roman_output(text)

    log.debug(f"[normalizer:mixed] lang={lang} mode={script_mode} preview={text[:80]}")
    return _squash(text)


# ─────────────────────────────────────────────
# PUBLIC API (backward compatible)
# ─────────────────────────────────────────────
def clean_transcript_text(text: str, preserveRepeats: bool = False) -> str:
    return apply_desired_normalization(text)


def normalize_segment_text(
    source_text: str, language: Optional[str] = None
) -> Dict[str, Any]:
    detected   = detect_language(source_text)
    normalized = apply_desired_normalization(source_text, language or detected)
    return {
        "normalizedText":  normalized,
        "detectedLanguage": detected,
        "method":          f"normalized_{language or detected}",
        "valid":           bool(normalized),
        "sourceText":      source_text,
        "confidence":      "high" if normalized else "low",
    }


def normalize_segments_batch(segments: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    result = []
    for seg in segments or []:
        source = (
            seg.get("sourceText") or seg.get("text")
            or seg.get("rawSourceText") or ""
        )
        lang = (
            seg.get("language") or seg.get("sourceLanguage")
            or detect_language(source)
        )
        norm    = normalize_segment_text(source, lang)
        updated = dict(seg)
        updated["sourceText"]          = source
        updated["normalizedText"]      = norm["normalizedText"]
        updated["displayText"]         = norm["normalizedText"]
        updated["finalValidatedText"]  = norm["normalizedText"]
        updated["detectedLanguage"]    = norm["detectedLanguage"]
        result.append(updated)
    return result


def build_structured_conversation(grouped_turns: List[Dict[str, Any]]) -> str:
    lines = []
    for turn in grouped_turns or []:
        speaker = str(turn.get("speaker") or "Speaker 1").strip()
        text    = turn.get("displayText") or turn.get("text") or turn.get("sourceText") or ""
        text    = _squash(text)
        if speaker and text:
            lines.append(f"{speaker}: {text}")
    return "\n\n".join(lines)


def translate_hindi_to_english(text: str) -> str:
    """Legacy alias — returns romanized Hindi, NOT English translation."""
    return apply_desired_normalization(text, "hi")