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

**Meetings live in the browser, not in the database.** A meeting, its transcript, minutes (all versions) and audio are stored only in the user's IndexedDB (`src/lib/storage/`); the server holds no meeting data except the transient bot-recording stash (`src/lib/bot-pending-audio.ts`, deleted on hand-off or after a TTL). Consequently the audit events about meeting contents are reported by the browser (see the audit invariants below).

**Database — per-user PostgreSQL schemas**: Each user gets their own PostgreSQL schema (`u_<userId>`), created lazily on first access via `ensureUserSchema()` in `src/lib/db/user-schema.ts`. They hold the user's personal templates (`skabeloner`); the `meetings`, `transcripts`, `minutes`, `minute_versions` and `audio_files` tables that `ensureUserSchema` still creates are unused legacy (the only reader, `src/lib/data/meeting-page.ts`, was removed). The shared `public` schema holds only auth tables (better-auth). Because Drizzle cannot target dynamic schema names, **all per-user queries use raw SQL** via `queryUserSchema()` / `queryUserSchemaOne()` helpers — not Drizzle ORM. Schema migrations are implemented as idempotent `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN IF NOT EXISTS` statements inside `ensureUserSchema`. The one exception is the central tables (roles, org units, audit, central templates, below), which live in `public`.

**Auth**: Uses `better-auth`. `src/lib/auth/index.ts` builds the real instance (Drizzle adapter over the `public` schema); `src/middleware.ts` gates routes on the session cookie.

Which login methods exist is decided in one place — `src/lib/auth/providers.ts`. It reads `process.env` **inside** its functions (same idiom as `src/lib/skabeloner/share-config.ts`), and is consumed by both `auth/index.ts` (to register providers) and `src/app/(marketing)/page.tsx` (to render buttons), so the server and the UI can't disagree. Methods: email/password, Microsoft Entra ID (`socialProviders`), any number of generic OIDC providers (the `genericOAuth` plugin, `oidc-config.ts`) and SAML 2.0 providers (the `@better-auth/sso` plugin as `defaultSSO` entries, `saml.ts`; the plugin's database provider table and its management endpoints are disabled). Each installation (a municipality has its own IdP) describes them in ONE JSON file, `AUTH_CONFIG_FILE` (`src/lib/auth/config-file.ts`: zod-validated, `${ENV}` expansion, read once per process); without a file the legacy `OIDC_*` / `MICROSOFT_*` variables (`AUTHENTIK_*` deprecated) are synthesised into the same shapes, and a configured file replaces them entirely. An invalid provider entry is skipped with a content-free warning; an invalid `roles` section fails closed. Format and recipes: `docs/central-access/idp.md`. `samlify` is pinned to 2.13.1 with an `overrides` entry (advisories in the version the plugin brings); `saml-guard.ts` adds the audience, recipient and InResponseTo checks the plugin lacks, and any upgrade of the plugin or samlify must re-run `saml.flow.test.ts`.

Auth config is deliberately **runtime-only**, never `NEXT_PUBLIC_*`: an operator changes `.env` and restarts, with no image rebuild. That is why `(marketing)/page.tsx` sets `export const dynamic = 'force-dynamic'` — without it Next prerenders the page and freezes the provider list into the build-time RSC payload (`src/app/(marketing)/page.test.tsx` guards this).

**Central access control, Rollekatalog, audit log and central templates.** Roles, org units, the audit log and central templates live in the shared `public` schema and are accessed with **Drizzle** (`src/lib/db/schema.ts`), not per-user raw SQL; raw SQL against them must be schema-qualified (`public.table`).

Invariants (do not break these):
- **Fail closed.** Disabled users, unknown role keys, expired, stale or other-mode assignments, a NULL scope on a role that may not be global (`tt-bruger`) and an unresolvable principal grant nothing (403/404/503). A NULL scope on `tt-skabelonansvarlig`, `tt-logleser` and `tt-administrator` means GLOBAL (for `tt-skabelonansvarlig`: the superuser who manages every shared prompt; roles from IdP claims are always NULL-scoped). An invalid non-empty `ACCESS_SOURCE` (`local`, `rollekatalog`, `claims`) throws `ConfigError` (503); it never means `local`. `access.manage`, `sync.run` and `audit.export` need a GLOBAL assignment.
- **Roles are read live, never cached.** `resolvePrincipal` (`src/lib/authz/principal.ts`) hits the DB on every call; nothing role-related is in the session cookie. The only role matrix is `ROLE_DEFINITIONS` in `capabilities.ts`. In local mode a login is linked to a role holder only through `directory_users.app_user_id`, never by email.
- **Roles from claims (`ACCESS_SOURCE=claims`).** Rights are managed outside the app and sent with the login. At every OIDC/Entra/SAML login `claims-roles.ts` REPLACES, in one transaction, the person's `source='claims'` `role_assignments` (global, `synced_at=now()`) and their `user_external_roles`; a malformed claim, no claims, an unusable `roles` section (`roles.appRoleMap`/`groupRoleMap` in the auth config file) or a disabled person leave nothing, unknown claim values grant nothing, and password sign-ins clear the person's claims rows (a password account never has claims roles). Only values listed in `external_roles` (the catalogue; composite FK) are stored for a person, and role/group values are never put in `external_identities`, logs or audit events. `resolvePrincipal` counts claims rows only within `ROLE_CLAIMS_MAX_SECONDS` (default 8 h; the better-auth session lasts exactly that long and is never extended in this mode). The in-app role admin, local org units and bootstrap are behind the kill switch `ACCESS_LOCAL_ADMIN` (`localAdminEnabled()`: default on in local mode only, always off in rollekatalog/claims; writes answer 409 `read_only`). There is no in-app administrator in claims mode: break-glass is IdP-side.
- **Every route is gated.** Capability routes use `withAuthz(label, capability, handler)` (`guard.ts`); the other `/api` routes call `requireAppAccess()` (`app-access.ts`: 401/503/403); pages go through the `(app)` layout. Only `/api/health`, `/api/auth` and the secret-authenticated routes (bot callbacks, cron, feed) are exempt.
- **No content in the audit log.** Event types are a closed catalogue (`src/lib/audit/events/*.ts`, strict zod `details`); strings must match `/^[A-Za-z0-9_.:-]{1,64}$/`, entity ids are UUIDs, an invalid event is dropped. Never put titles, names, prompts, transcript text, file names, URLs or raw error messages in an event or a log line (use `safeLogError`). Central template writes call `recordEvent(event, { tx })` on the change's transaction; denials call `recordAuthzDenied`. The log records ACTIONS, never content: that minutes, a transcript or audio were viewed, edited, versioned, played, uploaded, exported or deleted (and logins, failed logins, recording steps, configuration changes), never what they contained, and never an instruction a person typed (`userInstruction` is a boolean) or names (counts only). Changes of rights and organisation (role assignments, org units, members, user links) are deliberately NOT audited; only denials are. **`meeting.*` events are client-reported and self-reported**: meetings exist only in the browser, so views, edits, versions, playback, local recording steps and local deletes are the user's own word, forgeable and not proof (the viewer says "selvrapporteret"); only what the server really sees (`audio.upload`, `minutes.generate`, `export.download`, bot, login, `bot.audio_delete`, `system.config_changed`) is reliable. Every new event needs entries in the exhaustive Records in `labels.da.ts`, `summary.da.ts` and `categories.ts`.
- **Rollekatalog is read-only and GET-only.** `src/lib/rollekatalog/client.ts` sends `ApiKey` GETs (organisation v3 with the ORG key, `roleAssignmentsWithContraints` with the READ key); the whitelisting zod schemas in `schemas.ts` keep cpr, nemloginUuid, phone and KLE out of our types (adding a field is a privacy decision). Keys never appear in logs, errors or audit details; failures are short codes. Scope is the org-unit constraint only; no usable scope means no row, unless the role is in `ROLLEKATALOG_GLOBAL_ROLES`. The sync runs in one transaction under an advisory lock, with empty-response and removal-threshold guards, disables missing users and deletes their sessions.
- **Last administrator.** Only local, global, started, permanent (`stop_date IS NULL`) administrator grants of enabled, login-capable users count as "another administrator" (`admin-sql.ts`, used by revoke and bootstrap). It concerns local grants only: claims mode has no in-app administrator to lock out.
- **AI/STT failure codes in the audit log are a closed set** (`http_<status>`, `timeout`, `network`, `unknown`); the server-emitted `minutes.generate` and `export.download` events have a per-actor ceiling in `emitAudit`. Pipeline steps (transcription, chapters, ...) and sync status are not events: the upload that starts them is (`audio.upload`). A failed-login burst is capped per IP and minute but never dropped silently (a `burst_summary` row counts the excess), and client-event limits answer with counts instead of dropping quietly.
- **Central prompts never reach non-managers.** `CentralSkabelonSummary` has no `prompt`; only `resolveCentralTemplate` reads it, and `/api/minutes` enforces the lock server-side, puts the prompt in the system message and scrubs verbatim echoes (`src/lib/ai/prompt-echo.ts`). Never log or audit prompts or change notes: `audit_events` holds none. The audit viewer (`/api/admin/audit`) shows a change note by looking it up in `central_template_versions` at read time (`src/lib/audit/change-notes.ts`), for audit readers only.
- **Migrations.** migrations `0001_central_access`, `0002_audit_events` and `0003_central_templates` in `drizzle/` are unreleased and were edited in place; once a release ships them, only add new migrations. `0004_claims_roles` (the `'claims'` source in the three `*_source_check`s, `external_roles`, `user_external_roles`) is a separate migration on purpose. The immutability triggers and the CHECKs that mirror the app's name and change-note rules are hand-appended or hand-kept (`schema.ts` and `0003` must stay in sync). Requires PostgreSQL 15+.

File map: `src/lib/auth/` (providers, config-file, oidc-config, saml, saml-guard, index), `src/lib/authz/` (capabilities, principal, guard, app-access, scope, bootstrap, directory-match, login-hook, claims-roles, claims-stash, external-roles, identity, access-admin, config), `src/lib/rollekatalog/` (client, schemas, mapper, scope, sync, sync-run, config, mock-server + `__fixtures__`), `src/lib/audit/` (events, record, authz-denied, client, client-ingest, query, prune, config), `src/lib/system/` (config-fingerprint, run once from `src/instrumentation.ts`), `src/lib/skabeloner/` (`central.ts` manager service, `resolve.ts` recipients), routes under `src/app/api/admin/{access,audit,central-templates}`, `api/internal/{audit/prune,rollekatalog/sync}`, `api/audit/{feed,client-events}`, admin UI in `src/components/admin/` and `src/app/(app)/admin/`.

Local simulation without a real Rollekatalog or IdP: `scripts/dev-sim/` (mock Rollekatalog, OIDC login, SAML login, LLM, control panel, `acceptance.ts` for Rollekatalog mode, `acceptance-claims.ts` for claims mode), described in `docs/central-access/dev-simulation.md`. `src/test/saml-idp.ts` is the signing SAML stand-in shared by `saml.flow.test.ts` and the simulation.

Docs: `docs/central-access/README.md` (architecture), `idp.md` (identity providers, SAML, roles from claims), `rollekatalog.md` (operator guide), `audit.md` (log, feed, retention), `templates.md` (central templates). Update the code and the doc together.

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

**Session management**: Sessions are held in a `Map<string, BotSession>` in-process. The bot drains active sessions on `SIGTERM`/`SIGINT` (90s timeout). The active session ID is kept on the browser-held meeting record (`StoredMeeting.botSession`).

### Docker / deployment
`docker-compose.yml` at repo root defines `db` (PostgreSQL 16), `migrate` (one-shot drizzle migrations), `app` (Next.js, container port 3000, published as `${APP_PORT:-8080}:3000`) and `bot-service` (internal only, port 3001). The bot-service container needs `shm_size: 2gb` for Chromium. Audio files are stored on a named Docker volume (`audio-storage`), path configurable via `AUDIO_STORAGE_PATH`. Scheduled work (audit prune, Rollekatalog sync) is a host or cluster cron calling the `/api/internal/*` routes with `X-Cron-Secret`; see `DEPLOY.md`.

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
| `AUTH_CONFIG_FILE` | JSON file with the identity providers (OIDC, Entra, SAML), the role-claim mapping and an optional role/group catalogue; replaces the three rows above |
| `ACCESS_SOURCE` | `local` (default) / `rollekatalog` / `claims` |
| `ACCESS_LOCAL_ADMIN` | `false` turns the in-app role admin off (local mode only; always off in the other modes) |
| `ROLE_CLAIMS_MAX_SECONDS` | Claims mode: how long a login's roles count, and how long the session lasts (default 28800) |

`DIRECTORY_USERID_TRANSFORM=strip-upn-domain` only accepts `<name>@<DIRECTORY_USERID_DOMAIN>` (exact domain, one `@`, no `#EXT#`); a blank domain means no match.

Central access, Rollekatalog and audit settings (`REQUIRE_ROLE_TO_LOGIN`, `BOOTSTRAP_ADMIN_EMAILS`, `DIRECTORY_*`, `ROLLEKATALOG_*`, `ROLE_STALE_MAX_SECONDS`, `AUDIT_*`, `AUTH_IP_HEADERS`, `INTERNAL_CRON_SECRET`): see `.env.example`. All are read at call time (`src/lib/*/config.ts`), so a restart is enough.

## Testing conventions

- **Vitest** for the Next.js app; **Playwright** for the bot-service (excluded from Vitest via `exclude: ['bot-service/**']`).
- Component tests (`.test.tsx` in `src/components/`) run in `jsdom`; everything else runs in `node`.
- Test helpers: `src/test/helpers.ts` exports `FAKE_SESSION` and `makeJsonReq()`.
- API route tests mock `@/lib/db/user-schema` and `@/lib/auth` to avoid real DB/auth dependencies.
- `*.pg.test.ts` need PostgreSQL >= 15 and are skipped unless `TEST_DATABASE_URL` is set. Use `describe.skipIf(!hasPg)` and `withFreshSchema()` from `src/test/pg.ts` (applies the migrations into a throwaway schema and drops it). Run them with `TEST_DATABASE_URL=postgres://user:pass@localhost:5432/scratch npx vitest run --no-file-parallelism .pg.test.ts`.
- Authz tests build principals with `makePrincipal()` / `FAKE_PRINCIPAL_ADMIN` from `src/test/helpers.ts`; the role matrix has a tripwire test in `src/lib/authz/capabilities.test.ts`. Audit writes are not mocked globally; tests that touch them mock `@/lib/audit/record` or `@/lib/audit/authz-denied` themselves.
- Under jsdom `new Blob()` cannot be passed to `new Response()`; build the body from bytes.
- CI: `.github/workflows/test.yml` runs `tsc --noEmit`, the unit lane, the Postgres lane on a `postgres:16` service, `npm run build` and the bot-service unit tests; `semantic.yml` validates PR titles (conventional commits).
