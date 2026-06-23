# Backend changes — VoiceMind QA fix

Extract this zip over your existing `backend/` folder (it only contains the
files that changed — everything else is untouched).

## ⚠️ Manual step required
`geminiSymptoms.Service.js` was renamed to `geminiSymptoms.service.js`
(lowercase `.service`). After extracting, **delete the old
`src/services/geminiSymptoms.Service.js`** — on Windows/macOS the two
filenames look identical so extraction may not remove it for you, and on a
case-sensitive filesystem (Linux/Docker/most production hosts) having both
would just leave the dead one sitting there.

## Files changed

### `src/models/QAInteraction.js`
The schema was silently dropping data on every save:
- `sources[].speaker` was never declared on the sub-schema, so Mongoose
  stripped the speaker label off every piece of evidence as soon as it was
  saved — proof cards lost their speaker attribution on any page reload.
- `mode` and `questionLang` were referenced in code/comments but never
  declared on the schema, so they were dropped too.
Added all three fields (additive, backward compatible — existing documents
are unaffected).

### `src/routes/qa.routes.js`
- **`QA_TIMEOUT_MS` raised from 30s → 170s.** The Python QA service's own
  provider chain (Gemini timeout + Qwen/Ollama local fallback timeout) can
  legitimately take up to ~150s. The old 30s Node-side timeout fired first,
  so Node gave up and silently fell back to a dumb local answer before
  Python ever finished — this was the single biggest cause of "weak/
  repetitive summary" behavior, especially for long word-count requests.
- Replaced every `segments.slice(0, 4)` / `.slice(0, 5)` "fallback to the
  first N lines" with `pickRelevantSegments()`, a small Unicode-aware
  (English/Gujarati/Hindi) keyword-overlap scorer. This only runs when the
  Python service is unreachable or returns nothing usable — the real
  evidence-ranking fix lives in `qa_service/retrieval.py` — but it means
  even this emergency path no longer always shows the same 4 lines.
- `questionLang` is now actually computed (simple script detection) and
  persisted; previously referenced but never set.
- `attachResponseMeta` now prefers the freshly computed sources/mode/
  questionLang over the persisted document, so the response can't regress
  even if a schema field falls behind again in the future.

### `src/services/geminiSummary.service.js` and `geminiSymptoms.service.js`
- **Removed a hardcoded Google API key** that was used as a silent fallback
  default (`process.env.GOOGLE_API_KEY || 'AQ.Ab8...'`). The exact same key
  was duplicated across both files and both `.env`/`.env.example` files —
  meaning it's effectively committed to source control. **Rotate this key
  in Google AI Studio** and treat it as compromised regardless of whether
  it's still active.
- Added a one-time `console.warn` if `GOOGLE_API_KEY` is unset, so a missing
  key is diagnosable in logs instead of silently degrading.
- (`geminiSymptoms.service.js` only) **Fixed a file-casing bug.** The file
  was named `geminiSymptoms.Service.js` (capital S) but
  `transcripts.routes.js` imports `'../services/geminiSymptoms.service'`
  (lowercase). This resolves fine on Windows/macOS (case-insensitive
  filesystems) but throws `Cannot find module` and crashes the whole
  backend on boot on any case-sensitive filesystem — i.e. virtually every
  Linux/Docker production deployment.

### `.env` / `.env.example`
- `QA_TIMEOUT_MS` updated to match the code-level fix above.
- Added a rotation warning next to `GOOGLE_API_KEY`.
- `.env.example`'s key value replaced with a placeholder (a template file
  should never contain a real-looking key).
