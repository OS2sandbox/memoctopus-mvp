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

**Meetings live in the browser, not in the database.** A meeting, its transcript, minutes (all versions) and audio are stored only in the user's IndexedDB (`src/lib/storage/`); the server holds no meeting data except the transient Teams hand-off stash (`src/lib/pending-artifacts.ts`, below; deleted when the browser acknowledges it, or by the TTL sweep). Consequently the audit events about meeting contents are reported by the browser (see the audit invariants below).

**Database — per-user PostgreSQL schemas**: Each user gets their own PostgreSQL schema (`u_<userId>`), created lazily on first access via `ensureUserSchema()` in `src/lib/db/user-schema.ts`. They hold the user's personal templates (`skabeloner`, `skabelon_versions`) and `skabelon_central_default` (at most one row: the person's chosen central default template, a plain uuid pointer used only while that template is still available to them; the default is one personal flag OR this, `GET /api/skabeloner` and the personal `POST`/`PUT` answers mark the effective one, `src/lib/skabeloner/effective-default.ts`) and the Teams registration and onboarding tables (`teams_meetings`, `teams_meeting_snapshots`, `onboarding_progress`, `onboarding_state`) and nothing else: `ensureUserSchema` no longer creates the old `meetings`, `transcripts`, `minutes`, `minute_versions`, `audio_files` and JSONB `templates` tables, the `meeting_status` enum or the `prune_old_versions` trigger. Schemas created by older versions may still contain them (empty, unused); they are never dropped automatically. The shared `public` schema holds only auth tables (better-auth). Because Drizzle cannot target dynamic schema names, **all per-user queries use raw SQL** via `queryUserSchema()` / `queryUserSchemaOne()` helpers — not Drizzle ORM. Schema migrations are implemented as idempotent `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN IF NOT EXISTS` statements inside `ensureUserSchema`. The one exception is the central tables (roles, org units, audit, central templates, below), which live in `public`.

**Auth**: Uses `better-auth`. `src/lib/auth/index.ts` builds the real instance (Drizzle adapter over the `public` schema); `src/middleware.ts` gates routes on the session cookie.

Which login methods exist is decided in one place — `src/lib/auth/providers.ts`. It reads `process.env` **inside** its functions (same idiom as `src/lib/skabeloner/share-config.ts`), and is consumed by both `auth/index.ts` (to register providers) and `src/app/(marketing)/page.tsx` (to render buttons), so the server and the UI can't disagree. Methods: email/password, Microsoft Entra ID (`socialProviders`), any number of generic OIDC providers (the `genericOAuth` plugin, `oidc-config.ts`) and SAML 2.0 providers (the `@better-auth/sso` plugin as `defaultSSO` entries, `saml.ts`; the plugin's database provider table and its management endpoints are disabled). Each installation (a municipality has its own IdP) describes them in ONE JSON file, `AUTH_CONFIG_FILE` (`src/lib/auth/config-file.ts`: zod-validated, `${ENV}` expansion, read once per process); without a file the legacy `OIDC_*` / `MICROSOFT_*` variables (`AUTHENTIK_*` deprecated) are synthesised into the same shapes, and a configured file replaces them entirely. An invalid provider entry is skipped with a content-free warning; an invalid `roles` section fails closed. Format and recipes: `docs/central-access/idp.md`. `samlify` is pinned to 2.13.1 with an `overrides` entry (advisories in the version the plugin brings); For a single-tenant Entra provider (`overrideUserInfoOnSignIn`) `entra-user-info.ts` vets the email and `emailVerified` before better-auth writes them (another user's address is not taken over, a verified user stays verified); `entraSocialConfig` applies it inside its own `getUserInfo`, because better-auth never calls `mapProfileToUser` when `getUserInfo` is supplied. ``saml-guard.ts` adds the audience, recipient and InResponseTo checks the plugin lacks, and any upgrade of the plugin or samlify must re-run `saml.flow.test.ts`.

With one named tenant (`MICROSOFT_TENANT_ID`), the stored name and email follow Entra on every sign-in (`overrideUserInfoOnSignIn`). `src/lib/auth/entra-user-info.ts` vets the claims first (as the provider's `mapProfileToUser`): an email another user row already holds is not taken over — `users.email` is UNIQUE and the failed write would lock the user out — and a verified user is never downgraded.

Auth config is deliberately **runtime-only**, never `NEXT_PUBLIC_*`: an operator changes `.env` and restarts, with no image rebuild. That is why `(marketing)/page.tsx` sets `export const dynamic = 'force-dynamic'` — without it Next prerenders the page and freezes the provider list into the build-time RSC payload (`src/app/(marketing)/page.test.tsx` guards this).

**Central access control, Rollekatalog, audit log and central templates.** Roles, org units, the audit log and central templates live in the shared `public` schema and are accessed with **Drizzle** (`src/lib/db/schema.ts`), not per-user raw SQL; raw SQL against them must be schema-qualified (`public.table`).

**Three roles** (OS2ai: Admin / Bygger / Bruger; the only definition is `ROLE_DEFINITIONS` in `capabilities.ts`, labels in `labels.da.ts`). The RoleKeys `admin`, `bygger`, `bruger` are also the role identifiers in Rollekatalog and the values in the IdP role mapping; the exact identifiers OS2ai uses are unverified.

| Role | Capabilities | Scope |
|---|---|---|
| `admin` (Admin) | all: `template.use`, `template.manage`, `audit.read`, `audit.export`, `access.manage`, `sync.run` | always global; the only role that reads the log |
| `bygger` (Bygger) | `template.use`, `template.manage` | org units (local / Rollekatalog), or global with a NULL scope (claims) |
| `bruger` (Bruger) | `template.use` | none; no Administration tab |

Invariants (do not break these):
- **Fail closed.** Disabled users, unknown role keys, expired, stale or other-mode assignments and an unresolvable principal grant nothing (403/404/503). Each role's `scope` in `ROLE_DEFINITIONS` (`none` / `optional` / `global-only`) is the one rule for org units: a NULL-scoped `bruger` (`none`) is the normal unscoped grant of `template.use`. A NULL scope on `bygger` and `admin` means GLOBAL (for `bygger`: the superuser who manages every shared prompt; roles from IdP claims are always NULL-scoped). `admin` is never scoped to a unit (a grant for one unit is refused, and in Rollekatalog mode a constraint on it is ignored). An invalid non-empty `ACCESS_SOURCE` (`local`, `rollekatalog`, `claims`) throws `ConfigError` (503); it never means `local`. `access.manage`, `sync.run`, `audit.read` and `audit.export` need a GLOBAL assignment (there is no per-unit view of the log).
- **Roles are read live, never cached.** `resolvePrincipal` (`src/lib/authz/principal.ts`) hits the DB on every call; nothing role-related is in the session cookie. The only role matrix is `ROLE_DEFINITIONS` in `capabilities.ts`. In local mode a login is linked to a role holder only through `directory_users.app_user_id`, never by email.
- **Roles from claims (`ACCESS_SOURCE=claims`).** Rights are managed outside the app and sent with the login. At every OIDC/Entra/SAML login `claims-roles.ts` REPLACES, in one transaction, the person's `source='claims'` `role_assignments` (global, `synced_at=now()`) and their `user_external_roles`; a malformed claim, no claims, an unusable `roles` section (`roles.byProvider.<id>.{appRoleMap,groupRoleMap}` in the auth config file; the global `appRoleMap`/`groupRoleMap` apply only when the file lists exactly ONE provider entry (a skipped or disabled entry still counts), otherwise a provider without a map grants nothing) or a disabled person leave nothing, unknown claim values grant nothing, and password sign-ins clear the person's claims rows (a password account never has claims roles). Claims mode is closed by default: password sign-in is hard-wired off and sign-up closed (`EMAIL_PASSWORD_ENABLED` is ignored there), `REQUIRE_ROLE_TO_LOGIN` defaults to true (ordinary users must be mapped to `bruger`), Entra needs one tenant GUID, an OIDC provider may not use a multi-tenant authority and its id token `iss`/`aud` are checked before any claim is read. Provider tokens are NOT kept (one exception: the `microsoft` account's access and refresh tokens, encrypted, only while `TEAMS_GRAPH_ENABLED=true`, because the Teams poller needs them; OIDC and SAML accounts are always scrubbed in full; the Microsoft id token is nulled again after every Graph token call, `scrubMicrosoftIdToken`, because a refresh stores a fresh one): the claims travel in memory from the profile mapper to the login hook (`claims-stash.ts`, no id_token fallback), and `scrubAccountTokens` nulls `accounts.id_token/access_token/refresh_token` after every login. The account-link endpoints (`/oauth2/link`, `/link-social`, `/unlink-account`) are always in `disabledPaths` (`auth/index.ts`): their callback would store those tokens without a session, so the scrub would never run. Only values listed in `external_roles` (the catalogue; composite FK) are stored for a person, and role/group values are never put in `external_identities`, logs or audit events. `resolvePrincipal` counts claims rows only within `ROLE_CLAIMS_MAX_SECONDS` (default 8 h; the better-auth session lasts exactly that long and is never extended in this mode). The in-app role admin, local org units and bootstrap are behind the kill switch `ACCESS_LOCAL_ADMIN` (`localAdminEnabled()`: default on in local mode only, always off in rollekatalog/claims; writes answer 409 `read_only`). There is no in-app administrator in claims mode: break-glass is IdP-side.
- **Every route is gated.** Capability routes use `withAuthz(label, capability, handler)` (`guard.ts`); the other `/api` routes call `requireAppAccess()` (`app-access.ts`: 401/503/403); the Outlook add-in's routes, which have an Entra token instead of a session, call `requireAddinUser()` (`src/lib/outlook/addin-gate.ts`: the token, then the same live check through `appAccessForUser`); pages go through the `(app)` layout. Only `/api/health`, `/api/auth`, `/api/outlook/config` (the public client and tenant id) and the secret-authenticated cron routes are exempt.
- **No content in the audit log.** Event types are a closed catalogue (`src/lib/audit/events/*.ts`, strict zod `details`); strings must match `/^[A-Za-z0-9_.:-]{1,64}$/`, entity ids are UUIDs, an invalid event is dropped. Never put titles, names, prompts, transcript text, file names, URLs or raw error messages in an event or a log line (use `safeLogError`). Central template writes call `recordEvent(event, { tx })` on the change's transaction; denials call `recordAuthzDenied`. There is no pull feed: a log shipper reads the `AUDIT_STDOUT` mirror (a line may exist for a transaction that later rolls back). Logout, meeting creation and a separate redact event are not logged (a redaction is `meeting.transcript_delete` plus `meeting.audio_delete`); participant and speaker edits are `meeting.metadata_edit` with `field` and a count. The log records ACTIONS, never content: that minutes, a transcript or audio were viewed, edited, versioned, played, uploaded, exported or deleted (and logins, failed logins, recording steps, configuration changes), never what they contained, and never an instruction a person typed (`userInstruction` is a boolean) or names (counts only). Changes of rights and organisation (role assignments, org units, members, user links) are deliberately NOT audited; only denials are. **`meeting.*` events are client-reported and self-reported**: meetings exist only in the browser, so views, edits, versions (a restore is `meeting.minutes_version` with `action: restore`), playback, local recording steps and local deletes are the user's own word, forgeable and not proof (the viewer says "selvrapporteret"). The browser reports an outcome of `success` or `error` only (`reportAuditEvent(..., { outcome: 'error' })` where it sees a write, delete or recorder start fail; never `denied`, the route refuses it), and a user delete that cannot be queued is counted as `audit.events_dropped` (`client_outbox`); only what the server really sees (`audio.upload`, `minutes.generate`, `export.download`, `teams.*`, login, `system.config_changed`, `integration.sync_run`) is reliable. **Integration runs and refusals are logged too:** `integration.sync_run` (kind `org_sync`/`role_catalogue`, trigger `cron`/`manual`, status, a closed code and the run's COUNTS only; recorded by the four routes that start a Rollekatalog run via `src/lib/rollekatalog/run-audit.ts`, never who got or lost which role) and, for refused central template writes (`central.ts`: out of scope, `principal_targets_need_*`, `org_wide_needs_global`, `version_conflict`), an `authz.denied` row (`required: template.manage`) written after the rollback, with the identical 404 for out-of-scope templates unchanged. `system.config_changed` also detects a rotated secret through a keyed digest (HMAC with a key derived from `BETTER_AUTH_SECRET`, stored in `system_flags.secretDigests`, never in an event; only the setting NAME reaches `changedKeys`). Every new event needs entries in the exhaustive Records in `labels.da.ts`, `summary.da.ts` and `categories.ts`.
  - **Teams (Graph) events are server-reported (reliable) and content-free:** `teams.meeting_register` / `teams.meeting_unregister` (from the dashboard and the Outlook add-in alike; arming PATCHes the person's Teams meeting options on their behalf: booleans, the closed arm result and a closed failure code), `teams.artifacts_fetch` (the poller or a forced poll fetched, or finally failed to fetch, the transcript/recording: trigger, result, two booleans, closed code; a poll that finds nothing yet is not an event), `teams.recording_delete` (the recording removed from the organizer's OneDrive: the closed final status) and `teams.stash_delete` (the server-held transcript deleted on hand-off or by the TTL sweep); emitted only through `src/lib/teams/audit.ts` (best-effort, capped wait, never throws), the entity is the meeting only when its id is a UUID, and never a subject, join URL, Graph id, name or error message (codes from `failure-code.ts`).
- **Rollekatalog is read-only and GET-only.** `src/lib/rollekatalog/client.ts` sends `ApiKey` GETs (organisation v3 with the ORG key, `roleAssignmentsWithContraints` and the role catalogue lists `/api/read/userroles/itsystems` and `/api/read/rolegroups` with the READ key; the catalogue paths are configurable, only under `/api/read/`, and unverified against a live instance); the whitelisting zod schemas in `schemas.ts` keep cpr, nemloginUuid, phone and KLE out of our types (adding a field is a privacy decision). Keys never appear in logs, errors or audit details; failures are short codes. Scope is the org-unit constraint only; no usable scope means no row, unless the role is in `ROLLEKATALOG_GLOBAL_ROLES`. The sync runs in one transaction under an advisory lock, with empty-response and removal-threshold guards, disables missing users and deletes their sessions. The **role catalogue refresh** (`catalogue-sync.ts`, `POST /api/internal/rollekatalog/roles` and the admin button) keeps only kind, identifier and name (adding a field is a privacy decision), has the same guards, and only ever DEACTIVATES entries: never deletes one that a person's role row or a template target references.
- **Last administrator.** Only local, global, started, permanent (`stop_date IS NULL`) administrator grants of enabled, login-capable users count as "another administrator" (`admin-sql.ts`, used by revoke and bootstrap). It concerns local grants only: claims mode has no in-app administrator to lock out.
- **AI/STT failure codes in the audit log are a closed set** (`http_<status>`, `timeout`, `network`, `unknown`); the server-emitted `minutes.generate` and `export.download` events have no volume limit, except the refused-central-template `minutes.generate` (`denied`, no LLM call behind it), which is capped per person and minute with the excess counted as `audit.events_dropped` (`rate_limit`). Pipeline steps (transcription, chapters, ...) are not events: the upload that starts them is (`audio.upload`); a Rollekatalog run is one `integration.sync_run`, its status panel (`sync_runs`) is not. A failed-login burst is capped per IP and minute but never dropped silently (a `burst_summary` row counts the excess), and so is an `authz.denied` flood. Every limit that makes the log skip events (the per-user daily cap, the rate limit and the browser's own outbox losses) is counted and reported as an `audit.events_dropped` row (`src/lib/audit/dropped.ts`, a closed `reason` and a `count`); client-event limits also answer with counts. Live audio is logged at most once per person and meeting per 5 minutes by design.
- **Shared prompts by role/group, org-wide templates.** A central template may have NO owner org unit (`owner_org_unit_uuid IS NULL` = organisation-wide, the only kind that exists in claims mode, where there are no org units): only a manager with a GLOBAL `template.manage` may create, see, edit, archive, restore or retarget it; to a scoped manager it does not exist (404, absent from the list). Role/group targets (`central_template_principal_targets`, composite RESTRICT FK to the catalogue) are for global managers only, can only be ADDED in `ACCESS_SOURCE=claims` (409 `principal_targets_need_claims`), and every newly added one must be an active catalogue entry; a scoped manager can neither update, archive nor restore a template that has them (403 `principal_targets_need_global`). The catalogue and the targets show `holders`, a COUNT of fresh logins holding the entry (never who), so a target that cannot match is visible. The recipient predicate `audienceSql` (`resolve.ts`, shared by the list and `resolveCentralTemplate`, so a non-recipient gets the identical 404) is an OR of the org-unit branch (dormant) and the role/group branch: a fresh `user_external_roles` row (`ROLE_CLAIMS_MAX_SECONDS`) of a linked, non-disabled person for an ACTIVE catalogue entry, only in `ACCESS_SOURCE=claims`. Role and group names/identifiers NEVER enter audit events or logs (`principalTargetCount` only); they live in the append-only changelog (`principal_targets`) and the manager screens. "Delete a shared prompt" is archive (provisional, flagged to the client): versions are append-only, there is no hard delete.
- **Personal template changelog.** `skabelon_versions` in the person's OWN schema holds an optional note per edit, the changed field names and a version number (no copy of the prompt, never pruned: audit events reference the version); the update and its entry are one transaction under a row lock (`updateSkabelonWithHistory`, `withUserSchemaTx`), a failing changelog write never loses the edit or its `template.update` event, which audits only `hasChangeNote: boolean` and the history `version`, never the note (administrators, the only log readers, get it through the read-time lookup, never from `audit_events`).
- **Central prompts never reach non-managers.** `CentralSkabelonSummary` has no `prompt`; only `resolveCentralTemplate` reads it, and `/api/minutes` enforces the lock server-side, puts the prompt in the system message and scrubs verbatim echoes (`src/lib/ai/prompt-echo.ts`). Never log or audit prompts or change notes: `audit_events` holds none. The audit viewer (`/api/admin/audit`) and the CSV export (`/api/admin/audit/export`, column "Ændringsbeskrivelse") show a change note by looking it up at read time (`src/lib/audit/change-notes.ts`): in `central_template_versions` for central templates and, for a personal `template.update`, in the acting person's own `skabelon_versions` by the `version` the event carries. Audit readers only; a lookup failure degrades the viewer (no notes) but refuses the export.
- **Migrations.** migrations `0001_central_access`, `0002_audit_events` and `0003_central_templates` in `drizzle/` are unreleased and were edited in place; once a release ships them, only add new migrations. `0004_claims_roles` (the `'claims'` source in the three `*_source_check`s, `external_roles`, `user_external_roles`) and `0005_shared_prompt_targets` (the optional template owner, `central_template_principal_targets`, `central_template_versions.principal_targets` with a CHECK that it is an array; idempotent, because its statements were first folded into a 0004 that scratch databases had already applied) are separate migrations on purpose and, like the others, unreleased. `0006_three_roles` renames the stored role keys of `role_assignments` (`tt-administrator`→`admin`, `tt-skabelonansvarlig`→`bygger`, `tt-bruger`→`bruger`) and deletes the removed `tt-logleser` rows; it is idempotent. The immutability triggers are hand-appended (`schema.ts` and `0003` must stay in sync); the name and change-note CHECKs are plain length bounds (the meaningful-character rule is app-side only). The personal-template share link and its `public.shared_skabeloner` table are kept (opt-in via `SKABELON_SHARE_LINK=true`; code sharing is on unless `SKABELON_SHARE_CODE=false`). Requires PostgreSQL 15+.

File map: `src/lib/auth/` (providers, config-file, oidc-config, saml, saml-guard, index), `src/lib/authz/` (capabilities, principal, guard, app-access, scope, bootstrap, directory-match, login-hook, claims-roles, claims-stash, external-roles, identity, access-admin, config), `src/lib/rollekatalog/` (client, schemas, mapper, scope, sync, sync-run, catalogue-sync, config, mock-server + `__fixtures__`), `src/lib/audit/` (events, record, authz-denied, client, client-ingest, query, prune, config), `src/lib/system/` (config-fingerprint, run once from `src/instrumentation.ts`), `src/lib/skabeloner/` (`central.ts` manager service, `resolve.ts` recipients), routes under `src/app/api/admin/{access,audit,central-templates}` (incl. `central-templates/roles`), `api/internal/{audit/prune,rollekatalog/sync,rollekatalog/roles}`, `api/audit/client-events`, admin UI in `src/components/admin/` and `src/app/(app)/admin/`.

Local simulation without a real Rollekatalog or IdP: `scripts/dev-sim/` (mock Rollekatalog, OIDC login, SAML login, LLM, control panel, `acceptance.ts` for Rollekatalog mode, `acceptance-claims.ts` for claims mode), described in `docs/central-access/dev-simulation.md`. `src/test/saml-idp.ts` is the signing SAML stand-in shared by `saml.flow.test.ts` and the simulation.

Docs: `docs/central-access/README.md` (architecture), `idp.md` (identity providers, SAML, roles from claims), `rollekatalog.md` (operator guide), `audit.md` (log, retention), `templates.md` (central templates). Update the code and the doc together.

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
`/pending-transcript` (the segments). Both GETs are read-only and can be repeated (a
`failed` stash too: a retry reads the same verdict, and the sweep bounds it). The
record is deleted by `DELETE /api/meetings/[id]/pending-transcript`, which the browser
calls once it has saved the transcript to IndexedDB (audited as `teams.stash_delete`
`handoff`), or, if it is never acknowledged, by the TTL sweep (1 hour, run every 5
minutes by `pending-sweeper.ts`; `teams.stash_delete` `ttl`). A ready transcript can
therefore stay on the server's disk for up to about an hour. All of them are gated by
`requireAppAccess()`, and additionally check an owner file, so one
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
  returns `armed | armed_in_progress | armed_late | not_organizer | policy_blocked`.
  `disarmMeeting()` restores the options snapshotted before the PATCH. **`armed_in_progress`
  means only "Graph gave this meeting no window"** (an instant meeting or a personal meeting
  link) — not that the meeting is running. Delegated Graph has no roster and no in-progress
  flag, so the two are indistinguishable, and such a link is routinely pasted in before
  anyone joins, where `recordAutomatically` works fine. The screen therefore leads with
  "OS2taletiltekst er slået til" and offers the manual start as a condition, never as a
  fact. **`armed_late`** is a booked meeting switched on 15 minutes or less before its
  start, or after it (`isLateArm()`): people may already be in it, and a running meeting
  ignores `recordAutomatically`. The screen states the manual start ("Start optagelse") at
  once, because the poller does not look at a booked meeting before its end. Whatever is
  recorded, from whenever it starts, is collected afterwards like any armed meeting.
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
  run never fetched. More than one file of that size deletes nothing; a meeting recorded
  in stretches deletes each of its sizes (`recording_sizes`). The poller
  owns the orchestration (`cleanUpRecording()`): the delete is queued
  (`recording_cleanup = 'pending'`, `queueRecordingCleanup`) only when the browser
  acknowledges the transcript (`DELETE /api/meetings/[id]/pending-transcript`), because
  until then an uncollected meeting is re-collected from that recording; it is then
  retried every tick for a day, audited once with its final status
  (`teams.recording_delete`), and never changes the meeting's state. Switching a
  meeting off (`unregisterTeamsMeeting` in `register.ts`, shared by
  `DELETE /api/teams/meetings/[id]` and the Outlook add-in) deletes a queued recording
  first; if OneDrive cannot be reached the row is kept out of sight
  (`unregistered_at`) until the poller has done it. It also removes the stash via
  `acknowledgePendingTranscript`. A run that was still transcribing when the row was
  deleted removes the stash itself and leaves the recording in OneDrive (that person
  never got the transcript), with no `teams.artifacts_fetch` event. A row whose recording is gone passes
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
  **A meeting recorded in stretches** (recording or transcription stopped and started
  again) has one artifact per stretch. `selectArtifacts()` takes all of them — everything
  in the window, or without one the newest sitting (`SESSION_GAP_MS`) — and
  `runStretches()` places each on the meeting's clock by its Graph span (`timeline.ts`),
  transcribes every recording along the cues inside it (or diarizes it under a scratch
  stash id when no cue is), keeps Teams' text for transcribed-only stretches, and joins
  the parts. One recording and one transcript still take the original single-pair path.
  Every recording we transcribed is listed in `recording_sizes` and deleted. The recording
  grace is measured from when Teams' transcript ended, not by attempts.
  Stretches Teams publishes after the meeting was collected are not in it; "Hent igen"
  collects again from everything Graph then holds.
- `store.ts` — raw-SQL CRUD over the per-user `teams_meetings` table (same per-user schema
  rules as everything else), plus the polling-due predicate and backoff.
- `poller.ts` — `pollMeeting()` / `pollDueMeetings()`; started from `src/instrumentation.ts`
  inside the Next.js server process and serialised across instances by a Postgres advisory
  lock. Off unless `TEAMS_GRAPH_ENABLED=true`; also disabled under test and via
  `TEAMS_POLLER_DISABLED`. It acts without a session on the stored Microsoft token, so
  `pollUser` first skips every person whose `directory_users` row is `disabled` (no
  Graph call, poll or recording cleanup; a failing lookup skips the person for the tick;
  no row means not disabled; never `loginRefusal`, since claims snapshots lapse by design).
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
`${APP_PORT:-8080}` → 3000). The Teams hand-off stash lives on a named volume
(`audio-storage`), path configurable via `AUDIO_STORAGE_PATH`. The app also mounts
`${AUTH_CONFIG_DIR:-./auth-config}` read-only at `/config`, where `AUTH_CONFIG_FILE`
(e.g. `/config/auth.json`) and the SAML metadata/certificates it points at live.
Scheduled work (audit prune, Rollekatalog sync and role catalogue) is a host or cluster
cron calling the `/api/internal/*` routes with `X-Cron-Secret`; see `DEPLOY.md`.

Overlays merge on top and are never used standalone: `docker-compose.ai.yml` adds the
GPU services (hviske, diarization, vllm-chat) and repoints the app at them,
`docker-compose.proxy.yml` is TLS termination for one specific deployment (its host
name and certificate are hard-coded in `nginx/nginx.conf`; it gives the diarize route a
3600 s read timeout), and
`docker-compose.tunnel.yml` reaches a remote diarization service over ssh.

**The app only receives variables listed explicitly in `app.environment`.** There is no
`env_file:`, so adding a variable to `.env` without adding it there leaves it unset in
the container.

**Two env templates.** `.env.example` is the complete reference: every variable with its
default and meaning, including the compose-only block at its end (development and a
hand-made compose deployment both start from it). `.env.deploy.example` is the shorter,
server-oriented template that `scripts/bootstrap-host.sh` copies onto a server; its last
block carries the central-access/audit variables with safe blank defaults and points back
to `.env.example`. Keep the two in step when adding a variable.

## Env vars

`.env.example` is the reference that lists every variable with its default and meaning (the compose-only variables are in its last block); `.env.deploy.example` is the server-oriented subset (see "Two env templates" above). Everything except `NEXT_PUBLIC_APP_URL` is read at runtime (`src/lib/*/config.ts`, `providers.ts`), so a restart is enough. The ones that shape the architecture (the table below adds the Teams/Graph and sign-in ones): `DATABASE_URL`, `BETTER_AUTH_URL` / `BETTER_AUTH_SECRET`, `AUTH_CONFIG_FILE` (identity providers, role-claim mapping, optional catalogue; replaces the legacy `OIDC_*` / `MICROSOFT_*` / `AUTHENTIK_*` variables), `ACCESS_SOURCE` (`local` default / `rollekatalog` / `claims`), `ACCESS_LOCAL_ADMIN`, `ROLE_CLAIMS_MAX_SECONDS`, `REQUIRE_ROLE_TO_LOGIN`, `EMAIL_PASSWORD_ENABLED` (local / rollekatalog mode only; ignored, always off, in claims mode), `INTERNAL_CRON_SECRET`, `HVISKE_*` (STT; `HVISKE_URL`, `_API_KEY`, `_MODEL`, default `syvai/hviske-ensemble`), `OPENAI_API_KEY`, `AUDIO_STORAGE_PATH` (transient Teams hand-off stash).

`DIRECTORY_USERID_TRANSFORM=strip-upn-domain` only accepts `<name>@<DIRECTORY_USERID_DOMAIN>` (exact domain, one `@`, no `#EXT#`); a blank domain means no match.

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
| `GRAPH_BASE_URL` | Microsoft Graph base URL (default `https://graph.microsoft.com/v1.0`). Only https on a Microsoft Graph host (national clouds) or localhost (the mock server) is accepted; anything else is ignored with a warning |
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
- `*.pg.test.ts` need PostgreSQL >= 15 and are skipped unless `TEST_DATABASE_URL` is set. Use `describe.skipIf(!hasPg)` and `withFreshSchema()` from `src/test/pg.ts` (applies the migrations into a throwaway schema and drops it). Run them with `TEST_DATABASE_URL=postgres://user:pass@localhost:5432/scratch npx vitest run --no-file-parallelism .pg.test.ts`.
- Authz tests build principals with `makePrincipal()` / `FAKE_PRINCIPAL_ADMIN` from `src/test/helpers.ts`; the role matrix has a tripwire test in `src/lib/authz/capabilities.test.ts`. Audit writes are not mocked globally; tests that touch them mock `@/lib/audit/record` or `@/lib/audit/authz-denied` themselves.
- Under jsdom `new Blob()` cannot be passed to `new Response()`; build the body from bytes.
- CI: `.github/workflows/test.yml` runs `tsc --noEmit`, the unit lane, the Postgres lane on a `postgres:16` service and `npm run build`; `semantic.yml` validates PR titles (conventional commits).
- **Real SQL without a database server:** `src/test/pglite.ts` backs `@/lib/db` with an
  in-process Postgres (PGlite), so `ensureUserSchema` and the real queries run inside
  `npm test`. Use it for anything whose correctness lives in SQL (filters, upserts,
  migrations); name those files `*.db.test.ts`:
  ```ts
  vi.mock('@/lib/db', async () => (await import('@/test/pglite')).pgliteDbModule());
  import { usePgliteDb, pgliteSql } from '@/test/pglite';
  usePgliteDb(); // one database per file, user tables emptied before each test
  ```
  It is a single connection, so locking between two sessions (`withMeetingLock`) is
  still mocked.
- **Regression tests:** every bug fix comes with a test that fails when the fix is
  reverted; check it by reverting before you commit.
- **Guard tests** that fail when two things drift apart:
  - `src/compose-environment.test.ts`: env vars read by server code vs `docker-compose.yml`.
  - `src/lib/onboarding/registry-usage.test.ts`: onboarding step ids in the registry vs the
    components that render them.
  - `src/lib/outlook/manifest.test.ts`: the Outlook manifest output vs `ADDIN_VERSION`
    (bump the version when the manifest changes; the admin must re-upload it).
  - `src/lib/ai/llm-limits.test.ts` / `llm-client.test.ts`: the app's model and context
    defaults vs `docker-compose.ai.yml`.
- Vitest ignores `.claude/` (Claude Code worktrees live there).
