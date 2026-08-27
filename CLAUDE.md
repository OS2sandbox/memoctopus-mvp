# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development
```bash
npm run dev          # Start both Next.js (port 3004) and bot-service (port 3001) concurrently
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

Bot-service has its own test runner (Playwright, not Vitest):
```bash
cd bot-service && npm test       # Run Playwright tests
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

**Bot API routes** (`src/app/api/bot/`): Next.js acts as an authenticated proxy to the bot-service. All bot routes require a user session. The `/api/bot/audio-upload` route is the exception — it's called by the bot-service itself, authenticated via `BOT_INTERNAL_SECRET` (not a user session).

**Meeting status flow**: `joining` → `recording` → `processing` → `review` → `minutes` → `done` (also `redacted`, `cancelled`).

### 2. Bot service (`bot-service/`)

A standalone **Express + Playwright** TypeScript service that joins Microsoft Teams meetings as a headless Chromium browser, records audio, and POSTs the recording back to the Next.js app.

- `src/index.ts` — Express server with session lifecycle routes (`POST /sessions`, `GET /sessions/:id`, `POST /sessions/:id/pause`, `/resume`, `/stop`, `DELETE /sessions/:id`) and a `/health` endpoint.
- `src/teams-bot.ts` — `TeamsMeetingBot` class; drives Chromium via Playwright to join a Teams meeting URL, captures audio via WebRTC/MediaRecorder.
- `src/webrtc-patch.ts` — Browser-side JS injected into the Teams page to work around WebRTC compatibility issues with headless Chrome.

Bot-service authenticates all requests from the Next.js app via `Authorization: Bearer <BOT_INTERNAL_SECRET>`. It runs on port 3001 by default and is not exposed publicly in production (Docker internal network only).

**Session management**: Sessions are held in a `Map<string, BotSession>` in-process. The bot drains active sessions on `SIGTERM`/`SIGINT` (90s timeout). The `bot_session` column on the `meetings` table stores the active session ID; the sentinel value `'creating'` is used to prevent concurrent session creation for the same meeting.

### Docker / deployment
`docker-compose.yml` at repo root defines two services: `app` (Next.js, port 3002) and `bot-service` (internal only, port 3001). The bot-service container needs `shm_size: 2gb` for Chromium. Audio files are stored on a named Docker volume (`audio-storage`), path configurable via `AUDIO_STORAGE_PATH`.

## Key env vars

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `BOT_INTERNAL_SECRET` | Shared secret between Next.js and bot-service |
| `BOT_SERVICE_URL` | URL of bot-service from Next.js (e.g. `http://localhost:3001`) |
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

## Testing conventions

- **Vitest** for the Next.js app; **Playwright** for the bot-service (excluded from Vitest via `exclude: ['bot-service/**']`).
- Component tests (`.test.tsx` in `src/components/`) run in `jsdom`; everything else runs in `node`.
- Test helpers: `src/test/helpers.ts` exports `FAKE_SESSION` and `makeJsonReq()`.
- API route tests mock `@/lib/db/user-schema` and `@/lib/auth` to avoid real DB/auth dependencies.
