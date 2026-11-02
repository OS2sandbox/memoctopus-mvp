# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development
```bash
npm run dev          # Next.js (port 3004) plus the diarization tunnel, concurrently
npm run build        # Production build (Next.js only)
npm start            # Serve production build
npm run lint         # ESLint via next lint
```

### Database (Drizzle)
```bash
npm run db:generate  # Generate migration files
npm run db:migrate   # Apply migrations
npm run db:push      # Push schema without migration files (dev)
npm run db:studio    # Open Drizzle Studio UI
```

### Testing
```bash
npm test                         # Run all Vitest tests once
npm run test:watch               # Run Vitest in watch mode
npm run test:coverage            # Run with v8 coverage
npx vitest run src/lib/ai/       # Run a specific directory
npx vitest run src/lib/ai/chapters.test.ts  # Run a single test file
```

The diarization service has its own Python tests (pytest, Python 3.10+; the deps are
listed in `diarization-service/tests/conftest.py`):
```bash
cd diarization-service && python3 -m pytest
```

### Environment setup
```bash
cp .env.example .env
# Fill in required values, then:
npm install
npm run db:migrate
```

## Architecture

This is **OS2taletiltekst**, a Danish meeting-minutes app (the package is still called
`referat`). It is one Next.js app; Teams meetings are handled inside it through Microsoft
Graph (section 2), with nothing joining the call. The GPU services it can use — hviske
STT, the pyannote `diarization-service/` and a vLLM chat model — run elsewhere or come
from the `docker-compose.ai.yml` overlay (see Docker / deployment).

### 1. Next.js app (`src/`)

A Next.js 15 App Router application using the `(app)` route group for authenticated pages. All API routes live under `src/app/api/`.

**Database — per-user PostgreSQL schemas**: Each user gets their own PostgreSQL schema (`u_<userId>`), created lazily on first access via `ensureUserSchema()` in `src/lib/db/user-schema.ts`. The shared `public` schema holds only auth tables (better-auth). Because Drizzle cannot target dynamic schema names, **all per-user queries use raw SQL** via `queryUserSchema()` / `queryUserSchemaOne()` helpers — not Drizzle ORM. Schema migrations are implemented as idempotent `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN IF NOT EXISTS` statements inside `ensureUserSchema`.

**Auth**: Uses `better-auth`. `src/lib/auth/index.ts` builds the real instance (Drizzle adapter over the `public` schema); `src/middleware.ts` gates routes on the session cookie.

Which login methods exist is decided in one place — `src/lib/auth/providers.ts`. It reads `process.env` **inside** its functions (same idiom as `src/lib/skabeloner/share-config.ts`), and is consumed by both `auth/index.ts` (to register providers) and `src/app/(marketing)/page.tsx` (to render buttons), so the server and the UI can't disagree. Three methods: email/password, Microsoft Entra ID (`socialProviders`), and one generic OIDC provider via the `genericOAuth` plugin — configured with `OIDC_*`, with `AUTHENTIK_*` honoured as a deprecated fallback.

With one named tenant (`MICROSOFT_TENANT_ID`), the stored name and email follow Entra on every sign-in (`overrideUserInfoOnSignIn`). `src/lib/auth/entra-user-info.ts` vets the claims first (as the provider's `mapProfileToUser`): an email another user row already holds is not taken over — `users.email` is UNIQUE and the failed write would lock the user out — and a verified user is never downgraded.

Auth config is deliberately **runtime-only**, never `NEXT_PUBLIC_*`: an operator changes `.env` and restarts, with no image rebuild. That is why `(marketing)/page.tsx` sets `export const dynamic = 'force-dynamic'` — without it Next prerenders the page and freezes the provider list into the build-time RSC payload (`src/app/(marketing)/page.test.tsx` guards this).

**AI pipeline** (after a meeting is recorded):
1. `src/lib/ai/transcription.ts` — STT via the hviske (`syvai/hviske-ensemble`) server's OpenAI-compatible API. Used for both the per-utterance live path (`/api/meetings/[id]/utterance`) and the batch transcribe pass. Configured via `HVISKE_URL` / `HVISKE_API_KEY`. Speaker diarization (`src/lib/ai/diarization.ts`) is a separate pass over the whole recording by the standalone pyannote service in `diarization-service/` (`POST /diarize` at `DIARIZATION_URL`; the AI overlay runs it, and with the URL unset it is derived from `HVISKE_URL` for a hviske server that co-hosts `/diarize`). hviske returns plain text only, so segment timestamps are VAD-estimated and the diarization turns are merged on by time-overlap (`src/lib/audio/merge-speakers.ts`). The request's only time limit is `DIARIZATION_TIMEOUT_MS`, enforced server-side; the browser waits for the route.
   Whisper-family degeneration — runaway repetition and learned subtitle credits
   ("Danske tekster af …") — is handled in `src/lib/audio/hallucinations.ts`:
   `cleanTranscribedText()` cuts a loop off at its first echo and keeps the real words
   before it, rather than discarding the whole batch as the old boolean guard did.
2. `src/lib/ai/pii.ts` — PII detection and replacement.
3. `src/lib/ai/chapters.ts` — Chapter/topic segmentation.
4. `src/lib/ai/minutes.ts` — Meeting minutes generation. Prompts are in Danish.
5. `src/lib/ai/clarifications.ts` — Generates clarification questions about ambiguous content.

   Steps 2–5 call a chat model through `src/lib/ai/llm-client.ts`, which picks the backend:
   `LLM_BASE_URL` (any OpenAI-compatible server) if set, else hosted OpenAI (`gpt-4o`) if
   `OPENAI_API_KEY` is set, else the bundled vLLM at `vllm-chat:8000`, requesting
   `VLLM_MODEL` (the overlay's default when unset). Minutes generation budgets its prompt
   against the model's context window (`src/lib/ai/llm-limits.ts`: `LLM_CONTEXT_TOKENS`,
   `LLM_MAX_OUTPUT_TOKENS`, falling back to `VLLM_CHAT_MAX_MODEL_LEN`), counting tokens
   exactly with vLLM's `/tokenize` where available and a pessimistic estimate otherwise.
   A meeting that fits is written in one call; a longer one is summarised in parts
   (per chapter where there are chapters) and the referat written from the summaries.
   Typed errors in `minutes-errors.ts` carry the Danish message the user sees.

**Pending-artifact hand-off**: the Graph pipeline runs long after whoever armed the
meeting closed the tab, and meetings live in the browser, so it stashes its output on
disk under `${AUDIO_STORAGE_PATH}/pending-artifacts` via
`src/lib/pending-artifacts.ts`. The browser collects it through
`GET /api/meetings/[id]/pending-meta` (speaker names and duration) and
`/pending-transcript` (the segments), both of which delete the stashed record as they
hand it over. Both are session-gated and additionally check an owner file, so one
user cannot collect another's artifacts. `pending-transcript` is polled for *every*
meeting, local recordings included, where it answers `{ status: 'none' }` and the
client falls back to its own batch pass. `src/lib/transcribe-recording.ts`
(`transcribeRecording`) is the server-side transcription pass over a recording.

**Raw meeting audio never reaches the browser from a Teams meeting.** Graph publishes
nothing until a meeting has ended and the poller will not ask before `scheduled_end`,
so nobody can follow a Teams meeting live here and nobody has a reason to hold the
audio afterwards. All three pipeline modes therefore transcribe server-side and then
call `markNoRecording()`; there is no code path that stashes audio, and
`pending-artifacts.ts` exposes none. Enforced per mode in `pipeline.test.ts`, so a
fourth mode that stashed audio would fail the suite.

**Meeting status flow**: `awaiting_teams` (Teams/Graph) or `recording` (in person) →
`processing` → `review` → `minutes` → `done` (also `redacted`, `failed`). The Postgres
enum additionally carries `joining` and `cancelled`, neither of which any code writes:
`joining` belonged to the removed Playwright bot, and a value cannot be dropped from a
Postgres enum.

### 2. Teams via Microsoft Graph (`src/lib/teams/`)

How Teams meetings work. The app asks Microsoft Graph (delegated, as the signed-in
Microsoft user) to turn on transcription, then collects Teams' own
transcript/recording after the meeting. Nothing joins the call.

A Playwright bot did this before by joining the meeting as a participant. It was
removed in `6c03588`; `git show bot-service-final` recovers it. Meetings it left
behind in a browser's IndexedDB render `LegacyBotMeetingScreen`, which explains the
dead end and offers the saved transcript or a delete.

- `graph-client.ts` — `graphFetch()` (bearer attached only for the Graph origin),
  `getGraphAccessToken()` via better-auth's `/get-access-token`, `hasGraphScopes()`, and
  `GraphError` with codes `consent_required | reauth_required | transcripts_disabled |
  forbidden | not_found | http` carrying Danish user-safe messages. The delegated scope
  list lives in `src/lib/auth/providers.ts` (`GRAPH_DELEGATED_SCOPES`) to avoid an import
  cycle, and is re-exported here as `GRAPH_SCOPES`.
- `url.ts` — validates/normalises a Teams join URL; `extractJoinContext()` pulls thread id,
  tenant and organizer oid out of it.
- `meeting-resolver.ts` — `resolveJoinUrl()` looks the meeting up via
  `$filter=JoinWebUrl eq '…'` and decides `isOrganizer` against `/me`.
- `meeting-arm.ts` — `armMeeting()` PATCHes `recordAutomatically` / `allowTranscription`;
  returns `armed | armed_in_progress | not_organizer | policy_blocked`. `disarmMeeting()`
  restores the options snapshotted before the PATCH. **`armed_in_progress` means only
  "Graph gave this meeting no window"** (an instant meeting or a personal meeting link) —
  not that the meeting is running. Delegated Graph has no roster and no in-progress flag,
  so the two are indistinguishable, and such a link is routinely pasted in before anyone
  joins, where `recordAutomatically` works fine. The screen therefore leads with
  "OS2taletiltekst er slået til" and offers the manual start as a condition, never as a fact.
- `artifacts.ts` — lists and downloads transcripts (VTT) and recordings; recording download
  follows Graph's 302 by hand with `redirect: 'manual'`, dropping the bearer once the URL
  leaves the Graph origin.
- `recording-cleanup.ts` — `deleteRecordingFromDrive()`: removes a transcribed
  recording from the organizer's OneDrive, so the audio does not outlive the
  transcription in Microsoft 365 either. Graph has **no delete on `callRecording`**
  and nothing on one names its driveItem, so the file is found in
  `/me/drive/special/recordings` by the **exact byte count we downloaded** and
  removed with `permanentDelete` (falling back to an ordinary delete when the tenant
  refuses). Never match on file name or time: that could delete a recording this
  run never fetched. More than one file of that size deletes nothing. The poller
  owns the orchestration (`cleanUpRecording()`): `recording_cleanup = 'pending'` is
  written in the same UPDATE that marks the row `ready`, retried every tick for a
  day, and never changes the meeting's state. A row whose recording is gone passes
  `recordingDeleted` to the pipeline, so "Hent igen" goes straight to Teams' own
  transcript. Needs `Files.ReadWrite`; off with `TEAMS_DELETE_RECORDING=false`.
  Teams' transcript has no delete in Graph either, and needs none: it is embedded
  in that mp4 rather than stored as a file, so it goes with the recording.
  **Unverified against a real tenant**: that Graph's recording content is
  byte-identical to the stored file, and that Graph stops serving the transcript
  once the file is gone — see docs/testing-locally.md §B step 9.
- `vtt.ts` — VTT parser; `turnsFromVtt()` feeds real speaker names into
  `src/lib/audio/merge-speakers.ts` (`preserveNames`), `segmentsFromVtt()` is the
  transcript-only path.
- `cue-batches.ts` / `transcribe-cues.ts` — how a Teams recording is cut up for hviske.
  The generic path (`prepareVadBatches`) runs an energy VAD and then **splices** the
  surviving fragments into 27 s windows. A browser microphone recording survives that;
  a Teams cloud recording (16 kHz mono AAC at ~22 kbit/s) does not — measured against
  the production hviske, the spliced window transcribed only its loudest passage and
  silently dropped the first minute of the meeting. Cut instead into **contiguous**
  slices along Teams' own transcript cues, the same audio came back complete, with no
  repetition loops and no subtitle-credit hallucinations. Slice boundaries are speaker
  turns, so each segment's speaker is read off its cue rather than guessed by overlap.
  Note that **Teams cues overlap**: Teams transcribes each participant's own client-side
  stream, so two people talking at once are two simultaneous cues, and it hears things
  the mono 16 kHz mixdown we download has physically merged. That is the ceiling on how
  much of a Teams meeting any single-stream ASR can recover from the recording.
- `pipeline.ts` — `processTeamsMeeting()`: pick artifact → download → transcode →
  transcribe along the cues (mode 1) or via `transcribeRecording()` (mode 3), landing in
  the same pending-artifact stash, so the hand-off and the Gennemgang flow are unchanged.
  Returns `ready | pending | failed`; a pending outcome carries `phase: 'waiting' |
  'working'` so the screen can tell "Teams has published nothing" from "we are busy with
  what it published". `coversMeeting()` is the safety net: when hviske comes back with
  less than `MIN_COVERAGE_RATIO` of the words Teams itself heard, Teams' own transcript
  (already downloaded) ships instead.
- `store.ts` — raw-SQL CRUD over the per-user `teams_meetings` table (same per-user schema
  rules as everything else), plus the polling-due predicate and backoff.
- `poller.ts` — `pollMeeting()` / `pollDueMeetings()`; started from `src/instrumentation.ts`
  inside the Next.js server process and serialised across instances by a Postgres advisory
  lock. Off unless `TEAMS_GRAPH_ENABLED=true`; also disabled under test and via
  `TEAMS_POLLER_DISABLED`.
- `http-errors.ts` — maps `GraphError` / `ResolveError` onto status codes and Danish
  messages for the API routes.

**API routes** (`src/app/api/teams/`, all session-gated):
`GET /status` (is a Microsoft account linked, are the Graph scopes consented),
`POST /meetings` (register + arm), `GET /meetings/[id][?poll=1]`,
`DELETE /meetings/[id]` (disarm + forget).

The single entry point is the user pasting a meeting's join link into the dashboard's
**Mødelink** box. There is deliberately no calendar listing: it would need
`Calendars.Read` — read access to the user's whole calendar — which is a far harder
consent for an organisation to grant than what the rest of the flow needs: four
delegated Graph permissions (`OnlineMeetings.ReadWrite`,
`OnlineMeetingTranscript.Read.All`, `OnlineMeetingRecording.Read.All`, `Files.ReadWrite`)
plus `User.Read` and `offline_access`. Three of them are meeting-scoped;
`Files.ReadWrite` reaches the user's whole OneDrive, though the app only ever touches the
Recordings folder (recording cleanup, above), and it is dropped with
`TEAMS_DELETE_RECORDING=false` or `transcript-only`. `resolveJoinUrl()` gets subject and
start/end off the `onlineMeeting` itself, so nothing is lost. Danish copy for the route's error codes
lives in `src/components/dashboard/arm-error-message.ts`.

**Outlook add-in** (docs/outlook-addin.md): a second entry point. The task pane
(`outlook-addin/src/`, built into `public/outlook-addin/` by `npm run build`) reads the
join link from the meeting body and calls `POST /api/outlook/meetings` with an NAA
bearer token, verified in `src/lib/outlook/addin-auth.ts` and mapped to the user by
`sub`; registration is shared with the Mødelink box (`src/lib/teams/register.ts`).
Rows armed this way carry `origin = 'outlook'` and are **deferred**: the background
poller leaves them until the user opens the meeting here (`opened_at`), 30 days at
most. The dashboard/Arkiv import them from `GET /api/teams/meetings`.

**Teams meeting state** (`teams_meetings.state`):
`awaiting_teams` → `fetching` → `ready` | `failed` | `needs_reauth`. The client-side meeting
status gains a matching `awaiting_teams`. `fetching` means a run holds this meeting's
artifacts and is downloading/transcribing them; `GET /meetings/[id]` reports it as
`working: true` and the screen says so instead of "Teams har ikke frigivet noget endnu".
`?poll=1` no longer blocks the request on the whole run — it waits `FORCED_POLL_BUDGET_MS`
and then answers with the row, leaving the run going in the same Node process.

### Docker / deployment
`docker-compose.yml` at repo root defines three services: `db` (Postgres), `migrate`
(one-shot `drizzle-kit migrate`, which `app` waits on via
`condition: service_completed_successfully`) and `app` (Next.js, published on
`${APP_PORT:-8080}` → 3000). Audio files live on a named volume (`audio-storage`),
path configurable via `AUDIO_STORAGE_PATH`.

Overlays merge on top and are never used standalone: `docker-compose.ai.yml` adds the
GPU services (hviske, diarization, vllm-chat) and repoints the app at them,
`docker-compose.proxy.yml` is TLS termination for one specific deployment (its host
name and certificate are hard-coded in `nginx/nginx.conf`; it gives the diarize route a
3600 s read timeout), and
`docker-compose.tunnel.yml` reaches a remote diarization service over ssh.

**The app only receives variables listed explicitly in `app.environment`.** There is no
`env_file:`, so adding a variable to `.env` without adding it there leaves it unset in
the container. Note also that `.env.deploy.example`, not `.env.example`, is what
`scripts/bootstrap-host.sh` copies onto a server.

## Key env vars

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `HVISKE_URL` | hviske STT server (OpenAI-compatible `/v1`) |
| `HVISKE_API_KEY` | Bearer key for the hviske STT server |
| `HVISKE_MODEL` | hviske model id (default `syvai/hviske-ensemble`) |
| `ASR_LANGUAGE` | Transcription language (default `da`) |
| `HVISKE_DIARIZE` | `true`/`false` overrides whether transcription returns speakers inline (auto: on for the hosted platform, off for self-hosted hviske, which uses the diarization service) |
| `HVISKE_BATCH_CONCURRENCY` | Cap on batch requests in flight to hviske (default: all at once) |
| `DIARIZATION_URL` / `_API_KEY` | pyannote diarization service and its bearer key (blank URL = derived from `HVISKE_URL`) |
| `DIARIZATION_TIMEOUT_MS` | The one time limit on a diarization request (default `300000`); a proxy in front must allow as long |
| `OPENAI_API_KEY` | Hosted OpenAI for the chat-model steps (PII, chapters, minutes, clarifications) |
| `LLM_BASE_URL` / `LLM_MODEL` | Any OpenAI-compatible chat endpoint, and the model to request (overrides the backend choice) |
| `VLLM_MODEL` | The model the bundled vLLM serves; the app requests it on that backend (default `google/gemma-4-12b-it`) |
| `LLM_CONTEXT_TOKENS` / `LLM_MAX_OUTPUT_TOKENS` | Chat model's context window and referat output cap (default 128000/16384 on OpenAI, 32768/8192 otherwise) |
| `VLLM_CHAT_MAX_MODEL_LEN` | The bundled vLLM's `--max-model-len`; also the app's window on that backend when `LLM_CONTEXT_TOKENS` is unset |
| `AUDIO_STORAGE_PATH` | Filesystem path for audio files and collected Teams transcripts |
| `SKABELON_SHARE_CODE` / `_LINK` | Skabelon sharing: copy/paste code (on unless `false`) / import link (off unless `true`) |
| `BETTER_AUTH_URL` / `BETTER_AUTH_SECRET` | better-auth base URL and signing secret |
| `EMAIL_PASSWORD_ENABLED` | Kill switch for email/password (default on) |
| `MICROSOFT_CLIENT_ID` / `_SECRET` / `_TENANT_ID` | Entra ID; enables itself when the id + secret are set |
| `TEAMS_GRAPH_ENABLED` | Opt-in (default off) for the Teams/Graph integration: adds the Graph scopes to the Microsoft sign-in, which need tenant-admin consent. Read at startup |
| `OIDC_CLIENT_ID` / `_SECRET` / `_DISCOVERY_URL` | Generic OIDC provider (Keycloak, Authentik, …) |
| `OIDC_PROVIDER_ID` / `_NAME` | Callback path segment + account key / button label |
| `OUTLOOK_ADDIN_ENABLED` | Opt-in (default off) for the Outlook add-in at `/outlook-addin/`. Needs `TEAMS_GRAPH_ENABLED` and a tenant-specific `MICROSOFT_TENANT_ID`; see docs/outlook-addin.md |
| `OUTLOOK_ADDIN_ID` | Optional GUID for the add-in in the manifest (default: a fixed GUID). Set it only when two installs share one tenant |
| `GRAPH_BASE_URL` | Microsoft Graph base URL (default `https://graph.microsoft.com/v1.0`) |
| `TEAMS_SPOKEN_LANGUAGE` | Language Teams transcribes in (default `da-DK`) |
| `TEAMS_ARTIFACT_MODE` | `prefer-recording` (default) or `transcript-only` (also drops the recording scope from sign-in) |
| `TEAMS_DELETE_RECORDING` | On unless `false`: delete the recording from the organizer's OneDrive once transcribed (adds `Files.ReadWrite` to sign-in; no effect in `transcript-only`) |
| `TEAMS_POLL_INTERVAL_MS` | Graph poll interval (default `120000`) |
| `TEAMS_POLLER_DISABLED` | Set `true` to stop this instance from polling Graph |

## Testing conventions

- **Vitest** for the app; **pytest** for `diarization-service/` (see Commands).
- Tests run in `node`. Component tests (`.test.tsx` in `src/components/`) opt into `jsdom`
  with a `// @vitest-environment jsdom` docblock at the top of the file.
- `src/compose-environment.test.ts` fails when server code reads an environment variable
  that `docker-compose.yml` does not pass to the app.
- Test helpers: `src/test/helpers.ts` exports `FAKE_SESSION` and `makeJsonReq()`.
- API route tests mock `@/lib/db/user-schema` and `@/lib/auth` to avoid real DB/auth dependencies.
