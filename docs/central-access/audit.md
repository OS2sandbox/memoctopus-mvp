# Audit log

For operators who run the app and engineers who extend it. The audit log is an append-only table (`public.audit_events`, migration `drizzle/0002_audit_events.sql`) that records **who did what, when, and to which entity**, and nothing else.

## What is and is not logged

**Logged**: the event type (a closed list), the outcome (`success`, `denied`, `error`), the time, the actor (user id, plus a snapshot of their display name and primary org unit), the entity acted on **by opaque id only**, IP address, user agent, a request id, and a small `details` object of enums, numbers, booleans, uuids and short codes (counts, durations, byte sizes, field names).

**Never logged** (not in the table, the stdout mirror, the feed, the CSV or the app log):

- transcript, minutes or prompt text, PII-replacement output, change notes of central templates
- meeting titles, participant names, template names or descriptions
- file names, meeting URLs (Teams links), share tokens or share codes
- free text typed by users
- raw error messages, bodies, causes or stacks from AI/STT/HTTP calls (only the error class, a numeric HTTP status and a short code, via `safeLogError`)
- the attempted email of a failed login (only an optional keyed hash fragment)

This is enforced in code, not by convention (next section).

## Table

`id` (bigserial, the monotonic cursor), `occurred_at`, `source` (`server` | `client` | `system`), `event_type`, `outcome`, `actor_user_id`, `actor_name` (snapshot), `actor_org_unit_uuid` (snapshot), `entity_type`, `entity_id`, `secondary_entity_type`, `secondary_entity_id`, `ip_address`, `user_agent` (at most 255 characters), `request_id`, `details` (jsonb), `client_event_id` and `client_occurred_at`. CHECK constraints fix the `source` and `outcome` vocabularies; `UNIQUE (actor_user_id, client_event_id)` makes client delivery idempotent. There are no foreign keys on the actor or the org unit on purpose: rows survive deletion of the user or the unit.

## Event catalogue

The closed list is `src/lib/audit/events/*.ts`, aggregated in `events/index.ts`; each entry declares its allowed sources, entity type and a `.strict()` zod schema for `details`. Anything not in it is rejected. That code is the authoritative list; Danish labels for the viewer are in `src/lib/audit/labels.da.ts`. Families:

| Family | Source | What it carries |
|---|---|---|
| `auth.login`, `auth.logout`, `auth.login_failed` | server | method (`password`, `oidc`, `microsoft`, `unknown`) and configured provider id. `login_failed` has no actor, a reason code and an optional `emailHmac` (first 16 hex characters of an HMAC-SHA256 of the lower-cased address, keyed with `BETTER_AUTH_SECRET`; omitted without a secret). Failed logins are recorded only on the server, from better-auth hooks, throttled to 20 per minute per IP |
| `authz.denied` | server | the capability or guard that refused (`required`) and a reason code; the entity only when it is a usable uuid reference. Denial rows carry no IP, user agent or request id and are written in the background |
| `access.*` | server | role assign/revoke (role key, scope unit), org-unit create/update/delete, member add/remove, directory-user create and link. Written on the same transaction as the change |
| `template.*` | server | personal templates: id and changed field names. Only the link flow of share/import is logged |
| `central_template.*` | server | create, update, retarget, archive, restore: template id, owner unit, new `version`, `targetCount` or `changedFields` (names only). Same transaction as the change and the version row |
| `minutes.generate`, `transcription.request`, `diarization.request`, `chapters.request`, `clarifications.request`, `export.download` | server | meeting id when the client sends a uuid, counts, durations, byte sizes and an `outcomeCode`. `minutes.generate` also carries `templateSource` (`personal`, `default`, `none`, `central`), the template as secondary entity and, for central templates, `templateVersion`; on a successful run `outcomeCode: 'prompt_echo'` means part of the output matched the locked prompt and was replaced (see `templates.md`) |
| `bot.*` | server, system | session start/pause/resume/stop/abort and audio/transcript collection come from the Next.js proxy routes; `bot.joined`, `bot.ended` and `bot.error` come from the bot-service through `POST /api/bot/lifecycle` (source `system`) |
| `meeting.*` | client | create (with `origin`), status change, rename, participants edit, delete, redact, audio delete, transcript edit, minutes save/version. **Self-reported**, see below |
| `audit.export`, `audit.prune` | server, system | row count and format of a CSV export (recorded before the file is returned; if it cannot be written the export is refused); rows deleted by the pruner |
| `directory.sync` | system, server | one per Rollekatalog sync run: trigger (`cron`/`manual`), status, `forced`, error code and the counters of the run (users, sessions revoked, org units, assignments) |

Entity ids must be UUIDs. `transcription.request` has the modes `live` (coalesced), `batch` and `upload`.

## How the no-content rule is enforced

1. **Closed catalogue.** Unknown event types and unknown `details` keys are rejected.
2. **Central details rule** in `record.ts`, on top of the schema: every string value must match `/^[A-Za-z0-9_.:-]{1,64}$/` (no whitespace, so prose cannot pass), arrays hold at most 32 such values, nesting is at most one array level, and the serialised size is at most 2 KB.
3. **Entity ids** must be UUIDs; a route that passes anything else has that event dropped.
4. **Failure means drop.** An invalid event is not stored; a content-free warning `[audit] event dropped type=<type> code=<code>` is printed and the request continues. The offending value is never logged.
5. **Guard tests** (`events/catalogue.test.ts`) assert that transcript-like text, over-long strings, an email, a URL and a file name are rejected in every string field.

Honest limit: a single word without whitespace (a surname) still matches the code pattern. That is why schemas use `z.enum` wherever the vocabulary is closed, and why call sites must pass codes they define, never user input.

## Writing events (for engineers)

```ts
import { recordEvent, recordServerEvent } from '@/lib/audit/record';

// Telemetry: awaited, best-effort, never throws into the request. ip/user agent/request id come from req.
await recordServerEvent(req, { type: 'export.download', actorUserId, entityId: meetingId, details: { format: 'pdf' } });

// State change: insert on the SAME transaction; throws, so the change rolls back with it.
await recordEvent({ type: 'template.delete', actorUserId, entityId: templateId }, { tx });
```

- Admin writes call `recordEvent(event, { tx })`; authorisation denials call `recordAuthzDenied` (`src/lib/audit/authz-denied.ts`, never rejects). Without a `tx` the result is `{ status: 'stored' | 'duplicate' | 'dropped' }`.
- Wrap routes in `withHandler` and log failures with `safeLogError(label, err)`, never `console.error(err)` on an AI/STT error. `withHandler` returns a request id in `x-request-id` on a 500 and stores the same id in `request_id`. An incoming `x-request-id` is honoured only when it is a UUID or 32 hex digits.
- If the actor snapshot lookup fails the event is still written with a NULL name and unit.
- Adding an event type name changes the catalogue contract; refining the details of an existing one belongs to the owner of that domain file.

## Actor and org-unit snapshot

`actor_name` is copied from `public.users.name` and `actor_org_unit_uuid` from the actor's org-unit memberships when the event is written: the member row flagged `is_primary`, else the only unit if there is exactly one, else NULL. Both are snapshots; they survive renames and deletions. `actor_org_unit_uuid` decides who may read the row, so a NULL unit makes the row global-only.

## Who may read what

| Who | Viewer (`/admin/log`, `GET /api/admin/audit`) | CSV export (`GET /api/admin/audit/export`) |
|---|---|---|
| `audit.read` with a **global** assignment (`tt-logleser`, `tt-administrator`) | all rows; sees `ip_address` and `user_agent` | needs `audit.export` (global-only), up to 50,000 rows |
| `audit.read` **scoped** to org units | only rows whose `actor_org_unit_uuid` is in scope; NULL-unit rows and rows of deleted units are invisible; no IP or user agent | not allowed |
| anyone else | 403 | 403 |

Viewing fails closed, and an export never shows more than the viewer (it is limited by the caller's `audit.read` scope and blanks IP and user agent for a non-global reader). CSV: RFC 4180, UTF-8 with BOM, Danish headers, cells starting with `= + - @`, tab or line breaks get a leading `'` (formula injection). Danish-locale Excel may need its import wizard for commas. `X-Audit-Truncated: true` and `truncated: true` in the `audit.export` event mark an export cut off at 50,000 rows. The viewer fetches the export itself (a plain link would save an error body as a CSV): it shows a dismissible warning when the export is truncated or fails, and a truncated file is named `log-<date>-afkortet.csv` so it stays recognisable off-platform (the CSV carries no marker row, so it stays parseable). The viewer pages with a keyset cursor on `id` (50 rows by default, at most 100) and labels `source = client` rows "selvrapporteret".

## SIEM feed

For a log shipper that pulls. Authenticated by a service key, **no session**. Off (404) until `AUDIT_FEED_API_KEY_HASH` is set.

1. Generate a key and compute its hash (only the hash goes in `.env`). Hash exactly the string the SIEM will send: no trailing newline.

   ```bash
   KEY=$(openssl rand -hex 32)
   printf '%s' "$KEY" | openssl dgst -sha256 -r | cut -d' ' -f1      # -> AUDIT_FEED_API_KEY_HASH
   ```

2. Pull. The key goes in the `X-Audit-Key` header (`Authorization: Bearer` is not supported; cookies are ignored).

   ```bash
   curl -s -H "X-Audit-Key: $KEY" https://referat.example.dk/api/audit/feed/head                      # {"head": 12345}
   curl -s -H "X-Audit-Key: $KEY" "https://referat.example.dk/api/audit/feed?offset=0&size=500"      # {"records":[...],"next":500}
   ```

   Keep `next` and send it as `offset` next time; when nothing new exists `next` equals `offset`. `size` defaults to 100, at most 1000. Answers: 404 feed off, 401 bad or missing key (checked before the query), 400 bad query.

3. Records are camelCase JSON with every stored field (`id` as a number, `occurredAt`, `source`, `eventType`, `outcome`, actor, entity and secondary entity fields, `requestId`, `details`, `clientOccurredAt`) plus `ipAddress` and `userAgent` only when stored. The shape was not checked against any particular SIEM.

**Why there is a delay.** A bigserial value is handed out at INSERT but visible at COMMIT, so a lower id can commit after a higher one and a reader remembering "the highest id I saw" would skip it. The feed serves only the contiguous run of ids below the lowest id whose row is younger than `AUDIT_FEED_DELAY_SECONDS` (default 10). Residual gap: a transaction that stays open longer than the delay can still commit late and be missed; raise the delay if you run long transactions around audited changes.

## Retention and pruning

Events older than `AUDIT_RETENTION_DAYS` are deleted; the default is **365 days**. A positive integer sets another period; `0`, `off`, `false`, `never` or `forever` (any case) is the explicit opt-out that keeps the log forever; any other value is treated as a typo and falls back to 365. **Nothing in the app schedules the pruning**: your scheduler must call the route.

`POST /api/internal/audit/prune` with header `X-Cron-Secret: <INTERNAL_CRON_SECRET>`. It answers 404 while `INTERNAL_CRON_SECRET` is unset, 401 on a wrong secret, `{"pruned":0,"disabled":true}` after the opt-out, otherwise `{"pruned":N,"retentionDays":D}`. Deletion runs in batches of 5000 rows per transaction. One `audit.prune` system event (`deletedCount`, `olderThanDays`) is written when rows were deleted, also when a later batch failed.

```bash
# crontab on the host, daily at 03:15 (the app is published on APP_PORT, default 8080)
15 3 * * * curl -fsS -X POST -H "X-Cron-Secret: $INTERNAL_CRON_SECRET" http://localhost:8080/api/internal/audit/prune >/dev/null
```

The route is not behind a session: keep the secret long and random (`openssl rand -hex 24`) and call it over the internal network if you can.

## Immutability and its honest limits

A `BEFORE UPDATE OR DELETE` trigger and a `BEFORE TRUNCATE` trigger (hand-appended to `0002_audit_events.sql`) raise an exception. UPDATE and TRUNCATE are never allowed. DELETE is allowed only in a transaction that ran `set_config('audit.allow_prune', 'on', true)`, which only the pruner does.

This guards against **bugs and casual misuse**. It does **not** stop the table owner or a superuser acting deliberately: either can disable the triggers, set the flag or alter the table. There is no hash chain. Recommendation if that matters: run the app with a non-owner database role that has INSERT and SELECT (and sequence usage) on `audit_events` but no UPDATE, DELETE, TRUNCATE or ALTER, keep migrations on a separate owner role, and prune with a separate role from your own scheduled SQL (`set_config`, then `DELETE`) instead of the route, with `AUDIT_RETENTION_DAYS=off` in the app. For tamper evidence against a privileged operator, also forward events off the database: `AUDIT_STDOUT=true` to a write-once log store, or the feed to a SIEM. `AUDIT_STDOUT=true` prints one JSON line per stored event (the same fields as the row, with the IP unless `AUDIT_STORE_IP=false`); an event written on a transaction is printed at insert time, so a later rollback is not reflected.

## Client-reported events

Meetings live only in the browser (IndexedDB), so the server cannot see a rename, a redaction or a delete. The `meeting.*` events are **reported by the client** and stored with `source = client`.

- **Trust level: self-reported.** Actor, time, IP and user agent come from the server session and request, never from the payload (the body schema is strict). But *that the action happened* is only the user's word: a user can forge, omit or replay such events for their own meetings, suppress them by clearing site data or blocking the endpoint, and an event queued under one login can be delivered under another login in the same browser. Do not use them as proof that a deletion or redaction took place.
- **Delivery.** `POST /api/audit/client-events` (session required, disabled users refused; only `meeting.*` types). A durable per-user IndexedDB outbox (1000 events, 7-day TTL, back-off) survives flaky networks; each event carries a `clientEventId`, so redelivery is idempotent. A queue is delivered only while its own user is signed in. At most 50 events and 32 KB per request; one invalid event refuses the whole batch with 400. `clientOccurredAt` is kept only within the last 7 days and at most 5 minutes ahead, else replaced by server time.
- **Server limits.** 300 events per user per 60 s (429 with `Retry-After`); for `meeting.rename`, `participants_edit`, `minutes_save` and `transcript_edit` one stored event per user, meeting and type per 60 s (the rest are acknowledged, not stored); a daily cap of `AUDIT_CLIENT_EVENTS_DAILY_CAP` stored client events per user per rolling 24 h (default 2000; beyond it events are acknowledged but dropped). The answer is `{"accepted": n}` or `{"accepted": n, "capped": true}`. If the cap check or a write fails the route answers 503 and the client keeps the batch.
- **Client side.** Edit events are coalesced to one per user, meeting and type per 30 s; `meeting.audio_delete` is deduplicated for 60 s. Writes by the Teams bot's roster poll are not reported as `participants_edit`.

## Volume discipline

- **Live transcription**: at most one `transcription.request` per actor, meeting and mode per hour (in-memory, `utterance/coalesce.ts`). It is a sample of activity, not a count.
- **Live clarifications**: at most one `clarifications.request` per actor and meeting per hour for `success` and one for `error` (`clarifications/coalesce.ts`).
- No per-segment or per-keystroke events exist.

## Configuration

Read at call time in `src/lib/audit/config.ts` (change `.env`, restart, no rebuild). The bot-service needs no variable of its own; it reuses `NEXT_APP_URL` and `BOT_INTERNAL_SECRET` for the lifecycle callback. Defaults and wording are in `.env.example`.

| Variable | Default | Meaning |
|---|---|---|
| `AUDIT_STDOUT` | `false` | mirror each stored event to stdout as one JSON line |
| `AUDIT_STORE_IP` | `true` | `false` stores no IP address |
| `AUDIT_RETENTION_DAYS` | `365` | positive integer, or `0`/`off`/`false`/`never`/`forever` to keep forever; invalid means 365 |
| `AUDIT_CLIENT_EVENTS_DAILY_CAP` | `2000` | stored client events per user per 24 h; unset, 0 or invalid means 2000 |
| `AUDIT_FEED_API_KEY_HASH` | unset | 64-character hex sha256 of the feed key; feed answers 404 when unset or malformed |
| `AUDIT_FEED_DELAY_SECONDS` | `10` | the feed serves only rows older than this |
| `INTERNAL_CRON_SECRET` | unset | `X-Cron-Secret` for the prune and the Rollekatalog sync routes; both answer 404 when unset |
| `AUTH_IP_HEADERS` | `x-forwarded-for` | headers the client IP is read from (`src/lib/auth/ip-headers.ts`, read once at startup) |

**IP trust.** The IP is the first entry of the first configured header that holds a valid address (`src/lib/audit/request-context.ts`). The proxy must therefore overwrite, not append to, the client-supplied value. The shipped `nginx/nginx.conf` and `nginx-init.conf` set `X-Forwarded-For` and `X-Real-IP` to `$remote_addr`; any other proxy in front of the app must do the same, otherwise a client can forge the stored IP and the per-IP failed-login throttle.

## Personal data (GDPR notes)

The log is personal data about staff, kept for accountability. What it holds, for your records of processing:

- `actor_user_id` and `actor_name` (display name at the time of the event)
- `ip_address` (switch off with `AUDIT_STORE_IP=false`) and `user_agent`
- `actor_org_unit_uuid` (an opaque unit id)
- an `emailHmac` fragment on failed logins: a keyed hash of an attempted address, still pseudonymous personal data
- opaque entity ids (meeting, template, user ids), which are not content but can be linked to a person by someone with the data

It holds no meeting content. Rows survive deletion of the user and cannot be updated, so **erasing or pseudonymising one person's rows is not possible through the app**; it needs a deliberate operation by a privileged database operator, which is itself unlogged. Plan for it by choosing `AUDIT_RETENTION_DAYS` and `AUDIT_STORE_IP` to match your policy. This describes what the code stores; it is not legal advice.

## Known limitations

- **Per-instance, in-memory state**: the coalescers, the failed-login throttle, the client-event rate limit and the per-type throttle are per process; several app instances multiply the limits and a restart resets them.
- **Share-code export is not logged.** The stateless template share code is built and read in the browser; only the link flow produces events.
- **Client events are best-effort.** A crash inside a 30-second coalescing window loses that coalesced event; events left by a user who does not sign in again on that browser stay in the local outbox until the 7-day TTL.
- **A 429 from better-auth's own rate limiter may not reach the failed-login hook** (unverified).
- **Latency.** `auth.login` is written inside the session-create hook; a hung audit write delays a login by at most 2 seconds.
- **Error text on one stream.** The batch transcription stream still sends an error message to the client in its NDJSON `error` event (not to the log or the audit table).
- **Feed gap** for transactions open longer than the delay (above).
