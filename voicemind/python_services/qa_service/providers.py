"""
providers.py — VoiceMind QA Service v9.0
=========================================
BaseLLMProvider + GeminiProvider + QwenProvider

Provider order:  Gemini (primary)  →  Qwen/Ollama (fallback)
No LM Studio. No other providers.
"""

from __future__ import annotations

import os
import re
import time
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional

import requests
from google import genai
from google.genai import types as genai_types

# ─── Configuration ────────────────────────────────────────────────────────────

GOOGLE_API_KEY   = os.getenv("GOOGLE_API_KEY", "AQ.Ab8RN6LDUM4cnAkQDJnCz2nEZsuBLIWDpRw787TVLj1ud18PyQ").strip()
GEMINI_MODEL     = os.getenv("GEMINI_MODEL", "gemini-2.5-flash").strip()
GEMINI_TIMEOUT   = int(os.getenv("GEMINI_TIMEOUT", "30"))

OLLAMA_BASE_URL      = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434").rstrip("/")
QWEN_MODEL           = os.getenv("QWEN_MODEL", "qwen2.5:latest").strip()
OLLAMA_TIMEOUT       = int(os.getenv("OLLAMA_TIMEOUT", "120"))
OLLAMA_TEMPERATURE   = float(os.getenv("OLLAMA_TEMPERATURE", "0.05"))
OLLAMA_NUM_CTX       = int(os.getenv("OLLAMA_NUM_CTX", "32000"))
OLLAMA_REPEAT_PENALTY = float(os.getenv("OLLAMA_REPEAT_PENALTY", "1.1"))

QA_MAX_LLM_TOKENS = int(os.getenv("QA_MAX_LLM_TOKENS", "1000"))
QA_PRIMARY_PROVIDER = os.getenv("QA_PRIMARY_PROVIDER", "gemini").strip().lower()

DEBUG = os.getenv("DEBUG", "false").strip().lower() in {"1", "true", "yes", "on"}


def _debug(tag: str, **kwargs: Any) -> None:
    if DEBUG:
        print(f"[provider:{tag}]", kwargs or "")


# ─── Base class ───────────────────────────────────────────────────────────────

class BaseLLMProvider(ABC):
    """Abstract base for all LLM providers."""

    name: str = "base"

    @abstractmethod
    def answer_question(
        self,
        question: str,
        context_block: str,
        system_prompt: str,
        max_tokens: int = QA_MAX_LLM_TOKENS,
    ) -> Optional[str]:
        """Answer a question from transcript context. Returns None on failure."""
        ...

    @abstractmethod
    def summarize(self, transcript_text: str, max_tokens: int = 1500) -> Optional[str]:
        """Generate a meeting summary from full transcript text."""
        ...

    @abstractmethod
    def extract_entities(self, transcript_text: str) -> Optional[str]:
        """Extract named entities from transcript text."""
        ...

    @abstractmethod
    def generate_notes(self, transcript_text: str) -> Optional[str]:
        """Generate structured meeting notes."""
        ...

    @abstractmethod
    def is_available(self) -> bool:
        """Return True if provider is configured and reachable."""
        ...

    def _is_weak_refusal(self, text: str) -> bool:
        REFUSAL_PATTERNS = re.compile(
            r"(transcript does not contain|not enough information|insufficient information"
            r"|i (cannot|can't) (identify|find|determine)|no information available"
            r"|information is not (available|present)|not mentioned in the transcript"
            r"|no .{0,40} found in the transcript)",
            re.I,
        )
        return bool(REFUSAL_PATTERNS.search(text or ""))


# ─── Gemini Provider ──────────────────────────────────────────────────────────

class GeminiProvider(BaseLLMProvider):
    name = "gemini"

    def __init__(self) -> None:
        self._client: Optional[genai.Client] = None
        if GOOGLE_API_KEY:
            try:
                self._client = genai.Client(
                    api_key=GOOGLE_API_KEY,
                    http_options=genai_types.HttpOptions(timeout=GEMINI_TIMEOUT * 1000),
                )
            except Exception as exc:
                _debug("gemini_init_failed", error=str(exc))

    def is_available(self) -> bool:
        return self._client is not None

    def _call(
        self,
        user_prompt: str,
        system_instruction: str,
        max_tokens: int,
        temperature: float = 0.05,
    ) -> Optional[str]:
        if not self._client:
            return None
        try:
            response = self._client.models.generate_content(
                model=GEMINI_MODEL,
                contents=user_prompt,
                config=genai_types.GenerateContentConfig(
                    system_instruction=system_instruction,
                    temperature=temperature,
                    max_output_tokens=max_tokens,
                ),
            )
            result = (response.text or "").strip()
            _debug("gemini_ok", chars=len(result))
            # Reject obviously empty or refusal-only results
            if not result or len(result) < 6:
                _debug("gemini_empty_result")
                return None
            return result
        except Exception as exc:
            # Log server-side only; never propagate exception text to client
            _debug("gemini_failed", error=str(exc))
            return None

    def answer_question(
        self,
        question: str,
        context_block: str,
        system_prompt: str,
        max_tokens: int = QA_MAX_LLM_TOKENS,
    ) -> Optional[str]:
        user_prompt = f"QUESTION:\n{question}\n\nTRANSCRIPT EVIDENCE:\n{context_block}"
        return self._call(user_prompt, system_prompt, max_tokens)

    def summarize(self, transcript_text: str, max_tokens: int = 1500) -> Optional[str]:
        system = (
            "You are an expert meeting summarization assistant. "
            "Produce a concise, structured summary of the transcript. "
            "Include: overview, key points, participants, decisions, action items. "
            "Preserve Gujarati, Hindi, and English content accurately."
        )
        user = f"Summarize this meeting transcript:\n\n{transcript_text}"
        return self._call(user, system, max_tokens, temperature=0.1)

    def extract_entities(self, transcript_text: str) -> Optional[str]:
        system = (
            "You are a named-entity extraction engine. "
            "Extract all people, organizations, locations, and projects from the transcript. "
            "Respond in JSON format: {{\"people\": [], \"organizations\": [], \"locations\": [], \"projects\": []}}"
        )
        user = f"Extract named entities:\n\n{transcript_text}"
        return self._call(user, system, 800)

    def generate_notes(self, transcript_text: str) -> Optional[str]:
        system = (
            "Generate detailed meeting notes from this transcript. "
            "Include speaker-specific points, technical terms, and follow-up items."
        )
        user = f"Generate notes:\n\n{transcript_text}"
        return self._call(user, system, 1500, temperature=0.1)

    def health(self) -> Dict[str, Any]:
        return {
            "configured": bool(GOOGLE_API_KEY),
            "available": self.is_available(),
            "model": GEMINI_MODEL,
        }


# ─── Qwen/Ollama Provider ─────────────────────────────────────────────────────

class QwenProvider(BaseLLMProvider):
    name = "qwen"

    def _post_chat(self, system: str, user: str, max_tokens: int = QA_MAX_LLM_TOKENS) -> Optional[str]:
        payload = {
            "model": QWEN_MODEL,
            "stream": False,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "options": {
                "temperature": OLLAMA_TEMPERATURE,
                "num_ctx": OLLAMA_NUM_CTX,
                "repeat_penalty": OLLAMA_REPEAT_PENALTY,
                "num_predict": max_tokens,
            },
        }
        try:
            resp = requests.post(
                f"{OLLAMA_BASE_URL}/api/chat",
                json=payload,
                timeout=OLLAMA_TIMEOUT,
            )
            resp.raise_for_status()
            result = (resp.json()["message"]["content"] or "").strip()
            _debug("qwen_ok", chars=len(result))
            # Reject empty or trivially short results
            if not result or len(result) < 6:
                _debug("qwen_empty_result")
                return None
            return result
        except Exception as exc:
            # Log server-side only; never propagate exception text to client
            _debug("qwen_failed", error=str(exc))
            return None

    def is_available(self) -> bool:
        try:
            resp = requests.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=5)
            if not resp.ok:
                return False
            names = [m.get("name", "") for m in resp.json().get("models", [])]
            return QWEN_MODEL in names
        except Exception:
            return False

    def answer_question(
        self,
        question: str,
        context_block: str,
        system_prompt: str,
        max_tokens: int = QA_MAX_LLM_TOKENS,
    ) -> Optional[str]:
        user = f"QUESTION:\n{question}\n\nTRANSCRIPT EVIDENCE:\n{context_block}"
        return self._post_chat(system_prompt, user, max_tokens)

    def summarize(self, transcript_text: str, max_tokens: int = 1500) -> Optional[str]:
        system = (
            "You are a meeting summarization assistant. "
            "Summarize the following transcript. Include participants, key points, decisions, and action items."
        )
        return self._post_chat(system, transcript_text, max_tokens)

    def extract_entities(self, transcript_text: str) -> Optional[str]:
        system = (
            "Extract named entities from this transcript. "
            "Return JSON: {{\"people\": [], \"organizations\": [], \"locations\": [], \"projects\": []}}"
        )
        return self._post_chat(system, transcript_text, 800)

    def generate_notes(self, transcript_text: str) -> Optional[str]:
        system = "Generate detailed meeting notes from this transcript including speaker insights and action items."
        return self._post_chat(system, transcript_text, 1500)

    def health(self) -> Dict[str, Any]:
        info: Dict[str, Any] = {
            "configured": bool(QWEN_MODEL),
            "model": QWEN_MODEL,
            "baseUrl": OLLAMA_BASE_URL,
            "reachable": False,
            "modelAvailable": False,
            "status": "disconnected",
            "error": None,
        }
        try:
            resp = requests.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=5)
            if resp.ok:
                info["reachable"] = True
                names = [m.get("name", "") for m in resp.json().get("models", [])]
                info["modelAvailable"] = QWEN_MODEL in names
                info["status"] = "connected" if info["modelAvailable"] else "model_missing"
            else:
                info["status"] = "error"
                info["error"] = f"HTTP {resp.status_code}"
        except Exception as exc:
            info["error"] = str(exc)
        return info


# ─── Provider registry ────────────────────────────────────────────────────────

_gemini = GeminiProvider()
_qwen = QwenProvider()

_PROVIDERS: Dict[str, BaseLLMProvider] = {
    "gemini": _gemini,
    "qwen": _qwen,
}

# Build provider call order: primary first, then fallback
_primary = QA_PRIMARY_PROVIDER if QA_PRIMARY_PROVIDER in _PROVIDERS else "gemini"
PROVIDER_ORDER: List[BaseLLMProvider] = [_PROVIDERS[_primary]] + [
    p for k, p in _PROVIDERS.items() if k != _primary
]


def get_providers_health() -> Dict[str, Any]:
    return {
        "gemini": _gemini.health(),
        "qwen": _qwen.health(),
        "primaryProvider": _primary,
        "providerOrder": [p.name for p in PROVIDER_ORDER],
    }
