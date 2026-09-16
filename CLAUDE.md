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

### Environment setup
```bash
cp .env.example .env
# Fill in required values, then:
npm install
npm run db:migrate
```

## Architecture

This is a **Danish meeting minutes app** ("Referat") composed of two independent services:

### 1. Next.js app (`src/`)

A Next.js 15 App Router application using the `(app)` route group for authenticated pages. All API routes live under `src/app/api/`.

**Database — per-user PostgreSQL schemas**: Each user gets their own PostgreSQL schema (`u_<userId>`), created lazily on first access via `ensureUserSchema()` in `src/lib/db/user-schema.ts`. The shared `public` schema holds only auth tables (better-auth). Because Drizzle cannot target dynamic schema names, **all per-user queries use raw SQL** via `queryUserSchema()` / `queryUserSchemaOne()` helpers — not Drizzle ORM. Schema migrations are implemented as idempotent `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN IF NOT EXISTS` statements inside `ensureUserSchema`.

**Auth**: Uses `better-auth`. `src/lib/auth/index.ts` builds the real instance (Drizzle adapter over the `public` schema); `src/middleware.ts` gates routes on the session cookie.

Which login methods exist is decided in one place — `src/lib/auth/providers.ts`. It reads `process.env` **inside** its functions (same idiom as `src/lib/skabeloner/share-config.ts`), and is consumed by both `auth/index.ts` (to register providers) and `src/app/(marketing)/page.tsx` (to render buttons), so the server and the UI can't disagree. Three methods: email/password, Microsoft Entra ID (`socialProviders`), and one generic OIDC provider via the `genericOAuth` plugin — configured with `OIDC_*`, with `AUTHENTIK_*` honoured as a deprecated fallback.

Auth config is deliberately **runtime-only**, never `NEXT_PUBLIC_*`: an operator changes `.env` and restarts, with no image rebuild. That is why `(marketing)/page.tsx` sets `export const dynamic = 'force-dynamic'` — without it Next prerenders the page and freezes the provider list into the build-time RSC payload (`src/app/(marketing)/page.test.tsx` guards this).

**AI pipeline** (after a meeting is recorded):
1. `src/lib/ai/transcription.ts` — STT via the hviske (`syvai/hviske-ensemble`) server's OpenAI-compatible API. Used for both the per-utterance live path (`/api/meetings/[id]/utterance`) and the batch transcribe pass. Configured via `HVISKE_URL` / `HVISKE_API_KEY`. Speaker diarization (`src/lib/ai/diarization.ts`) is now co-hosted on the same server at `POST /diarize`; hviske still returns plain text only, so segment timestamps are VAD-estimated and the diarization turns are merged on by time-overlap (`src/lib/audio/merge-speakers.ts`).
2. `src/lib/ai/pii.ts` — PII detection and replacement using OpenAI `gpt-4o`.
3. `src/lib/ai/chapters.ts` — Chapter/topic segmentation using OpenAI.
4. `src/lib/ai/minutes.ts` — Meeting minutes generation using OpenAI `gpt-4o`. Prompts are in Danish.
5. `src/lib/ai/clarifications.ts` — Generates clarification questions about ambiguous content.

**Pending-artifact hand-off**: a server-side run (the Graph pipeline) stashes its
output on disk under `${AUDIO_STORAGE_PATH}/bot-pending` via
`src/lib/pending-artifacts.ts`, and the browser collects it through
`GET /api/meetings/[id]/pending-audio` and `/pending-transcript`, which delete the
stashed copy as they hand it over. Both are session-gated and additionally check an
owner file, so one user cannot collect another's artifacts.
`pending-transcript` is polled for *every* meeting, local recordings included, where
it answers `{ status: 'none' }` and the client falls back to its own batch pass.
`src/lib/transcribe-recording.ts` (`transcribeRecording`) is the server-side
transcription pass over a finished recording.

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
  returns `armed | not_organizer | policy_blocked`. `disarmMeeting()` only clears
  `recordAutomatically`.
- `artifacts.ts` — lists and downloads transcripts (VTT) and recordings; recording download
  follows Graph's 302 by hand with `redirect: 'manual'`, dropping the bearer once the URL
  leaves the Graph origin.
- `vtt.ts` — VTT parser; `turnsFromVtt()` feeds real speaker names into
  `src/lib/audio/merge-speakers.ts` (`preserveNames`), `segmentsFromVtt()` is the
  transcript-only path.
- `pipeline.ts` — `processTeamsMeeting()`: pick artifact → download → transcode → reuse the
  existing `transcribeRecording()` stash, so the pending-artifact hand-off and
  the Gennemgang flow are unchanged. Returns `ready | pending | failed`.
- `store.ts` — raw-SQL CRUD over the per-user `teams_meetings` table (same per-user schema
  rules as everything else), plus the polling-due predicate and backoff.
- `poller.ts` — `pollMeeting()` / `pollDueMeetings()`; started from `src/instrumentation.ts`
  inside the Next.js server process and serialised across instances by a Postgres advisory
  lock. Disabled under test and via `TEAMS_POLLER_DISABLED`.
- `http-errors.ts` — maps `GraphError` / `ResolveError` onto status codes and Danish
  messages for the API routes.

**API routes** (`src/app/api/teams/`, all session-gated):
`GET /status` (is a Microsoft account linked, are the Graph scopes consented),
`POST /meetings` (register + arm), `GET /meetings/[id][?poll=1]`,
`DELETE /meetings/[id]` (disarm + forget).

The single entry point is the user pasting a meeting's join link into the dashboard's
**Mødelink** box. There is deliberately no calendar listing: it would need
`Calendars.Read` — read access to the user's whole calendar — which is a far harder
consent for a municipality to grant than the three meeting-scoped permissions the rest
of the flow needs. `resolveJoinUrl()` gets subject and start/end off the
`onlineMeeting` itself, so nothing is lost. Danish copy for the route's error codes
lives in `src/components/dashboard/arm-error-message.ts`.

**Teams meeting state** (`teams_meetings.state`):
`awaiting_teams` → `ready` | `failed` | `needs_reauth`. The client-side meeting status gains
a matching `awaiting_teams`.

### Docker / deployment
`docker-compose.yml` at repo root defines three services: `db` (Postgres), `migrate`
(one-shot `drizzle-kit migrate`, which `app` waits on via
`condition: service_completed_successfully`) and `app` (Next.js, published on
`${APP_PORT:-8080}` → 3000). Audio files live on a named volume (`audio-storage`),
path configurable via `AUDIO_STORAGE_PATH`.

Overlays merge on top and are never used standalone: `docker-compose.ai.yml` adds the
GPU services (hviske, diarization, vllm-chat) and repoints the app at them,
`docker-compose.proxy.yml` is Syddjurs-specific TLS termination, and
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
| `OPENAI_API_KEY` | Chapters, minutes, clarifications generation, and PII detection |
| `AUDIO_STORAGE_PATH` | Filesystem path for audio files |
| `BETTER_AUTH_URL` / `BETTER_AUTH_SECRET` | better-auth base URL and signing secret |
| `EMAIL_PASSWORD_ENABLED` | Kill switch for email/password (default on) |
| `MICROSOFT_CLIENT_ID` / `_SECRET` / `_TENANT_ID` | Entra ID; enables itself when the id + secret are set |
| `OIDC_CLIENT_ID` / `_SECRET` / `_DISCOVERY_URL` | Generic OIDC provider (Keycloak, Authentik, …) |
| `OIDC_PROVIDER_ID` / `_NAME` | Callback path segment + account key / button label |
| `GRAPH_BASE_URL` | Microsoft Graph base URL (default `https://graph.microsoft.com/v1.0`) |
| `TEAMS_SPOKEN_LANGUAGE` | Language Teams transcribes in (default `da-DK`) |
| `TEAMS_ARTIFACT_MODE` | `prefer-recording` (default) or `transcript-only` |
| `TEAMS_POLL_INTERVAL_MS` | Graph poll interval (default `120000`) |
| `TEAMS_POLLER_DISABLED` | Set `true` to stop this instance from polling Graph |

## Testing conventions

- **Vitest** throughout; there is no second test runner.
- Component tests (`.test.tsx` in `src/components/`) run in `jsdom`; everything else runs in `node`.
- Test helpers: `src/test/helpers.ts` exports `FAKE_SESSION` and `makeJsonReq()`.
- API route tests mock `@/lib/db/user-schema` and `@/lib/auth` to avoid real DB/auth dependencies.
