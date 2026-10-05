# Audit log (Phase 2)

For operators who run the app and engineers who extend it. The audit log is an append-only table (`public.audit_events`, migration `drizzle/0002_audit_events.sql`) that records **who did what, when, and to which entity**, and nothing else.

## What is and is not logged

**Logged**: the event type (a closed list, see the catalogue below), the outcome (`success`, `denied`, `error`), when it happened, the actor (user id, plus a snapshot of their display name and primary org unit), the entity acted on **by opaque id only**, IP address, user agent, a request id, and a small `details` object made of enums, numbers, booleans, uuids and short codes (counts, durations, byte sizes, field names).

**Never logged** (neither in the table, the stdout mirror, the feed, the CSV, nor the app log):

- transcript, minutes or prompt text, PII-replacement output
- meeting titles, participant names, template names or descriptions
- file names, meeting URLs (Teams links), share tokens or share codes
- free text typed by users
- raw error messages, bodies, causes or stacks from AI/STT/HTTP calls (only the error class, a numeric HTTP status and a short code, via `safeLogError`)
- the attempted email of a failed login (only an optional keyed hash fragment, see `auth.login_failed`)

This is enforced in code, not by convention. See "How the no-content rule is enforced".

## Table

`public.audit_events`: `id` (bigserial, the monotonic cursor), `occurred_at` (timestamptz, default `now()`), `source` (`server` | `client` | `system`), `event_type`, `outcome`, `actor_user_id` (nullable, **no foreign key**), `actor_name` (snapshot), `actor_org_unit_uuid` (nullable snapshot, **no foreign key**), `entity_type`, `entity_id`, `secondary_entity_type`, `secondary_entity_id`, `ip_address`, `user_agent` (truncated to 255), `request_id`, `details` (jsonb), `client_event_id` (uuid) and `client_occurred_at`. CHECK constraints fix the `source` and `outcome` vocabularies. `UNIQUE (actor_user_id, client_event_id) WHERE client_event_id IS NOT NULL` makes client delivery idempotent. Indexes: `occurred_at`, `(actor_user_id, id)`, `(event_type, id)`, `(entity_type, entity_id)`, `(actor_org_unit_uuid, id)`.

There are no foreign keys on the actor or the org unit on purpose: rows must survive deletion of the user or the unit.

## Event catalogue

Closed list: `src/lib/audit/events/*.ts`, aggregated in `events/index.ts` (`EVENT_CATALOGUE`). Anything not in it is rejected. The table below was generated from those files (a `?` suffix marks an optional key). Entity ids are always UUIDs.

| Event type | Source | Entity | Details keys |
|---|---|---|---|
| `access.role_assign` | server | role_assignment (required) + secondary: directory_user | `roleKey`, `scopeOrgUnitUuid?`, `includeDescendants?`, `bootstrap?` |
| `access.role_revoke` | server | role_assignment (required) + secondary: directory_user | `roleKey`, `scopeOrgUnitUuid?` |
| `access.org_unit_create` | server | org_unit (required) + secondary: org_unit | - |
| `access.org_unit_update` | server | org_unit (required) + secondary: org_unit | `nameChanged?`, `parentChanged?` |
| `access.org_unit_delete` | server | org_unit (required) | - |
| `access.member_add` | server | org_unit_member (required) + secondary: directory_user | - |
| `access.member_remove` | server | org_unit_member (required) + secondary: directory_user | - |
| `access.user_create` | server | directory_user (required) | `source?` |
| `access.user_update` | server | directory_user (required) | `changedFields?` |
| `access.user_delete` | server | directory_user (required) | - |
| `access.user_link` | server | directory_user (required) | `via?`, `automatic?` |
| `authz.denied` | server | any type code, uuid optional | `required`, `reason` |
| `auth.login` | server | - | `method`, `provider` |
| `auth.logout` | server | - | - |
| `auth.login_failed` | server, client | - | `reason`, `method?`, `provider?`, `emailHmac?` |
| `template.create` | server | template (required) | `hasPrompt?` |
| `template.update` | server | template (required) | `changedFields` |
| `template.delete` | server | template (required) | - |
| `template.set_default` | server | template (required) | - |
| `template.share` | server | template (required) | `kind` |
| `template.import` | server | template (required) | `kind` |
| `minutes.generate` | server | meeting (optional) + secondary: template | `templateSource`, `durationMs`, `segmentCount`, `outcomeCode?` |
| `transcription.request` | server | meeting (optional) | `mode`, `audioSeconds?`, `bytes?`, `durationMs`, `outcomeCode?` |
| `diarization.request` | server | meeting (optional) | `audioSeconds?`, `speakerCount?`, `durationMs`, `outcomeCode?` |
| `chapters.request` | server | meeting (optional) | `segmentCount?`, `chapterCount?`, `durationMs`, `outcomeCode?` |
| `clarifications.request` | server | meeting (optional) | `segmentCount?`, `questionCount?`, `durationMs`, `outcomeCode?` |
| `export.download` | server | meeting (optional) | `format` |
| `bot.session_start` | server | meeting (optional) | - |
| `bot.session_pause` | server | meeting (optional) | - |
| `bot.session_resume` | server | meeting (optional) | - |
| `bot.session_stop` | server | meeting (optional) | `durationSeconds?` |
| `bot.session_abort` | server | meeting (optional) | `reason?` |
| `bot.audio_collect` | server | meeting (optional) | `bytes?`, `durationMs?` |
| `bot.transcript_collect` | server | meeting (optional) | `segmentCount?`, `durationMs?` |
| `bot.joined` | system, server | meeting (optional) | - |
| `bot.ended` | system, server | meeting (optional) | `durationSeconds?`, `reason?` |
| `bot.error` | system, server | meeting (optional) | `code` |
| `meeting.create` | client | meeting (required) | `origin` |
| `meeting.status_change` | client | meeting (required) | `fromStatus`, `toStatus` |
| `meeting.rename` | client | meeting (required) | - |
| `meeting.participants_edit` | client | meeting (required) | `participantCount` |
| `meeting.delete` | client | meeting (required) | - |
| `meeting.redact` | client | meeting (required) | - |
| `meeting.audio_delete` | client | meeting (required) | - |
| `meeting.transcript_edit` | client | meeting (required) | `segmentCount?` |
| `meeting.minutes_save` | client | meeting (required) | `autosave?` |
| `meeting.minutes_version` | client | meeting (required) | `versionNumber`, `action?` |
| `audit.export` | server | - | `rowCount`, `format`, `truncated?` |
| `audit.prune` | system | - | `deletedCount`, `olderThanDays` |
| `directory.sync` | system, server | sync_run (optional) | `trigger`, `status`, nine counters (`usersUpserted`, `usersDisabled`, `orgUnitsUpserted`, `orgUnitsOrphaned`, `assignmentsUpserted`, `assignmentsRemoved`, `assignmentsIgnoredRole`, `assignmentsSkippedUnknownUser`, `assignmentsWithoutScope`), `orgUnitCyclesBroken?`, `errorCode?` |

Notes on specific events:

- `access.*` are the Phase 1 admin actions. They are written **on the same database transaction** as the change, so a change cannot commit without its audit row.
- `authz.denied`: `required` is the capability or guard that refused, `reason` a short machine code. The entity is kept only when it is a usable reference.
- `auth.login`: `method` is `password`, `oidc` or `microsoft`, derived from the better-auth route; `unknown` otherwise. A self-registration also creates a session and so also emits `auth.login`; there is no separate sign-up event.
- `auth.login_failed`: never stores the attempted email. `emailHmac` is the first 16 hex characters of an HMAC-SHA256 over the trimmed, lower-cased address, keyed with `BETTER_AUTH_SECRET`; it lets repeated attempts against one address be correlated without storing the address. It is omitted when no secret is configured. Recorded server-side from better-auth hooks (`outcome = error`).
- `template.*`: only the id and, for `update`, which fields changed. Only the server-stored **link** flow is logged for share/import; see Known limitations.
- `minutes.generate`: `templateSource` is `personal`, `default` or `none`; the template id is the secondary entity. The meeting entity is present when the client sends a UUID `meetingId` (`TranscriptReview` does); an absent or non-UUID id gives an event without a meeting entity.
- `transcription.request` has three modes: `live` (coalesced, see below), `batch` and `upload`.
- `bot.joined`, `bot.ended` and `bot.error` come from the bot-service through `POST /api/bot/lifecycle` (source `system`). The other `bot.*` events are emitted by the Next.js proxy routes; failed starts and control calls are recorded with `outcome = error`.
- `meeting.*` are client-reported and self-reported, see "Client-reported events".
- `audit.export` is recorded **before** the CSV is returned; if it cannot be written the export is refused (500). `audit.prune` is recorded by the pruner itself.

## How the no-content rule is enforced

1. **Closed catalogue.** Each event type declares its allowed sources, its entity type, whether an entity id is required, and a `.strict()` zod schema for `details` built only from enums, numbers, booleans, uuids and short codes. Unknown types and unknown keys are rejected.
2. **Central details rule** in `record.ts`, applied to the parsed details on top of the schema. Every string value must match `/^[A-Za-z0-9_.:-]{1,64}$/`. There is no whitespace in that class, so prose and transcript text cannot pass by construction. Arrays hold at most 32 such codes, nesting is at most one array level, and the serialised size is at most 2 KB.
3. **Entity ids** (`entity_id`, `secondary_entity_id`) must be UUIDs. Personal template ids are `gen_random_uuid()::text`, so they qualify. A route that passes a non-UUID id has that event dropped, not stored.
4. **Failure means drop.** An invalid event is not stored; a content-free warning `[audit] event dropped type=<event type> code=<error code>` is printed. The offending value is never logged. For telemetry the request continues.
5. **Guard tests** (`events/catalogue.test.ts`) iterate every event type and every string-typed field and assert that transcript-like text, over-long strings, an email, a URL and a file name are rejected.

Honest limit: a single word without whitespace (a surname, say) still matches the code pattern. That is why schemas use `z.enum` wherever the vocabulary is closed, and why call sites must pass codes they define, never user input.

## Writing events (for engineers)

```ts
import { recordEvent, recordServerEvent } from '@/lib/audit/record';

// Telemetry: awaited, best-effort, never throws into the request. ip/user agent/request id come from req.
await recordServerEvent(req, {
  type: 'export.download',
  actorUserId: session.user.id,
  entityId: meetingId, // must be a uuid
  details: { format: 'pdf' },
});

// State change: insert on the SAME transaction; throws, so the change rolls back with it.
await recordEvent({ type: 'template.delete', actorUserId, entityId: templateId }, { tx });
```

- `details` is type-checked per event type. Adding a new event type name changes the catalogue contract; refining the details of an existing one belongs to the owner of that domain file.
- `recordAdminAction(tx, event)` (throws on failure) and `recordAuthzDenied(event)` (never rejects) in `src/lib/audit/seam.ts` are the Phase 1 entry points and map onto catalogue events.
- Write semantics: with a `tx` the insert happens on that transaction and failure throws. Without one, the write is awaited, best-effort, and never throws into the request (`{status: 'stored' | 'duplicate' | 'dropped'}`).
- Route rules: wrap routes in `withHandler`, and log failures with `safeLogError(label, err)`, never `console.error(err)` on an AI/STT error. `withHandler` logs `[label] name=<Error class> status=<http> code=<code> requestId=<id>` and returns the id in an `x-request-id` header on a 500. The same id is stored in `request_id`. An incoming `x-request-id` is only honoured when it is a UUID or 32 hex digits; any other value is replaced by a generated UUID, so callers cannot plant text in the log. `auth.login_failed` stores a `provider` only when it names a configured provider (`providers.ts`), otherwise `unknown`.
- If the actor snapshot lookup fails, the event is still written with a NULL name and unit (and a content-free warning). The row is then visible to global readers only.

## Actor and org-unit snapshot

`actor_name` is copied from `public.users.name` and `actor_org_unit_uuid` from the actor's org-unit memberships when the event is written: the member row flagged `is_primary`, else the only unit if the user has exactly one, else NULL (several primaries or several non-primary units also give NULL). Both are snapshots: they do not change when the user is renamed or moved, and they survive deletion of the user or the unit.

`actor_org_unit_uuid` is what scopes who may read the row, so a NULL unit makes the row global-only.

## Who may read what

| Who | Viewer (`/admin/log`, `GET /api/admin/audit`) | CSV export (`GET /api/admin/audit/export`) |
|---|---|---|
| Holder of `audit.read` with a **global** assignment (`tt-logleser`, `tt-administrator`) | all rows, including NULL-unit rows; sees `ip_address` and `user_agent` | needs `audit.export` (global-only), up to 50,000 rows |
| Holder of `audit.read` **scoped** to org units | only rows whose `actor_org_unit_uuid` is inside their scope (`orgUnitsInScope`); NULL-unit rows and rows of deleted units are invisible; no IP or user agent | not allowed (`audit.export` only takes effect from a global assignment) |
| Anyone else | 403 | 403 |

Viewing fails closed. The export still limits its rows by the caller's `audit.read` scope and blanks IP and user agent for a non-global reader, so an export never shows more than the viewer. CSV: comma-separated (RFC 4180), UTF-8 with BOM, Danish column headers, cells starting with `= + - @`, tab or line breaks get a leading `'` (spreadsheet formula injection). Danish-locale Excel may expect semicolons and need its import wizard. The response header `X-Audit-Truncated: true` and `truncated: true` in the `audit.export` event mark an export cut off at 50,000 rows. The viewer pages with a keyset cursor on `id` (default 50 rows, at most 100).

Rows with `source = client` are labelled "selvrapporteret" in the viewer.

## SIEM feed

For a log shipper or a SIEM that pulls. Authenticated by a service key, **no session**. Disabled (404) until `AUDIT_FEED_API_KEY_HASH` is set.

1. Generate a key and compute its hash (only the hash goes in `.env`):

   ```bash
   KEY=$(openssl rand -hex 32)
   printf '%s' "$KEY" | openssl dgst -sha256 -r | cut -d' ' -f1      # -> AUDIT_FEED_API_KEY_HASH
   # or: node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" "$KEY"
   ```

   Hash exactly the string the SIEM will send: no trailing newline (`printf '%s'`, not `echo`).

2. Pull. The key goes in the `X-Audit-Key` header (`Authorization: Bearer` is deliberately not supported; cookies are ignored).

   ```bash
   # newest id that is safe to read right now
   curl -s -H "X-Audit-Key: $KEY" https://referat.example.dk/api/audit/feed/head      # {"head": 12345}
   # a page of records after the cursor, oldest first
   curl -s -H "X-Audit-Key: $KEY" "https://referat.example.dk/api/audit/feed?offset=0&size=500"
   # -> {"records":[{"id":1,"occurredAt":"...","eventType":"auth.login",...}],"next":500}
   ```

   Keep `next` and send it as `offset` next time; when nothing new exists `next` equals `offset`. `size` defaults to 100, at most 1000. Responses: 404 when the feed is off, 401 on a bad or missing key (checked before the query is validated), 400 on a bad query.

3. Record shape (our own camelCase JSON, `id` is a number): `id`, `occurredAt`, `source`, `eventType`, `outcome`, `actorUserId`, `actorName`, `actorOrgUnitUuid`, `entityType`, `entityId`, `secondaryEntityType`, `secondaryEntityId`, `requestId`, `details`, `clientOccurredAt`, plus `ipAddress` and `userAgent` only when something was stored. The shape was **not** checked against any particular SIEM or against OS2rollekatalog's own audit format.

### Why there is a delay

`id` is a bigserial. A sequence value is handed out at INSERT but becomes visible at COMMIT, so a row with a lower id can commit after a row with a higher one. A reader that remembers "the highest id I saw" would then skip it forever. The feed therefore only serves the contiguous run of ids **below the lowest id whose row is still younger than `AUDIT_FEED_DELAY_SECONDS`** (default 10). This is stricter than "older than N seconds": one young row also holds back every later id.

Residual gap: `occurred_at` is the transaction start. A transaction that stays open longer than the delay can still commit late and be missed. Audit writes are single statements or short admin transactions, so this should not occur in practice, but it is a bound, not a proof. Raise the delay if you run long transactions around audited changes.

## Retention and pruning

By default nothing is ever deleted. Set `AUDIT_RETENTION_DAYS` to a positive integer to delete events older than that many days (unset, zero or non-numeric means keep forever). **Nothing runs the pruning automatically**: call the route from your scheduler.

`POST /api/internal/audit/prune` with header `X-Cron-Secret: <INTERNAL_CRON_SECRET>`. It answers 404 when `INTERNAL_CRON_SECRET` is unset, 401 on a wrong secret, `{"pruned":0,"disabled":true}` when retention is not configured, and otherwise `{"pruned":N,"retentionDays":D}`. Deletion runs in batches of 5000 rows per transaction. When rows were deleted, one `audit.prune` system event (`deletedCount`, `olderThanDays`) is recorded.

```bash
# crontab on the host, daily at 03:15 (the app is published on APP_PORT, default 8080)
15 3 * * * curl -fsS -X POST -H "X-Cron-Secret: $INTERNAL_CRON_SECRET" http://localhost:8080/api/internal/audit/prune >/dev/null
```

The route is not behind a session, so keep `INTERNAL_CRON_SECRET` long and random (`openssl rand -hex 24`) and, if possible, call it over the internal network rather than through the public proxy.

## Immutability and its honest limits

A `BEFORE UPDATE OR DELETE` trigger and a `BEFORE TRUNCATE` trigger (hand-appended to `0002_audit_events.sql`, since drizzle-kit cannot express them) raise an exception. UPDATE and TRUNCATE are never allowed. DELETE is allowed only inside a transaction that ran `set_config('audit.allow_prune', 'on', true)`, which only the retention pruner does (transaction-local, so it cannot leak to a pooled connection).

This guards against **bugs and casual misuse**. It does **not** protect against a database superuser, or the owning application role acting deliberately: either can disable the triggers, set the flag, or alter the table. There is no hash chain. If tamper evidence against a privileged actor matters, forward events off the database: `AUDIT_STDOUT=true` to a write-once log store, or the feed to a SIEM.

`AUDIT_STDOUT=true` prints one JSON line per stored event (the same validated fields as the row, no extras, including `ip_address` unless `AUDIT_STORE_IP=false`). When an event is written on a transaction (admin changes), the line is printed at insert time, so a later rollback of that transaction is not reflected in the mirror.

## Client-reported events

Meetings live only in the browser (IndexedDB), so the server cannot see a rename, a redaction or a delete. The `meeting.*` events are therefore **reported by the client** and stored with `source = client`.

- **Trust level: self-reported.** Actor, time, IP and user agent always come from the server session and request, never from the payload (the body schema is strict and has no such fields). But *that the action happened* is only the user's word: a user can forge, omit or replay such events for their own meetings, suppress them by clearing site data or blocking the endpoint, and an event queued under one login can be delivered under another login in the same browser. The viewer labels these rows "selvrapporteret". Do not use them as proof that a deletion or redaction took place.
- Delivery: `POST /api/audit/client-events` (session required). A durable per-user IndexedDB outbox (bounded to 1000 events, 7-day TTL, exponential back-off) survives flaky networks; each event carries a `clientEventId`, so redelivery is idempotent. At most 50 events and 32 KB per request. One invalid event refuses the whole batch with 400; a failed write answers 503 so the client keeps the batch. `clientOccurredAt` is kept only if it is within the last 7 days and at most 5 minutes in the future, else it is replaced by the server time.
- Only `meeting.*` types are accepted on that route.

## Volume discipline

- **Live transcription**: at most one `transcription.request` per actor, meeting and mode (`live`) per hour. This is an in-memory map in the app process (`utterance/coalesce.ts`), best-effort and single-instance. The event is a sample of activity, not a count, and carries no byte size. A failure that follows a success within the same hour is not recorded.
- **Live clarifications**: the recording screen polls every 25 s, so `clarifications.request` is written at most once per actor and meeting per hour for `success` and once per hour for `error` (`clarifications/coalesce.ts`, in memory, single instance).
- **Client edits**: `meeting.minutes_save`, `meeting.transcript_edit`, `meeting.participants_edit` and `meeting.rename` are coalesced client-side to one event per user, meeting and type per 30 seconds (trailing edge, last details win). `meeting.audio_delete` is deduplicated for 60 seconds per meeting. Writes by the Teams bot's roster poll are not reported as `meeting.participants_edit` (`updateMeeting(..., { automatic: true })`); only user edits are. Server limit for client events: 300 per user per 60 seconds (429 with `Retry-After`).
- **Failed logins**: `auth.login_failed` is throttled to 20 per minute per IP (events without an IP share one bucket).
- No per-segment or per-keystroke events exist.

## Configuration

Read at call time in `src/lib/audit/config.ts` (never `NEXT_PUBLIC_*`): change `.env` and restart, no rebuild. Bad values fall back to the default instead of failing. The bot-service needs no new variable; it reuses `NEXT_APP_URL` and `BOT_INTERNAL_SECRET` for the lifecycle callback.

| Variable | Default | Meaning |
|---|---|---|
| `AUDIT_STDOUT` | `false` | mirror each stored event to stdout as one JSON line |
| `AUDIT_STORE_IP` | `true` | `false` stores no IP address (user agent and request id are still stored) |
| `AUDIT_RETENTION_DAYS` | unset | positive integer; unset or invalid keeps the log forever |
| `AUDIT_FEED_API_KEY_HASH` | unset | 64-character hex sha256 of the feed key; feed answers 404 when unset or malformed |
| `AUDIT_FEED_DELAY_SECONDS` | `10` | the feed only serves rows older than this (see the delay section) |
| `INTERNAL_CRON_SECRET` | unset | authenticates the prune route (`X-Cron-Secret`); the route answers 404 when unset |

IP and user agent come from the request through `src/lib/audit/request-context.ts`, which reuses the proxy header list of `src/lib/auth/ip-headers.ts` (`AUTH_IP_HEADERS`, default `x-forwarded-for`). The reverse proxy must overwrite any client-supplied value, otherwise the stored IP can be forged. Failed-login IPs are only as good as that proxy configuration.

## Personal data (GDPR notes)

The log is personal data about staff, kept for accountability. What it holds, so you can document it in your records of processing:

- `actor_user_id` (the app's user id) and `actor_name` (display name at the time of the event)
- `ip_address` (switch off with `AUDIT_STORE_IP=false`) and `user_agent` (at most 255 characters)
- `actor_org_unit_uuid` (an opaque unit id)
- an `emailHmac` fragment on failed logins: a keyed hash of an attempted address, still pseudonymous personal data
- opaque entity ids (meeting, template, user ids), which are not content but can be linked to a person by someone with the data

It holds no meeting content. Since rows survive deletion of the user (no foreign key) and cannot be updated (trigger), **erasing or pseudonymising one person's rows is not possible through the app**; it needs a deliberate database operation by a privileged operator who disables the trigger, and that action is itself unlogged. Plan for this by choosing `AUDIT_RETENTION_DAYS` and `AUDIT_STORE_IP` to match your retention policy. This document describes what the code stores; it is not legal advice.

## Known limitations

- **Per-instance, in-memory state.** The live-transcription coalescer, the failed-login throttle and the client-event rate limit are per process. With several app instances the limits multiply, and a restart resets them.
- **Share-code export is not logged.** The stateless template share code is built and read client-side (no server round trip), so only the link flow (`template.share`, `template.import`) produces events. The GET preview of an import link is not logged either.
- **Client events are self-reported** and best-effort, see above. A user's queue is only delivered while that user is the signed-in user (it never goes out under the next user's session); events left by a user who does not sign in again on that browser stay in the local outbox until its 7-day TTL drops them. A crash or tab kill inside a 30-second coalescing window loses that one coalesced event.
- **Older `/api` routes only check the session**, not the Phase 1 principal, so a refusal there does not produce `authz.denied`. Phase 1 denial rows also carry no IP, user agent or request id (the call sites pass no request) and the synchronous call sites do not await the write.
- **No client login_failed route.** `auth.login_failed` allows source `client` in the catalogue, but a browser-side failure has no session and `/api/audit/client-events` accepts `meeting.*` only, so failed logins are recorded server-side from better-auth hooks. A 429 from better-auth's rate limiter may not reach that hook (unverified).
- **Feed gap** for transactions open longer than the delay (see above).
- **Latency**: `auth.login` is written inside the session-create hook; a hung audit write delays a login by at most 2 seconds. `transcribe-batches` writes its event before closing the stream.
- **Stored text from other places**: the batch transcription stream still sends an error message to the client in its NDJSON `error` event (not to the log or the audit table).
- **Retention is not automatic**; nothing schedules the prune route.

## Verification status

What was and was not run when this was written (so you know what to test in your environment):

- Unit and route tests run under Vitest; the `*.pg.test.ts` lanes (migration, immutability triggers, scoped viewer queries, feed bound) were run against an embedded PostgreSQL 18.4 and the migration also against pglite (PG17). They were not run against other Postgres versions, and the project's compose file pins `postgres:16-alpine`, so run `TEST_DATABASE_URL=... npx vitest run src/lib/audit` against that image.
- The better-auth hooks were exercised against real better-auth 1.6.11 with its memory adapter for the password flows only. The OAuth callback paths (`/callback/:id`, `/oauth2/callback/:providerId`) are covered by unit tests built from the better-auth source, not run against a real IdP.
- The client reporter, outbox and `pagehide` flush were tested with fake IndexedDB, fetch and timers, not in a real browser.
- bot-service has no installed dependencies in the development worktree, so its lifecycle reporter was only unit-tested, and the Playwright/HTTP wiring test was not run.
