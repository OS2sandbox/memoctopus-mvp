# Size the minutes prompt against the model's context window

Issue: [#97](https://github.com/OS2sandbox/memoctopus-mvp/issues/97). Status: design, awaiting review.

## Problem

`/api/minutes` → `generateReferatBody` (`src/lib/ai/minutes.ts`) never considers the
model's context window:

1. **No output cap, and `finish_reason` is ignored.** No `max_tokens` is passed. When the
   prompt nearly fills the window, little room is left for the answer, the referat is cut
   off mid-sentence, and the app stores it as if it were complete.
2. **Every referat is one call with the entire transcript.** The UI (`proceedToMinutes` in
   `TranscriptReview.tsx`) never sends `chapters`, so the existing per-chapter branch is not
   reachable from the app (uploads even save `chapters: []`). A long meeting on a small
   model overflows the window, vLLM rejects the request, and `withHandler` returns a generic
   `Internal server error`.
3. **Wasted prompt space.** One line per segment, each with a `[Taler N] (mm:ss):` prefix.
   STT emits short utterances, so one person speaking for a minute becomes many lines. The
   reporter measured 37% of characters (about half the tokens) spent on repeated labels.
4. **`CHAPTER_SPLIT_THRESHOLD = 20_000` is a fixed character count** unrelated to the
   configured model.

Deployment context: our compose defaults give the chat model a 32,768-token window
(`VLLM_CHAT_MAX_MODEL_LEN`, gemma-4-12b-it); the standalone vLLM file uses 65,536; the
reporter runs 16,384. The right limits are deployment-specific, so they must be settings.

## Goals

- A referat is never silently truncated. It is either complete or the user gets a clear error.
- Long meetings work on any configured context size, by summarising in parts.
- Behaviour for hosted OpenAI is unchanged apart from cheaper prompts: same single call,
  the window and output defaults sit at the model's real limits, and merged turns shorten
  the prompt.
- Operators configure one number per model, and the compose file wires it through.

## Non-goals

- `chapters.ts` and `pii.ts` also send whole transcripts unchunked. Follow-up.
- Making the UI send `chapters`. The splitter works without them, so it is not needed.
- The route's `maxDuration = 120` (only enforced on serverless hosts, not our Docker setup).
- Retrying when the token estimate turns out wrong. The error surfaces; the operator lowers
  `LLM_CONTEXT_TOKENS`.

## Design

### 1. Settings (`src/lib/ai/llm-limits.ts`, new)

`getLlmLimits()` reads `process.env` inside the function (same idiom as
`src/lib/auth/providers.ts`) and returns `{ contextTokens, maxOutputTokens }`.

| Variable | Default | Meaning |
|---|---|---|
| `LLM_CONTEXT_TOKENS` | `128000` when talking to hosted OpenAI (`OPENAI_API_KEY` set and no `LLM_BASE_URL`); `32768` in every other case | The model's context window in tokens |
| `LLM_MAX_OUTPUT_TOKENS` | `16384` when talking to hosted OpenAI (gpt-4o's maximum output); `4096` in every other case | Output cap for the referat call (4096 is about 3–4 pages of Danish) |

Any other endpoint (`LLM_BASE_URL`, self-hosted vLLM) gets the conservative 32768 and 4096,
because an unknown endpoint's limits are unknown. The hosted output default is the model's
maximum so that a long referat on OpenAI is not newly cut short; the cap only exists to make
the length an explicit decision. Values that are not positive integers fall back to the
default. Summary calls use a fixed cap of 1,024 output tokens.

**Budget.** `transcriptBudgetChars = (contextTokens − maxOutputTokens − fixedPromptTokens) × CHARS_PER_TOKEN`,
with `CHARS_PER_TOKEN = 2.5` (deliberately pessimistic: the reporter measured 2.33–2.97 for
Danish, and names, numbers and loanwords are worse). `fixedPromptTokens` is computed from the
actual fixed text of the call (system prompt + template instruction + custom prompt + wrapper
text), not a constant, because a long template plus a participant list can be large. If the
budget is below `MIN_TRANSCRIPT_BUDGET_CHARS = 4000`, generation throws `MinutesConfigError`.

**Compose wiring.** Compose passes env through an explicit allow-list, so both variables are
added to the `app` service in `docker-compose.yml`:

```yaml
- LLM_CONTEXT_TOKENS=${LLM_CONTEXT_TOKENS:-${VLLM_CHAT_MAX_MODEL_LEN:-}}
- LLM_MAX_OUTPUT_TOKENS=${LLM_MAX_OUTPUT_TOKENS:-}
```

The nested default makes the value that configures vLLM also configure the app. Verified with
`docker compose config`: an explicit value wins, an empty one falls through to
`VLLM_CHAT_MAX_MODEL_LEN`, and with neither set the app gets an empty string and uses the code
default. Both are documented in `.env.example`, `.env.deploy.example` and `DEPLOY.md`, including
that operators pointing `LLM_BASE_URL` at their own model should set `LLM_CONTEXT_TOKENS`.

### 2. Transcript shaping (`src/lib/ai/transcript-text.ts`, new)

Pure functions, no I/O:

- `mergeSpeakerTurns(segments)`: collapses consecutive segments with the same `speaker` into
  one turn `{ speaker, start, text }` (texts joined with a space, `start` from the first).
- `renderTurns(turns)`: `[Taler N] (m:ss): text`, one line per turn.
- `splitTurns(turns, budgetChars)`: packs consecutive turns into rendered parts (strings),
  each at most `budgetChars`, splitting at turn boundaries. A single turn longer than the budget is split at the last
  whitespace before the limit (hard split if none). Every input character appears in exactly
  one part, in order (only the whitespace at a split point is dropped).

### 3. Generation flow (`src/lib/ai/minutes.ts`)

1. Merge turns, render, and compute the budget from the actual instruction.
2. **Fits the budget** (and, if `chapters` were passed with more than one entry, is under the
   existing 20,000-character threshold): one call, as today.
3. **Over budget:** summarise in parts, then write the referat from the summaries.
   - With `chapters` (more than one): each chapter's turns are a unit. Otherwise the whole
     transcript is one unit.
   - A unit over the budget is split with `splitTurns`. Each part is summarised (max 8
     points, 1,024 output tokens) and gets its own heading: the unit's title, plus
     `(del i/n)` when the unit was split into several parts. (Timestamps were dropped: later
     summarise rounds have none to give.)
   - Summary calls run at most **3 at a time** (a small `mapWithLimit` helper, no new
     dependency). The vLLM compose file uses `--max-num-seqs 4`.
   - If the joined summaries still exceed the budget, summarise them again. At most 3
     summarise rounds run in total (the first pass counts as round 1); if the text is still
     over budget after round 3, it throws `MinutesTooLongError`.
4. The final call passes `max_tokens = maxOutputTokens`.
5. If the final referat call returns `finish_reason === 'length'`, throw
   `MinutesTruncatedError` instead of returning a cut-off document. A per-part *summary* cut
   off at its cap is tolerated (a shorter bullet list is still a usable input) and logs a
   warning: failing the whole meeting over an intermediate step would be worse.

The existing chapter branch stays as an optional refinement (chapter boundaries make better
summary units). It is currently unreachable from the UI.

### 4. Errors and user experience

`MinutesConfigError`, `MinutesTruncatedError` and `MinutesTooLongError` live in
`src/lib/ai/minutes-errors.ts`. Each extends a small shared base, `UserFacingError`
(`src/lib/user-facing-error.ts`), which carries the HTTP `status` and the Danish `userMessage`
the UI already displays (`data.error`), e.g. *"Mødet er for langt til at blive opsummeret med
den nuværende AI-model. Kontakt administratoren."*; the technical detail stays in `message`
for the log and is never sent to the user. `withHandler` (`src/lib/api-handler.ts`) renders a
`UserFacingError` as its own status and message and still logs it, so the minutes route needs
no error handling of its own and any future route can do the same. All other errors keep the
generic 500. The errors are a separate module from `minutes.ts` because the route tests
replace `@/lib/ai/minutes` with a mock, which would break `instanceof` checks.

No data is lost on failure: the UI deletes the audio only after a successful generation.

Each generation logs one line: `[minutes] chars=… budget=… mode=single|split rounds=… ms=…`.

The UI aborts after 5 minutes. Split runs make several sequential LLM rounds, so duration is
measured on a real long meeting during verification and revisited if it gets close.

## Testing

Vitest, mocking `openai` like the existing `minutes.test.ts`:

- `llm-limits`: defaults for hosted OpenAI vs self-hosted vs `LLM_BASE_URL`; invalid values
  fall back; budget arithmetic; `MinutesConfigError` below the minimum.
- `transcript-text`: merging, rendering, and `splitTurns` (every character appears exactly
  once and in order; each part within budget; an over-long single turn is split).
- `generateReferatBody`: single call when it fits; split when over budget without chapters;
  oversize chapter split into parts; every prompt within budget; concurrency never exceeds 3;
  `max_tokens` on both call types; `finish_reason: 'length'` throws; too-long after 3 rounds.
- Route: each typed error maps to its Danish message; other errors still return the generic 500.
- Compose: `docker compose config` shows both variables, including the fall-through.

Real-model check: with the local OpenAI key, set `LLM_CONTEXT_TOKENS` artificially low (for
example 6000) and generate from a synthetic 60-minute Danish transcript, exercising the split
path end to end and confirming the referat covers every part.

## Delivery

Own branch and PR, `fix(ai): size minutes prompt against the model context window`, with
`Fixes #97`. Follow-ups noted in the PR: unchunked transcripts in `chapters.ts` and `pii.ts`.
The reporter offered a PR and described this approach in #97, so it is credited there.
