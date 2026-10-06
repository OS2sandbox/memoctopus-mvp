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

**Database — per-user PostgreSQL schemas**: Each user gets their own PostgreSQL schema (`u_<userId>`), created lazily on first access via `ensureUserSchema()` in `src/lib/db/user-schema.ts`. The shared `public` schema holds only auth tables (better-auth). Because Drizzle cannot target dynamic schema names, **all per-user queries use raw SQL** via `queryUserSchema()` / `queryUserSchemaOne()` helpers — not Drizzle ORM. Schema migrations are implemented as idempotent `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN IF NOT EXISTS` statements inside `ensureUserSchema`. The one exception is the central tables (roles, org units, audit, central templates, below), which live in `public`.

**Auth**: Uses `better-auth`. `src/lib/auth/index.ts` builds the real instance (Drizzle adapter over the `public` schema); `src/middleware.ts` gates routes on the session cookie.

Which login methods exist is decided in one place — `src/lib/auth/providers.ts`. It reads `process.env` **inside** its functions (same idiom as `src/lib/skabeloner/share-config.ts`), and is consumed by both `auth/index.ts` (to register providers) and `src/app/(marketing)/page.tsx` (to render buttons), so the server and the UI can't disagree. Three methods: email/password, Microsoft Entra ID (`socialProviders`), and one generic OIDC provider via the `genericOAuth` plugin — configured with `OIDC_*`, with `AUTHENTIK_*` honoured as a deprecated fallback.

Auth config is deliberately **runtime-only**, never `NEXT_PUBLIC_*`: an operator changes `.env` and restarts, with no image rebuild. That is why `(marketing)/page.tsx` sets `export const dynamic = 'force-dynamic'` — without it Next prerenders the page and freezes the provider list into the build-time RSC payload (`src/app/(marketing)/page.test.tsx` guards this).

**Central access control (Phase 1)** — roles and org units live in the **shared `public` schema** and are accessed with **Drizzle** (`src/lib/db/schema.ts`: `directory_users`, `org_units`, `org_unit_members`, `org_unit_substitutes`, `role_assignments`, `external_identities`, `sync_runs`), not per-user raw SQL. Any raw SQL against them must be schema-qualified (`public.table`). Overview for implementers: `docs/central-access/README.md`.

- **Principal / capabilities**: `resolvePrincipal(userId)` (`src/lib/authz/principal.ts`) reads the tables live on every call (no cache, nothing in the cookie) and feeds the pure `buildPrincipalFromAssignments` in `capabilities.ts`. That file holds the only role-to-capability matrix (`ROLE_DEFINITIONS`); four roles (`tt-bruger`, `tt-skabelonansvarlig`, `tt-logleser`, `tt-administrator`) and seven capabilities, three of them org-unit scoped. `permissions.ts` has pure predicates, `scope.ts` the cycle-safe, depth-capped org-tree queries.
- **Routes**: wrap with `withAuthz(label, capability, handler, { requireLocalSource })` from `src/lib/authz/guard.ts` instead of repeating the session check. Order is 401, disabled 403, missing capability 403, then 409 for local-provider writes while `ACCESS_SOURCE=rollekatalog`. A resource outside the caller's scope answers 404, not 403 (`notFoundOrForbidden`).
- **Source**: `ACCESS_SOURCE=local` (default) lets an administrator edit roles in the app; in `rollekatalog` mode the local write endpoints answer 409 and `resolvePrincipal` ignores leftover `source='local'` assignments (they could not be revoked); in local mode leftover `source='rollekatalog'` assignments are ignored likewise. See "Rollekatalog mode (Phase 3)" below. All settings are read at call time in `src/lib/authz/config.ts`.
- **Baseline**: unless `REQUIRE_ROLE_TO_LOGIN=true`, every non-disabled user implicitly holds `tt-bruger`, so existing users keep working with no assignment.
- **Identity link**: in local mode a role is tied to an app user **only** through `directory_users.app_user_id`, never by email (an email/password sign-up can claim any address). `matchDirectoryUser` (claim/email matching) runs only in rollekatalog mode and never for `provider_id = 'credential'`.
- **Bootstrap admin**: `BOOTSTRAP_ADMIN_EMAILS` grants `tt-administrator` once, in local mode, while no active administrator exists, and only for an SSO login that proves the address (Microsoft: single-tenant `MICROSOFT_TENANT_ID` + matching `tid`; other OIDC: `email_verified === true`). It runs from the `session.create.after` hook (`login-hook.ts`), which never throws.
- **Fail closed**: disabled directory users get 403 from `withAuthz` and "Ingen adgang" from the `(app)` layout (the older `/api` routes do not consult the principal yet); a NULL scope on `tt-skabelonansvarlig` covers no unit (only `tt-logleser`/`tt-administrator` may be global); `access.manage`, `sync.run` and `audit.export` only take effect from a global assignment, and `tt-administrator` cannot be scoped to a unit; unknown role keys, expired or future assignments grant nothing; org-tree walks cannot loop on bad data.
- **Audit seam**: admin writes and authz denials call `recordAdminAction(tx, event)` (inserts on the given transaction, throws so the change rolls back) and `recordAuthzDenied(event)` (best-effort, never rejects) from `src/lib/audit/seam.ts`. Since Phase 2 they persist to `public.audit_events` through `record.ts`; see "Audit log (Phase 2)" below.

**Rollekatalog mode (Phase 3)** — implemented: OS2rollekatalog is a **read-only authority** and the app mirrors it into the central tables. Operator guide and setup checklist: `docs/central-access/rollekatalog.md`. Everything lives in `src/lib/rollekatalog/`; settings are read at call time in `config.ts` (invalid values fall back to the safe default, nothing throws at import).

- **Never writes to Rollekatalog**: the client (`client.ts`) does GET only, sends the key in an `ApiKey` header, does not follow redirects, caps the response size and retries at most twice (timeout, 5xx/429, network; never 401/403/404). Two keys: `ROLLEKATALOG_READ_API_KEY` (client role READ_ACCESS: `roleAssignmentsWithContraints`, `rolesAsList`, `constraint`) and `ROLLEKATALOG_ORG_API_KEY` (client role ORGANISATION, which does not imply READ_ACCESS: `organisation/v3`, `v2/manager`). Only `scripts/rollekatalog-register.mjs` (dry-run by default, run once from a shell with a temporary ITSYSTEM key) ever creates anything in Rollekatalog.
- **Keys and errors**: keys never appear in logs, error messages, audit details or route responses. Failures are short codes only (`not_configured`, `insecure_url`, `unauthorized`, `forbidden`, `not_found`, `timeout`, `network`, `server_error`, `invalid_response`, `too_large`; Danish texts in `labels.da.ts`). The URL must be https (http only for localhost or `ROLLEKATALOG_ALLOW_HTTP=true`).
- **Privacy**: the zod schemas in `schemas.ts` whitelist fields (`.strip()`), so `cpr`, `nemloginUuid`, phone numbers and KLE data never enter our types or the database (guarded by tests). Do not add a field to a schema without a reason that survives that rule.
- **Sync** (`sync.ts`, `mapper.ts`, `scope.ts`, `sync-run.ts`): `runSync({ trigger, force?, actorUserId? })` never throws. Non-blocking Postgres advisory lock (a concurrent run returns `already_running`), fetch everything first, then ONE transaction; any failure rolls back. Only `source='rollekatalog'` rows are written or deleted, `source='local'` rows and `directory_users.app_user_id` are never touched. A user missing from the fetch is **disabled** (removed and disabled in Rollekatalog are not told apart); org units are never deleted (the schema has no stale flag); role assignments, members and substitutes follow the fetch exactly. Guards: `empty_response` (no users or no org units), `removal_threshold` (more than `ROLLEKATALOG_SYNC_MAX_REMOVAL_PERCENT` of enabled users or of assignments would go; only the admin button's `force` bypasses it). Every run writes a `sync_runs` row (status `success`/`failed`; the `aborted`/`error` result statuses are both stored as `failed`) and a `directory.sync` audit event (counts and codes only; source `system` for cron).
- **Scope derivation** (`deriveScope`, pure, `ROLLEKATALOG_SCOPE_STRATEGY`): `constraint` (default) uses the org-unit constraint values of the assignment, `constraint-or-manager` falls back to the units the user manages or substitutes, `manager` uses only those. A scope root covers its subtree unless `ROLLEKATALOG_SCOPE_DESCENDANTS=false`. Unknown unit uuids are ignored. **Fail closed**: Rollekatalog silently drops constraints that resolve to empty, so an assignment with no usable scope becomes global ONLY for roles in `ROLLEKATALOG_GLOBAL_ROLES` (default `tt-administrator`); every other role gets no row (counted as `assignmentsWithoutScope`). An assignment that names units of which none is known is never widened to global. `tt-administrator` is never scoped, `tt-bruger` needs no scope. Only the four `tt-*` role identifiers are mapped.
- **Staleness and mode symmetry** (`dropStaleAssignments`, `principal.ts`): a `source='rollekatalog'` assignment whose `synced_at` is older than `ROLE_STALE_MAX_SECONDS` (default 86400) is ignored, so elevated capabilities vanish while the implicit baseline `tt-bruger` stays (unless `REQUIRE_ROLE_TO_LOGIN`). `ACCESS_SOURCE=local` ignores `source='rollekatalog'` rows and `rollekatalog` mode ignores `source='local'` rows, because the other side could not edit or revoke them. The sync refreshes `synced_at` on every successful run, even when nothing changed.
- **Login refresh** (`login-refresh.ts`, called from `login-hook.ts` after identity capture and matching, rollekatalog mode only): `rolesAsList` for the matched user, at most 3 s and no retries, never throws and never blocks login beyond that. It can only **take access away**: `disabled=true` or a 404 disables the directory user, a role missing from the answer deletes that user's Rollekatalog rows for the role. It never grants (the answer has no scope). It needs only the READ key, and every call leaves an audit row in Rollekatalog.
- **Identity matching**: `DIRECTORY_USERID_TRANSFORM=strip-upn-domain` strips `@domain` from the claim before it is compared with `ext_user_id`. An app user whose link points at a `source='local'` row is moved to the matching Rollekatalog row in one transaction (mode switch); a link that belongs to a different app user is never taken (`conflict`).
- **Routes**: `POST /api/internal/rollekatalog/sync` (`cronGuard`: `X-Cron-Secret` = `INTERNAL_CRON_SECRET`, 404 when unset, never forced; no in-process timers anywhere), `POST /api/admin/access/sync` (`sync.run`, 409 unless `ACCESS_SOURCE=rollekatalog`, body `{ force?: boolean }`), `GET /api/admin/access/sync` (latest run summary; `sync.run` or `access.manage`), `POST /api/admin/access/rollekatalog/check` ("Test forbindelse", `sync.run`: calls each endpoint once and reports status, schema validity, counts and error code, no personal data and no keys). UI: `SyncStatus` on the admin overview. Optional compose service `rollekatalog-sync` (profile `rollekatalog`) calls the cron route on an interval.
- **Not verified**: everything was developed and tested against synthetic fixtures and an in-process mock (`mock-server.ts`, `scripts/mock-rollekatalog.mjs`), never against a live Rollekatalog. Run "Test forbindelse" against the real instance before go-live.

**Central templates (Phase 4)** — locked, centrally managed minutes prompts that a super user (`template.manage`, scoped to org units) delegates to the people beneath them. Recipients cannot edit them; managers can, and every change needs a change note. Operator and implementer guide: `docs/central-access/templates.md`. Personal templates (per-user `skabeloner` table) are unchanged and stay separate.

- **Tables** (public schema, Drizzle, migration `0003_central_templates`): `central_templates` (owner org unit with RESTRICT FK, prompt, four `include_*` flags, `allow_user_instruction`, `allow_toggle_overrides`, `status` active/archived, `current_version`), `central_template_targets` (unit + `include_descendants`) and `central_template_versions` (the changelog: mandatory `change_note` of 10-2000 chars, `change_type`, actor name snapshot, full content and targets snapshot). A hand-appended trigger makes the versions table append-only (no UPDATE, DELETE or TRUNCATE, no bypass; same limits as the audit table). No hard delete exists, only archive and restore.
- **Service layer** `src/lib/skabeloner/central.ts` (manager side, returns prompts, raw SQL through the injectable `SqlRunner`/schema so the pg lane can run it): one transaction per write holds the template row, targets, version row and the `central_template.*` audit event. Optimistic concurrency with `baseVersion` (`VersionConflictError`, 409 `version_conflict` with `currentVersion`). Targets must lie in the owner unit's subtree; anything outside the caller's `template.manage` scope is 404. Types in `central-types.ts`, strict zod schemas in `central-schemas.ts`.
- **Recipients and enforcement**: `src/lib/skabeloner/resolve.ts` (`listCentralForUser`, `resolveCentralTemplate`) uses a user's non-disabled linked directory user and a cycle-safe, depth-capped upward walk over org-unit membership; unlinked or disabled users receive nothing. The real enforcement is `POST /api/minutes`: with `skabelonSource: 'central'` it uses the stored prompt and flags, ignores the client's `customPrompt` unless `allow_user_instruction` and `include*` overrides unless `allow_toggle_overrides`, answers one identical 404 for unknown, archived and not-a-recipient, and returns `templateRef` (`{ source, id, version }`). `minutes.generate` audits `templateSource: 'central'` and `templateVersion`.
- **Prompt confidentiality**: ordinary users never get a central prompt. `GET /api/skabeloner` returns `centralSkabeloner` (`CentralSkabelonSummary`, no prompt field; the list SQL does not select the column). Never log or audit prompts or change notes. Flipping this is a code change (see `templates.md`).
- **Routes**: `src/app/api/admin/central-templates/**` (`withAuthz('template.manage')`, no `requireLocalSource`, `no-store`): list, create, `[id]` GET/PUT, `[id]/archive`, `[id]/restore`, `[id]/versions`, `scope`. The personal `/api/skabeloner/[id]/**` routes never see central ids (404). `deleteOrgUnit` answers 409 `has_central_templates` while a unit owns a template.
- **UI**: `/admin/skabeloner` (admin section `templates`) with `CentralTemplatesAdmin`, `CentralTemplateEditor`, `OrgUnitTargetPicker`, `TemplateVersionHistory` and `CentralTemplatesStateDialog` in `src/components/admin/`; user side in `TranscriptReview.tsx` (locked group, disabled toggles, hidden instruction box) and `SkabelonerList.tsx` (read-only section). `templateRef` is stored with the minutes in IndexedDB (`src/lib/storage/minutes.ts`) and shown in `MinutesEditor`.
- **Not verified**: `central.pg.test.ts` and `resolve.pg.test.ts` have never run against a real Postgres, and the UI was only tested with jsdom and mocked fetch.

**Audit log (Phase 2)** — activity metadata only, never content. Contract and operator guide: `docs/central-access/audit.md`.

- **Table**: `public.audit_events` (Drizzle `auditEvents`, migration `0002_audit_events`), append-only. A hand-appended trigger refuses UPDATE and TRUNCATE, and DELETE unless the transaction ran `set_config('audit.allow_prune','on',true)` (only `src/lib/audit/prune.ts` does). It guards against bugs and casual misuse, not against a DB superuser or the owning role. `actor_user_id` and `actor_org_unit_uuid` have no foreign keys, so rows outlive users and units.
- **Closed catalogue**: `src/lib/audit/events/{access,auth,template,central-template,ai,bot,meeting,audit}.ts`, aggregated in `events/index.ts`. Each entry declares sources, entity type, whether an entity id is required, and a `.strict()` zod `details` schema. A new event type name is a catalogue change; refining an existing event's details belongs to its domain file.
- **No-content rule**: details hold only enums, numbers, booleans, uuids and short codes. `record.ts` additionally requires every string to match `/^[A-Za-z0-9_.:-]{1,64}$/` (no whitespace), arrays of at most 32, depth 1, 2 KB; entity ids must be UUIDs. An invalid event is dropped with a content-free warning, never stored. Never put titles, names, prompt/transcript text, file names, URLs or raw error messages in an event or in a log line (use `safeLogError`, which prints error class, HTTP status and code only).
- **Usage**: `await recordServerEvent(req, { type, actorUserId, entityId, details })` for telemetry (best-effort, never throws; ip/UA/request id from the request via `request-context.ts`, which reuses `AUTH_IP_HEADERS`). `recordEvent(input, { tx })` inside a transaction throws on failure. Wrap routes in `withHandler` (adds an `x-request-id`).
- **Where events are emitted**: Phase 1 seam (`access.*`, `authz.denied`); better-auth hooks in `src/lib/auth/index.ts` + `src/lib/authz/login-hook.ts` (`auth.*`); `/api/skabeloner/**` (`template.*`); `central_template.*` from the service layer `src/lib/skabeloner/central.ts` on the same transaction as the change; `/api/minutes`, `/api/transcribe`, `/api/meetings/[id]/{utterance,transcribe-batches,diarize,chapters,clarifications}`, `/api/export/[id]` (AI and export events); `/api/bot/**` and `POST /api/bot/lifecycle` (`bot.*`; joined/ended/error come from the bot-service with source `system`).
- **Client events are self-reported**: `meeting.*` are reported by the storage layer (`src/lib/storage/*` via `src/lib/audit/client.ts` and an IndexedDB outbox) to `POST /api/audit/client-events`. Actor, time and IP come from the session, never the payload, but the user can forge or suppress them; the viewer labels them "selvrapporteret".
- **Volume**: no per-utterance flood (live transcription and clarifications polling are coalesced to one event per actor+meeting per hour, in memory, per instance; minutes/transcript/participants/rename edits to one per 30 s client-side; `auth.login_failed` throttled per IP).
- **Reading**: `/admin/log` and `GET /api/admin/audit` need `audit.read` (scoped readers only see rows whose `actor_org_unit_uuid` is in their scope; NULL-unit rows are global-only); `GET /api/admin/audit/export` needs `audit.export` (global-only) and records `audit.export` before returning the CSV. SIEM feed: `GET /api/audit/feed` and `/api/audit/feed/head` with `X-Audit-Key` (sha256 compared to `AUDIT_FEED_API_KEY_HASH`; 404 when unset; only rows older than `AUDIT_FEED_DELAY_SECONDS`, because bigserial ids can commit out of order). Retention: `POST /api/internal/audit/prune` with `X-Cron-Secret` (`INTERNAL_CRON_SECRET`; 404 when unset); nothing schedules it.
- **Tests**: `*.pg.test.ts` under `src/lib/audit/` (migration, triggers, scoped queries, feed bound) need `TEST_DATABASE_URL`. `src/test/setup.ts` globally mocks `@/lib/audit/seam`; `seam.test.ts` un-mocks it.

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
`docker-compose.yml` at repo root defines two services: `app` (Next.js, port 3002) and `bot-service` (internal only, port 3001). An optional `rollekatalog-sync` service (profile `rollekatalog`, a public curl image) calls the Rollekatalog sync route on an interval. The bot-service container needs `shm_size: 2gb` for Chromium. Audio files are stored on a named Docker volume (`audio-storage`), path configurable via `AUDIO_STORAGE_PATH`.

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
| `ACCESS_SOURCE` | `local` (default) or `rollekatalog`: who owns role assignments |
| `REQUIRE_ROLE_TO_LOGIN` | `true` shows "Ingen adgang" instead of the `(app)` pages to users without a role (API routes outside `/api/admin` and `/api/me` are not gated yet); default false gives everyone baseline `tt-bruger` |
| `BOOTSTRAP_ADMIN_EMAILS` | Comma list; first SSO login with such an address becomes `tt-administrator` (local mode, none exists yet) |
| `DIRECTORY_MATCH` / `DIRECTORY_USERID_CLAIM` | Rollekatalog mode: `userid-claim` (default) / `extuuid-claim` / `email`, and the ID-token claim to read (default `preferred_username`) |
| `DIRECTORY_USERID_TRANSFORM` | `none` (default) or `strip-upn-domain`: strip `@domain` from the login claim before matching `ext_user_id` |
| `ROLLEKATALOG_URL` | Rollekatalog base URL; must be https (http only for localhost or `ROLLEKATALOG_ALLOW_HTTP=true`); unset = integration not configured |
| `ROLLEKATALOG_READ_API_KEY` / `ROLLEKATALOG_ORG_API_KEY` | `ApiKey` keys of two API clients with client role READ_ACCESS and ORGANISATION; a sync needs both, the login refresh only the READ key. Secrets: never logged |
| `ROLLEKATALOG_ITSYSTEM_ID` / `ROLLEKATALOG_DOMAIN` | IT system identifier (default `os2taletiltekst`) / optional Rollekatalog domain (default: primary) |
| `ROLLEKATALOG_TIMEOUT_MS` / `ROLLEKATALOG_MAX_RESPONSE_BYTES` | Per request timeout (default 10000; the login refresh uses at most 3000) / response size cap (default 64 MiB) |
| `ROLLEKATALOG_ALLOW_HTTP` | `true` allows a plain-http URL on a non-local host (default false) |
| `ROLLEKATALOG_SCOPE_STRATEGY` / `ROLLEKATALOG_SCOPE_DESCENDANTS` | `constraint` (default) / `constraint-or-manager` / `manager`; whether a scope unit covers its subtree (default true) |
| `ROLLEKATALOG_GLOBAL_ROLES` | Roles that may be organisation-wide when an assignment has no usable scope (default `tt-administrator`; `none` for no role) |
| `ROLLEKATALOG_SYNC_MAX_REMOVAL_PERCENT` | A sync that removes more than this share of users or assignments aborts unless forced (default 30) |
| `ROLE_STALE_MAX_SECONDS` | Rollekatalog-sourced roles not refreshed for this long stop applying (default 86400) |
| `ROLLEKATALOG_SYNC_INTERVAL_SECONDS` | Read by docker compose only: interval of the optional `rollekatalog-sync` service (default 900, minimum 60) |
| `AUTH_IP_HEADERS` | Optional comma list of headers better-auth reads the client IP from (read at startup) |
| `AUDIT_STDOUT` | `true` also prints each audit event as one JSON line on stdout (default false) |
| `AUDIT_STORE_IP` | `false` stores no IP in the audit log (default true) |
| `AUDIT_RETENTION_DAYS` | Positive integer: prune events older than this via the prune route; unset/invalid keeps forever |
| `AUDIT_FEED_API_KEY_HASH` | Hex sha256 of the SIEM feed key (`X-Audit-Key`); feed answers 404 when unset |
| `AUDIT_FEED_DELAY_SECONDS` | The feed only serves rows older than this (default 10) |
| `INTERNAL_CRON_SECRET` | Secret (`X-Cron-Secret`) for `POST /api/internal/audit/prune` and `POST /api/internal/rollekatalog/sync`; both routes answer 404 when unset |

## Testing conventions

- **Vitest** for the Next.js app; **Playwright** for the bot-service (excluded from Vitest via `exclude: ['bot-service/**']`).
- Component tests (`.test.tsx` in `src/components/`) run in `jsdom`; everything else runs in `node`.
- Test helpers: `src/test/helpers.ts` exports `FAKE_SESSION` and `makeJsonReq()`.
- API route tests mock `@/lib/db/user-schema` and `@/lib/auth` to avoid real DB/auth dependencies.
- `*.pg.test.ts` need a real PostgreSQL 15+ and are skipped unless `TEST_DATABASE_URL` is set. Use `describe.skipIf(!hasPg)` and `withFreshSchema()` from `src/test/pg.ts`, which applies the migrations into a throwaway schema and drops it afterwards.
- Authz tests build principals with `makePrincipal()` / `FAKE_PRINCIPAL_ADMIN` from `src/test/helpers.ts`; the role matrix has a tripwire test in `src/lib/authz/capabilities.test.ts`.
