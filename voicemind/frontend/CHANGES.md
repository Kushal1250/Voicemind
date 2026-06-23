# Frontend changes — VoiceMind QA fix

Extract this zip over your existing `frontend/` folder — it only contains
the one file that changed.

## Files changed

### `src/store/slices/qaSlice.js`
Added a per-request timeout override (175s) on the `askQuestion` thunk's
`api.post(...)` call. The shared `api` client defaults to a 60s timeout,
which is shorter than the backend's own `QA_TIMEOUT_MS` (now ~170s, see the
backend changes, to allow for Gemini + local Qwen fallback on long
summaries). Without this override, the frontend would abort the request
and show a generic error before the backend ever finished — even after the
backend/QA-service fixes.

## Reviewed, no changes needed
- `src/components/QAAnswerCard.jsx` — already only renders the first 4
  evidence items and already never surfaces provider/technical error text.
  The fix for "same 4 lines" is entirely on the backend/qa_service side
  (ranking which 4 items get sent), not here.
- `src/utils/qa.js` — `buildAnswerState`/`getModeLabel` already keep all
  error and mode messaging neutral and user-safe.
