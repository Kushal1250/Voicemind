# qa_service (Python) changes — VoiceMind QA fix

Extract this zip over your existing `python_service/` (or `qa_service/`)
folder — it only contains the files that changed.

## Files changed

### `classifier.py`
- Added `extract_word_target(question)` — parses an explicit word-count
  request ("...in 200 words", "2000-word summary") via regex, clamped to a
  sane 10–3000 range. Previously nothing in the pipeline looked for this at
  all, so "summarize in 200 words" and "summarize in 2000 words" produced
  the same (often truncated) answer.
- Added `build_length_instruction(word_target)` — turns that into an
  explicit system-prompt instruction with a tolerance range, telling the
  model to use evidence from across the full transcript, scale detail to
  the target, not pad with filler, and vary its opening sentence instead of
  reusing a stock phrase.
- Updated the `SUMMARY` and `MEETING_NOTES` prompt templates: explicit
  instruction to draw on the full transcript (not just the opening lines),
  call out meaningful speaker/language changes, choose flowing prose vs.
  structured sections based on the requested length, and never open with
  "The transcript captures..." / "This meeting discusses...".

### `retrieval.py`
Added two evidence-selection functions used for the `sources` field shown
to the user (the `context_block` sent to the LLM is unchanged):
- `select_representative_evidence(segments, limit)` — for summary/notes/
  language questions, where evidence was previously just `segments[:12]`
  (the literal opening lines, identical for every question). This spreads
  picks across the *entire* transcript using a start/end/middle "spread
  order" so that even the first 4 items (all the frontend ever renders) are
  drawn from the beginning, middle, and end — not clustered at the start.
  Prefers longer/more informative lines and dedupes near-identical text.
- `select_top_scored(evidence, limit)` — for general Q&A, where retrieved
  evidence was relevance-filtered but then re-sorted back into chronological
  order before truncation (so the *displayed* sources were the earliest
  relevant matches, not the *best* ones). Now sorted by the relevance score
  `hybrid_retrieve` already computes, with deduplication.

### `main.py`
- Wires in `extract_word_target` / `build_length_instruction` from
  `classifier.py` and the two new selection functions from `retrieval.py`.
- Added `compute_max_tokens(word_target, category)` — the output token
  budget is no longer one fixed `QA_MAX_LLM_TOKENS` for every request
  (this deployment's `.env` had it at 500 ≈ 350 words, which made a
  2000-word summary structurally impossible regardless of the prompt). An
  explicit word target now gets a generous, script-aware token estimate
  (~2.2 tokens/word, covering Gujarati/Hindi which need more tokens per
  word than English); summary/notes questions without an explicit target
  still get more room than a one-line answer needs.
- The weak-answer extractive fallback (`saw_weak` branch) and the
  no-evidence fallback now build their excerpt from the same well-
  distributed `source_pool` instead of raw chronological `evidence`, so
  even total-provider-failure responses don't collapse back to the first
  few transcript lines.
- Version bumped to 9.1.0 in the `/` and `/health` responses.

### `.env` / `.env.example`
- `GOOGLE_API_KEY` value replaced with a placeholder in `.env.example`
  (a template file should never contain a real-looking key). The real
  `.env` keeps a working note that this exact key is duplicated across
  multiple files and should be rotated.
- Fixed a dead config variable: the real `.env` had `OLLAMA_MODEL=...`,
  but the code reads `QWEN_MODEL` — renamed so the setting actually takes
  effect (no behavior change today since both values were already
  `qwen2.5:latest`, just removes a confusing no-op).
- Clarified that `QA_MAX_LLM_TOKENS` is now a *floor* for ordinary Q&A —
  summary/notes/explicit-length requests compute their own larger budget
  regardless of this value.

## Not changed (reviewed, found OK)
- `providers.py` — already forwards `max_tokens` through correctly; the
  Gemini/Qwen call wrappers already never raise, never leak provider error
  text, and already do their own weak-answer detection. No changes needed.
