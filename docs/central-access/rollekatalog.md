# Rollekatalog integration: operator guide

For the person who connects the app to a municipality's OS2rollekatalog and keeps it running. Architecture: `README.md`. Audit: `audit.md`.

> **Never run against a live Rollekatalog.** The integration was built from the OS2rollekatalog source (release 2026r4) and tested against synthetic fixtures and an in-process mock server. HTTP statuses for wrong keys, the real size of `organisation/v3` and the menu names in the Rollekatalog UI are modelled, not observed. Do the first sync with a small, known set of users and check the result before you rely on it (section 2).

## 1. What it does

With `ACCESS_SOURCE=rollekatalog`, Rollekatalog decides who holds which role and for which part of the organisation. The app keeps a **read-only mirror** in its own tables (`directory_users`, `org_units`, `org_unit_members`, `role_assignments`, `sync_runs`; rows from this integration have `source='rollekatalog'`). Permission checks read only the mirror, never Rollekatalog, so a Rollekatalog outage does not stop users from working.

```
Rollekatalog --(GET, ApiKey)--> sync --one transaction--> mirror tables --> resolvePrincipal() --> capabilities
```

**The app never writes to Rollekatalog.** It sends only GET requests, and only these two:

| Endpoint | Key (client role) | Used for |
|---|---|---|
| `GET /api/organisation/v3` | `ROLLEKATALOG_ORG_API_KEY` (`ORGANISATION`) | users, org units, positions. Heavy, and synchronized on the Rollekatalog side: do not poll it more often than the sync |
| `GET /api/read/itsystem/roleAssignmentsWithContraints/{system}` | `ROLLEKATALOG_READ_API_KEY` (`READ_ACCESS`) | effective role assignments with resolved org-unit constraint values |

An `ORGANISATION` client does not imply `READ_ACCESS` (and vice versa), so a sync needs both keys. Never request `ROLE_MANAGEMENT` or `ADMINISTRATOR` for these clients: they can assign roles, and the app does not need that.

## 2. Setup checklist

Menu names differ by version and language; confirm them in your installation.

1. **Create the IT system and its four system roles by hand in Rollekatalog.** The app never creates them. IT system identifier: `os2taletiltekst` (or another one, then set `ROLLEKATALOG_ITSYSTEM_ID`). System role identifiers must match exactly (`ROLE_KEYS` in `src/lib/authz/types.ts`); anything else is counted as `assignmentsIgnoredRole` and ignored:

   | Identifier | Name | Org-unit data constraint |
   |---|---|---|
   | `tt-bruger` | Bruger | no |
   | `tt-skabelonansvarlig` | Skabelonansvarlig | yes (needed: without a unit the role grants nothing, section 4) |
   | `tt-logleser` | Logleser | yes (needed unless listed in `ROLLEKATALOG_GLOBAL_ROLES`) |
   | `tt-administrator` | Administrator | no (cannot be scoped to a unit; constraint values are ignored) |

   For a role that takes a constraint, use the organisation-unit constraint type (internal `http://digital-identity.dk/constraints/orgunit/1`, "Enhed", or KOMBIT `.../orgenhed/1`). Other constraint types, KLE for instance, are never used as scope.
2. **Build the access.** Create a *jobfunktionsrolle* (UserRole) from each system role, optionally group them in *rollebuketter* (RoleGroups), and assign them to persons, titles or org units. Choose the org unit as the data constraint (*dataafgrænsning*) for `tt-skabelonansvarlig` and `tt-logleser`. Assign `tt-bruger` too if you will use `REQUIRE_ROLE_TO_LOGIN=true`.
3. **Create two API clients**: one with client role `READ_ACCESS`, one with `ORGANISATION`. Keep the keys apart.
4. **Set the environment** (`.env.example` lists every variable): `ROLLEKATALOG_URL` (https), `ROLLEKATALOG_READ_API_KEY`, `ROLLEKATALOG_ORG_API_KEY`, `ROLLEKATALOG_ITSYSTEM_ID`, `INTERNAL_CRON_SECRET`. Restart (`docker compose up -d app`); no rebuild.
5. **Choose how logins are matched** (section 3) and make sure at least one person who can log in via SSO holds `tt-administrator` in Rollekatalog and matches a Rollekatalog user. In rollekatalog mode there is no bootstrap administrator and local assignments are ignored.
6. **Run the first sync.** A dry run in local mode is not possible: the admin button "Synkroniser nu" and the cron route answer 409 unless `ACCESS_SOURCE=rollekatalog`, and a 409 from the cron route writes no `sync_runs` row. So set `ACCESS_SOURCE=rollekatalog` (keep `REQUIRE_ROLE_TO_LOGIN=false` meanwhile), restart, and trigger the first sync through the cron route, because the mirror is empty and nobody is an administrator yet:

   ```bash
   curl -s -X POST -H "X-Cron-Secret: $INTERNAL_CRON_SECRET" http://localhost:8080/api/internal/rollekatalog/sync
   # {"status":"success","counts":{...},"errorCode":null}
   ```

   On failure the body carries the `errorCode` (section 10), and the same code is in `sync_runs.error_code` and the "Seneste synkronisering" panel on the admin overview. Fix it and call again; to back out, set `ACCESS_SOURCE=local` and restart. After a good run, log in as the administrator, compare users and organisation in `/admin` with Rollekatalog, and check the counts.
7. **Schedule the sync** (section 6).

## 3. Matching a login to a Rollekatalog user

A login is linked automatically from claims in the SSO ID token that better-auth stored (`external_identities`). Only trusted SSO providers are matched, never `credential` (email/password) accounts; zero or several candidates never link.

| `DIRECTORY_MATCH` | Compares | Notes |
|---|---|---|
| `userid-claim` (default) | the claim named by `DIRECTORY_USERID_CLAIM` (default `preferred_username`) with `ext_user_id` (Rollekatalog `userId`), case-insensitively | usual choice |
| `extuuid-claim` | the same claim with `ext_uuid` (Rollekatalog `extUuid`); must be a uuid | only if the IdP really carries that uuid |
| `email` | the `email` claim with the mirrored email | only with `email_verified === true`; many IdPs do not guarantee that |

Disabled Rollekatalog rows are never link targets, so a reused userId does not make a new person ambiguous. A person deleted and re-created in Rollekatalog (new uuid, same userId) is re-linked at the next login from the old, now disabled row to the new one. A row linked to a different app user is never taken over (logged as `conflict`).

**Entra ID.** `preferred_username` and `upn` are the user principal name, typically `abc123@kommune.dk`, while Rollekatalog's `userId` is usually the plain `abc123`. `oid` is Entra's object id; Rollekatalog's `extUuid` comes from the municipality's own identity source, so the two are generally different values: do not choose `extuuid-claim` with `oid` before you have compared both for a few known users. `DIRECTORY_USERID_TRANSFORM=strip-upn-domain` removes everything from the first `@` before comparing (`userid-claim` only; default `none`). It throws the tenant part away, which is only safe because of the rule below.

**Microsoft logins never link unless `MICROSOFT_TENANT_ID` names ONE tenant (not `common`, `organizations`, `consumers`) and the login's `tid` equals it.** This holds for every `DIRECTORY_MATCH` mode and every `DIRECTORY_USERID_TRANSFORM`: `preferred_username`, `upn` and `email` are mutable and, with the multi-tenant authority, any Entra tenant (guests included) can present a value equal to a Rollekatalog userId. Fix: set `MICROSOFT_TENANT_ID` to your tenant id. The first refusal for this reason logs one content-free line (`microsoft_tenant_not_pinned`) per process. Generic OIDC providers (`OIDC_*`) are not restricted this way: you control that IdP, so make sure it only authenticates your own users.

Verify with a known user before go-live: log in, then check in `/admin` (Brugere og roller) that the person is linked to the right Rollekatalog user.

## 4. Scope: who may manage what

Rollekatalog gives each assignment an optional constraint. **The scope of `tt-skabelonansvarlig` and `tt-logleser` is the org-unit constraint and nothing else**: the units named in the constraint of the assignment. There are no manager- or substitute-based strategies.

- **Descendants.** A scope unit also covers its sub-units by default (`ROLLEKATALOG_SCOPE_DESCENDANTS=true`); `false` means only that unit.
- **Unknown units are ignored.** Rollekatalog's organisation export leaves out inactive and excluded units. If all named units are unknown, the assignment gets no scope and is **not** widened to global.
- **Duplicates are unioned.** Several assignments of one role to one person give the union of their units; an unconstrained duplicate never widens a scoped role.
- `tt-bruger` needs no scope. `tt-administrator` can never be scoped.

**`ROLLEKATALOG_GLOBAL_ROLES` and why it exists.** Rollekatalog **silently drops a constraint that resolves to empty** (for example a deleted unit): the assignment then looks unconstrained, which a naive reading would turn into "all units". The app never reads "no scope" as "everywhere". When an assignment has no usable org-unit scope, a role listed in `ROLLEKATALOG_GLOBAL_ROLES` becomes **global** (default: `tt-administrator` only); every other role gets **no row** (fail closed) and the sync counts it as `assignmentsWithoutScope` ("Roller uden område (ikke tildelt)"). For organisation-wide log readers add `tt-logleser` (`ROLLEKATALOG_GLOBAL_ROLES=tt-administrator,tt-logleser`). `none` allows no role, which also makes `tt-administrator` fail closed; a non-empty value without a valid role falls back to the default.

## 5. Staleness, removal and guards

- **Staleness.** Every successful sync refreshes `synced_at` on all mirrored assignments. An assignment older than `ROLE_STALE_MAX_SECONDS` (default 86400, 24 h) is ignored: elevated capabilities vanish, the baseline `tt-bruger` stays (unless `REQUIRE_ROLE_TO_LOGIN=true`). If syncs fail for longer than that, administrators lose access, so alert on failed runs and keep the interval well below the limit. Staleness affects roles only; membership and the `disabled` flag keep their last known value.
- **Removal means disabled and signed out.** A user missing from Rollekatalog's answer, or `disabled` there, becomes `disabled=true` in the mirror (the two cases are not told apart): no roles, no baseline, 403 from the APIs and "Ingen adgang" in the app. Rollekatalog does not blank the roles of a disabled user, so the app relies on this flag. **In the same transaction the sync deletes the better-auth sessions of every disabled linked user**, so existing cookies die at once (counter "Sessioner afsluttet", `sessionsRevoked`). The person is re-enabled by a later sync that lists them as active, and then logs in again. Org units are never deleted (a unit that disappears keeps its row, loses its members and assignments); assignments and memberships follow the answer exactly.
- **Mode symmetry.** In local mode `source='rollekatalog'` assignments are ignored, in rollekatalog mode `source='local'` ones are (and rows of an unknown source in both).

A sync fetches everything first and applies it in **one transaction**: a failure rolls back and the mirror stays as it was.

| Guard | Condition | Result |
|---|---|---|
| Single run | another sync holds the Postgres advisory lock | `already_running` (HTTP 409), no new `sync_runs` row, audited as denied |
| Empty response | zero users or zero org units | `empty_response`, nothing changed, cannot be forced |
| Invalid rows | more than `max(3, 5 %)` of the rows of one array fail validation (see below) | `invalid_response`, nothing changed, cannot be forced |
| Removal threshold | the run would disable more than `ROLLEKATALOG_SYNC_MAX_REMOVAL_PERCENT` (default 30) percent of the enabled mirrored users, or delete more than that share of mirrored assignments | `removal_threshold`, nothing changed. The first sync into an empty mirror has no threshold |

**A few malformed rows do not fail the sync.** Rollekatalog's own user and unit ids are free text (`varchar(36)`) supplied by whichever system imported them, so one legacy row with an id that is not a uuid must not stop a 50,000-user organisation. The `organisation/v3` arrays (`users`, `orgUnits`) and the role-assignment answer are therefore validated **row by row**. A row that fails (a user or unit `uuid` that is not a uuid, a user without the `disabled` flag, a unit without a name, a row that is not an object, an assignment entry without `roleIdentifier`) is **dropped and counted**, never stored and never logged. A malformed payload as a whole (not an object, `users` or `orgUnits` missing or not an array, the role-assignment answer not an array) still fails as `invalid_response`.

- **Allowance.** Per array (users, units, assignment rows, assignment entries) at most `max(3, 5 % of its rows, rounded down)` bad rows are accepted: 3 of 10 pass and 4 abort; of 1,000 rows 50 pass and 51 abort. Above that the run fails with `invalid_response` **before anything is written**, so a structurally corrupt export still fails loudly. The constants are `INVALID_ROWS_MIN_ALLOWANCE` and `INVALID_ROWS_MAX_PERCENT` in `src/lib/rollekatalog/schemas.ts`.
- **A skipped user is simply absent from the answer.** It is treated like any user missing from Rollekatalog: if it was mirrored before it is **disabled** (and signed out), subject to the removal threshold above. Role assignments of a skipped user count as `assignmentsSkippedUnknownUser`. A skipped unit is not stored: its child units become roots (`parent_uuid` NULL, fail closed) and its members lose that membership.
- **Positions.** A position with a malformed shape (not an object, wrong field types) is dropped and counted as `membershipsSkippedInvalid`; the user is kept. A position that points to a unit id that is not a uuid is dropped quietly, because that unit is itself a skipped unit and already counted.
- **Status panel.** The run shows "Brugere sprunget over (ugyldig række)" (`usersSkippedInvalid`), "Enheder sprunget over (ugyldig række)" (`orgUnitsSkippedInvalid`), "Rolle-rækker sprunget over (ugyldig række)" (`assignmentRowsSkippedInvalid`, dropped rows plus dropped entries) and "Stillinger sprunget over (ugyldig række)" (`membershipsSkippedInvalid`). Anything above 0 means Rollekatalog holds rows the app cannot read: fix them there. The same counters are in the `directory.sync` audit event.
- **When the abort happens** (`invalid_response` and the message about too many invalid rows): the run records no counts and the log holds no row content. In Rollekatalog look for users and org units whose uuid is not a 36-character uuid (typically legacy or hand-imported rows, or a broken import that wrote another field into the id) and correct or remove them. If the export as a whole looks wrong (a new Rollekatalog version, a proxy page), check the URL and version as for any `invalid_response`. The abort clears itself on the next run once the rows are fixed.

"Synkroniser nu" can be sent with **"Gennemtving"** (`{"force": true}`) to bypass the removal threshold after you have checked in Rollekatalog that the removal is intended (a reorganisation, say). Only a holder of `sync.run` can; the cron route never forces. The would-be numbers are written to the server log only. Every run leaves a `sync_runs` row (`success` or `failed`, counts, error code) and one `directory.sync` audit event (with `forced`); a run left as `running` by a crashed process is closed as `failed` / `abandoned` by the next run.

## 6. Scheduling

The app has no in-process timers (they would run once per replica). Call the route from a host or cluster cron:

```
*/15 * * * * curl -fsS -m 600 -X POST -H "X-Cron-Secret: $INTERNAL_CRON_SECRET" https://app.example.dk/api/internal/rollekatalog/sync -o /dev/null
```

It answers 404 while `INTERNAL_CRON_SECRET` is unset and 401 on a wrong secret. **409** `not_rollekatalog_mode` or `not_configured` (URL or a key missing or unusable) when `ACCESS_SOURCE` is not `rollekatalog` or the integration is unconfigured; nothing is written then. Otherwise `200` success, `409` already running, `502` aborted or upstream failure, `500` unexpected, with the body `{status, counts, errorCode}`. Choose an interval comfortably below `ROLE_STALE_MAX_SECONDS` and no shorter than a few minutes. Monitor with `GET /api/admin/access/sync` (latest run), the admin overview, or the `directory.sync` events.

## 7. Switching modes

**local to rollekatalog.** Complete the checklist, including a first sync and a login of the administrator. From then on local role and org-unit writes answer 409, local assignments are ignored, and a user linked to a local row is moved to the matching Rollekatalog row at the next login.

**rollekatalog to local** (also the way out of a lock-out): set `ACCESS_SOURCE=local` and restart. Local assignments apply again and `source='rollekatalog'` assignments are ignored. A user who was moved to a Rollekatalog row has no local link until an administrator links them again, and a linked Rollekatalog row keeps its `disabled` flag. `BOOTSTRAP_ADMIN_EMAILS` is one-shot: if it was already used, recover with `DELETE FROM system_flags WHERE key = 'bootstrap_admin_done';` (`README.md`).

**A typo is not local.** `ACCESS_SOURCE` must be `local` or `rollekatalog` (or empty, meaning `local`). Any other value makes access control answer 503 "Adgangskontrol er midlertidigt utilgængelig" and the pages show the retry screen until it is fixed.

## 8. Environment variables

Read at call time (restart, no rebuild); an invalid value falls back to the default (except `ACCESS_SOURCE`). Defaults and comments are in `.env.example`.

| Variable | Default | Meaning |
|---|---|---|
| `ROLLEKATALOG_URL` | unset | Base URL, `https://` (see section 9). Unset or unusable: not configured. Credentials in the URL are refused |
| `ROLLEKATALOG_READ_API_KEY` | unset | Key of the `READ_ACCESS` client |
| `ROLLEKATALOG_ORG_API_KEY` | unset | Key of the `ORGANISATION` client |
| `ROLLEKATALOG_ITSYSTEM_ID` | `os2taletiltekst` | IT system identifier (letters, digits, `_`, `-`) |
| `ROLLEKATALOG_DOMAIN` | unset | Rollekatalog domain; unset means its primary domain |
| `ROLLEKATALOG_TIMEOUT_MS` | `120000` | per request attempt, response body included; 1000 to 600000. Both calls are bulk downloads, so the default is 2 minutes |
| `ROLLEKATALOG_MAX_RESPONSE_BYTES` | 64 MiB | cap for a response; larger gives `too_large`. The default is a guess |
| `ROLLEKATALOG_ALLOW_HTTP` | `false` | `true` allows `http://` for a non-local host |
| `ROLLEKATALOG_SCOPE_DESCENDANTS` | `true` | section 4 |
| `ROLLEKATALOG_GLOBAL_ROLES` | `tt-administrator` | section 4 |
| `ROLLEKATALOG_SYNC_MAX_REMOVAL_PERCENT` | `30` | 0 to 100 |
| `ROLE_STALE_MAX_SECONDS` | `86400` | section 5 |
| `DIRECTORY_USERID_TRANSFORM` | `none` | `none` or `strip-upn-domain` |
| `INTERNAL_CRON_SECRET` | unset | secret of the cron routes (shared with the audit prune route) |

Related: `ACCESS_SOURCE`, `REQUIRE_ROLE_TO_LOGIN`, `DIRECTORY_MATCH`, `DIRECTORY_USERID_CLAIM`, `MICROSOFT_TENANT_ID`.

## 9. Secrets and the URL

- The two API keys are secrets: keep them in `.env` or your secret store. They are never logged and never part of an error, an audit event or a route response.
- The URL must be `https://`, except for `localhost`, `127.0.0.1` and `::1`. On a trusted private network you can opt out with `ROLLEKATALOG_ALLOW_HTTP=true`. An insecure or malformed URL makes the integration "not configured" (`insecure_url`, `not_configured`).
- Redirects are **not followed** (the `ApiKey` header would be sent to the target); a 3xx is `invalid_response`. Point the URL at the final address.
- GET only, at most 2 retries with back-off on 5xx, 429 and network errors; never on a timeout (the Rollekatalog side is usually still working, and a retry would only queue more load behind it), and never on 401, 403 or 404.

## 10. Troubleshooting by error code

The codes appear in the sync responses, `sync_runs.error_code`, the admin panel and the `directory.sync` event.

| Code | Meaning | Check |
|---|---|---|
| `not_configured` | URL or one of the two keys missing or malformed | `ROLLEKATALOG_URL`, both keys; restart after a change |
| `insecure_url` | `http://` to a non-local host | use https, or `ROLLEKATALOG_ALLOW_HTTP=true` on a trusted network |
| `unauthorized` | key refused (401) | the key, and that READ is used for assignments and ORG for organisation |
| `forbidden` | key valid, client role wrong (403) | READ key must be `READ_ACCESS`, ORG key `ORGANISATION` |
| `not_found` | 404 | `ROLLEKATALOG_ITSYSTEM_ID` (does the IT system exist?), `ROLLEKATALOG_DOMAIN`, the URL path |
| `timeout` | the whole response (headers and body) did not arrive within `ROLLEKATALOG_TIMEOUT_MS`; not retried | `organisation/v3` can be slow and large on a big installation: raise the timeout (up to 600000) and check Rollekatalog's load |
| `network` | connection failed (DNS, TLS, refused) | firewall, DNS, certificate chain |
| `server_error` | 5xx or 429 after the retries | Rollekatalog's own log and load |
| `invalid_response` | not JSON, did not match the whitelist schema, **more bad rows than the allowance** (section 5), a redirect or another unexpected status | version mismatch, a login page instead of the API (wrong URL), or many rows with ids that are not uuids in Rollekatalog |
| `too_large` | above `ROLLEKATALOG_MAX_RESPONSE_BYTES` | raise the cap if the size is legitimate |
| `empty_response` | zero users or zero org units | Rollekatalog may be mid-import or the domain is wrong; nothing changed |
| `removal_threshold` | too many users or assignments would go | verify in Rollekatalog, then "Gennemtving" |
| `already_running` | another sync runs | wait |
| `db_error` | the transaction failed and was rolled back | app log (content-free), database, migrations |
| `abandoned` | run left as `running` by a crashed process | informational |
| `unexpected` | anything else | app log |

Symptoms:
- **A user has no elevated role although Rollekatalog shows one.** In the last run's counts look at `assignmentsWithoutScope` (no known org unit in the constraint, role not in `ROLLEKATALOG_GLOBAL_ROLES`), `assignmentsIgnoredRole` (identifier is not one of our four) and `assignmentsSkippedUnknownUser` (the entry matches no user in the organisation answer: assignments are matched on `extUuid`, or on `userId` only when the entry has no `extUuid` and the userId is unique). Also check that the last successful sync is younger than `ROLE_STALE_MAX_SECONDS`.
- **A user is not linked.** For Microsoft logins first `MICROSOFT_TENANT_ID` (must be your one tenant id; the log shows `microsoft_tenant_not_pinned` when it is not), then `DIRECTORY_MATCH`, the claim and `DIRECTORY_USERID_TRANSFORM` (section 3); the person must exist in the mirror (sync first).
- **Everybody lost access.** Look at the last sync run (failing for longer than `ROLE_STALE_MAX_SECONDS`?). Temporary way out: `ACCESS_SOURCE=local` (section 7).

## 11. Privacy

- `organisation/v3` returns, per user, a **CPR number and a NemLog-in uuid**, plus phone numbers and KLE lists. The response schemas are whitelists: these fields are stripped when the answer is parsed and never enter our types, the database, logs or audit events (a test scans the parsed result for `/cpr|nemlogin|phone|kle/i`). The raw response does pass through the app's memory over TLS; Rollekatalog offers no way to leave the fields out, so keep the connection inside your network if you can.
- Stored per user: Rollekatalog uuid, `extUuid`, `userId`, name, email, the disabled flag, unit memberships (no job titles) and role assignments. Per org unit: uuid, name and parent (no manager). No CPR, NemLog-in id, phone, KLE or title data.
- `directory.sync` events carry counts and short codes only.

## Assumptions taken from the Rollekatalog source, release 2026r4, not verified against a live instance

- **`GET /api/organisation/v3`** needs client role `ORGANISATION` and is `synchronized`. It lists active, non-excluded org units and users that are not deleted and have at least one position; **disabled users are included** with `disabled: true`. The user DTO also holds `cpr`, `nemloginUuid`, `email`, `phone` and KLE lists; org units hold `manager` and `titleIdentifiers`. Our schemas keep only uuid, `extUuid`, `userId`, name, email, `disabled` and positions, and org-unit uuid, name and parent.
- **`GET /api/read/itsystem/roleAssignmentsWithContraints/{system}`** needs `READ_ACCESS`. Shape: `[{extUuid, userId, assignments: [{roleIdentifier, roleName, roleConstraintValues: [{constraintType, constraintValues: string[]}]}]}]`. `constraintType` is the constraint type's `entityId` URL, not its name or uuid. The org-unit constraints are `http://digital-identity.dk/constraints/orgunit/1` (internal) and `http://sts.kombit.dk/constraints/orgenhed/1` (KOMBIT); their values are org-unit uuids. KLE is `http://sts.kombit.dk/constraints/KLE/1`.
- The answer is **effective**: direct and role-group assignments, assignments on org units (inherited down unless `doNotInherit`), title-conditioned ones and negative exceptions, read from the materialised `current_assignment` table; deleted users and ended assignments are excluded, disabled users are not. It is filtered to one domain (default the primary one; the `domain` query parameter). The same `roleIdentifier` can repeat per user with different constraints.
- **Empty constraints are silently dropped:** a constraint whose resolved value is empty is left out, so such a role looks unconstrained. This is why "no scope" is never read as "everywhere".
- Authentication is the header `ApiKey: <key>` (not `Authorization`). A `READ_ACCESS` client carries only that authority and an `ORGANISATION` client only its own; `ADMINISTRATOR` carries all. A missing or invalid key is 401, a missing role 403 (Spring defaults, not observed).
- The OpenAPI document (`/v3/api-docs`) sits behind SAML login and is not readable with an ApiKey, so response shapes come from the DTO sources of the pinned release (the fixtures in `src/lib/rollekatalog/__fixtures__/`). Shape drift in a newer release is a maintenance risk.
