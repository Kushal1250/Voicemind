# python_services/transcription_service/romanization.py
"""
romanization.py — VoiceMind Multilingual Romanization
Provides ITRANS-style transliteration via indic-transliteration
and integrates with multilingual_normalizer for natural phonetic output.

Used by main.py as a fallback/cross-validation romanization path.
Primary display uses romanize_gujarati() from multilingual_normalizer.
"""

from indic_transliteration import sanscript
from indic_transliteration.sanscript import transliterate


def to_roman(text: str, from_script=sanscript.DEVANAGARI) -> str:
    """
    Transliterates text from a native Indic script to Roman (ITRANS).

    Args:
        text: Input text in Indic script
        from_script: Source script constant (default: DEVANAGARI for Hindi)
                     Use sanscript.GUJARATI for Gujarati input

    Returns:
        ITRANS romanized string, or original text on failure
    """
    if not text or not text.strip():
        return text or ""
    try:
        roman_text = transliterate(text, from_script, sanscript.ITRANS)
        # Post-clean: collapse multiple spaces, strip leading/trailing whitespace
        roman_text = " ".join(roman_text.split()).strip()
        return roman_text if roman_text else text
    except Exception as e:
        print(f"[romanization] Romanization error: {e}")
        return text


def to_roman_iast(text: str, from_script=sanscript.DEVANAGARI) -> str:
    """
    Transliterates to IAST (International Alphabet of Sanskrit Transliteration).
    More scholarly/diacritic-rich than ITRANS. Useful for research output.
    """
    if not text or not text.strip():
        return text or ""
    try:
        return transliterate(text, from_script, sanscript.IAST).strip()
    except Exception as e:
        print(f"[romanization] IAST error: {e}")
        return text


def to_roman_slp1(text: str, from_script=sanscript.DEVANAGARI) -> str:
    """SLP1 transliteration — lossless ASCII encoding for computational use."""
    if not text or not text.strip():
        return text or ""
    try:
        return transliterate(text, from_script, sanscript.SLP1).strip()
    except Exception as e:
        print(f"[romanization] SLP1 error: {e}")
        return text


def process_multilingual_text(text: str, language: str = "hi") -> str:
    """
    Unified entry point for romanization of multilingual text.

    Routing:
    - English ("en") → preserved as-is (no script conversion needed)
    - Gujarati ("gu") → ITRANS romanization from Gujarati script
    - Hindi ("hi") → ITRANS romanization from Devanagari script
    - Any other → attempt Devanagari→ITRANS as best-effort

    This is used in main.py as a cross-validation fallback when
    apply_desired_normalization() returns unchanged text for Indic languages.

    Args:
        text: Input text (may be in native Indic script OR already romanized)
        language: Language code ("en", "gu", "hi", or any)

    Returns:
        Romanized text in ITRANS encoding
    """
    if not text or not text.strip():
        return text or ""

    lang = (language or "").strip().lower()

    if lang == "en":
        # English: preserve exactly — no script conversion
        return text

    if lang == "gu":
        script = sanscript.GUJARATI
    elif lang == "hi":
        script = sanscript.DEVANAGARI
    else:
        # Unknown language: try Devanagari as best-effort
        script = sanscript.DEVANAGARI

    return to_roman(text, from_script=script)


def romanize_gujarati_itrans(text: str) -> str:
    """Convenience: Gujarati → ITRANS. Alias for to_roman(text, GUJARATI)."""
    return to_roman(text, from_script=sanscript.GUJARATI)


def romanize_hindi_itrans(text: str) -> str:
    """Convenience: Hindi Devanagari → ITRANS."""
    return to_roman(text, from_script=sanscript.DEVANAGARI)
