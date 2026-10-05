# Rollekatalog integration: operator guide

Audience: the person who connects the app to a municipality's OS2rollekatalog and keeps it running. Engineers: see `README.md` (architecture), `audit.md` and the "Rollekatalog mode (Phase 3)" section of `CLAUDE.md`.

> **Validated against synthetic fixtures only.** The integration was built from the OS2rollekatalog source (release 2026r4) and tested against synthetic fixtures and an in-process mock server. It has **never talked to a live Rollekatalog**. HTTP statuses for wrong or insufficient keys (401/403), the redirect behaviour, the real size of `organisation/v3` and the exact menu names in the Rollekatalog UI are modelled or inferred, not observed. **Run "Test forbindelse" against the real instance, and do a first sync with a small, known set of users, before go-live.** The optional compose service `rollekatalog-sync` was also never started (no Docker available when it was written).

## 1. What it does

With `ACCESS_SOURCE=rollekatalog`, Rollekatalog decides who holds which role, and in which part of the organisation. The app keeps a **read-only mirror** of that in its own tables (`directory_users`, `org_units`, `org_unit_members`, `org_unit_substitutes`, `role_assignments`, `sync_runs`; rows from this integration have `source='rollekatalog'`). Permission checks read only the mirror, never Rollekatalog, so a Rollekatalog outage does not stop users from working.

```
Rollekatalog ──(GET, ApiKey)──> sync ──one transaction──> mirror tables ──> resolvePrincipal() ──> capabilities
      └──(GET rolesAsList, at login, max 3 s)──> may only REVOKE / DISABLE
```

**The app never writes to Rollekatalog.** It only issues GET requests. The one script that creates something there, `scripts/rollekatalog-register.mjs`, is run by you, once, from a shell, with a temporary key that the app never sees.

### What is fetched, and with which key

| Endpoint | Key (client role) | Used for | When |
|---|---|---|---|
| `GET /api/organisation/v3` | ORG (`ORGANISATION`) | users, org units, positions, unit managers | every sync (Rollekatalog serves it synchronized and it is heavy: do not poll it more often than the sync) |
| `GET /api/v2/manager` | ORG | manager substitutes (stedfortrædere) | every sync (a 404 is read as "no managers in the system") |
| `GET /api/read/itsystem/roleAssignmentsWithContraints/{system}` | READ (`READ_ACCESS`) | effective role assignments with resolved org-unit constraint values | every sync |
| `GET /api/user/{userid}/rolesAsList?system=` | READ | per-user check at login | every login (each call writes an audit row **in Rollekatalog**) |
| `GET /api/v2/constraint` | READ | only in "Test forbindelse" | on demand |

Why two keys: an `ORGANISATION` client does **not** imply `READ_ACCESS` in Rollekatalog (and vice versa), so the organisation endpoints and the assignment endpoints need separate API clients. A sync needs both; the login check needs only the READ key. Never request `ROLE_MANAGEMENT` or `ADMINISTRATOR` for these clients: they can assign roles, and the app does not need that.

The `ApiKey` header is the only authentication. All requests go to the URL in `ROLLEKATALOG_URL`, which must be `https://` (see section 9).

## 2. Setup checklist

Menu names in Rollekatalog differ by version and language; the Danish terms below are the usual ones. Confirm them in your installation.

1. **Register the IT system and the four system roles** (once, from a shell, not on the app server's `.env`):
   1. In Rollekatalog, create a temporary API client with client role `ITSYSTEM`. Note its key.
   2. Dry-run (prints the plan, changes nothing; it still needs the key to read what exists):
      ```bash
      ROLLEKATALOG_URL=https://rollekatalog.example.dk \
      ROLLEKATALOG_ITSYSTEM_API_KEY=<temporary key> \
      node scripts/rollekatalog-register.mjs
      ```
   3. If the plan is right, run it again with `--apply`. It matches by identifier, creates only what is missing, and reports differences in name, description, weight or constraint as **drift** without overwriting them. Exit codes: 0 ok, 1 failure, 2 usage or configuration. Optional: `ROLLEKATALOG_ITSYSTEM_ID` (default `os2taletiltekst`), `ROLLEKATALOG_ITSYSTEM_NAME`, `ROLLEKATALOG_TIMEOUT_MS`.
   4. Delete the temporary `ITSYSTEM` client. The key is never part of the app's configuration.

   The script creates the IT system with `canEditThroughApi` and `apiManagedRoleAssignments` off, so the app cannot assign roles through the API. The system roles (definitions in `src/lib/rollekatalog/system-roles.json`) are:

   | Identifier | Name | Org-unit constraint |
   |---|---|---|
   | `tt-bruger` | Bruger | no |
   | `tt-skabelonansvarlig` | Skabelonansvarlig | yes (optional) |
   | `tt-logleser` | Logleser | yes (optional) |
   | `tt-administrator` | Administrator | no (cannot be scoped to a unit) |

   All four have weight 1 on purpose: Rollekatalog's `rolesAsList` only returns system roles of the highest weight in an IT system, and these roles are not a ladder. The constraint is "not mandatory" so that it is not forced in the Rollekatalog UI, but under the default strategy an assignment **without** a unit grants no elevated access (section 4).
2. **Build the access in Rollekatalog**: create a *jobfunktionsrolle* (UserRole) from each system role, optionally group them in *rollebuketter* (RoleGroups), and assign them to persons, titles or org units. For `tt-skabelonansvarlig` and `tt-logleser`, choose the org unit as the data constraint (*dataafgrænsning*, type "Enhed"); the app treats it as the root of that person's scope. Assign `tt-bruger` too if you will use `REQUIRE_ROLE_TO_LOGIN=true`.
3. **Create the two API clients** the app uses: one with client role `READ_ACCESS` and one with `ORGANISATION`. Keep the two keys apart; do not use an `ADMINISTRATOR` client.
4. **Set the environment** (`.env`, see section 8 for every variable), at minimum:
   ```
   ROLLEKATALOG_URL=https://rollekatalog.example.dk
   ROLLEKATALOG_READ_API_KEY=...
   ROLLEKATALOG_ORG_API_KEY=...
   ROLLEKATALOG_ITSYSTEM_ID=os2taletiltekst
   ```
   Keep `ACCESS_SOURCE=local` for now. Restart the app (`docker compose up -d app`); no rebuild is needed.
5. **Run "Test forbindelse"** (admin overview, or `POST /api/admin/access/rollekatalog/check`; needs `sync.run`, i.e. a global `tt-administrator`). It calls each endpoint once and shows per endpoint: ok, HTTP status, whether the body matched our schema, counts and an error code, and **no personal data and no keys**. Every row must be green before you continue. The `rolesAsList` row uses your own Rollekatalog user and is skipped when your login is not linked to a Rollekatalog user yet (it also leaves one audit row for you in Rollekatalog). The check calls the heavy `organisation/v3` endpoint once per click: do not click repeatedly.
6. **Run the first sync** while still in local mode, so you can inspect the result before anyone depends on it: `POST /api/internal/rollekatalog/sync` with `X-Cron-Secret: $INTERNAL_CRON_SECRET` (set `INTERNAL_CRON_SECRET` first; the route answers 404 until it is set). The admin button "Synkroniser nu" answers 409 until `ACCESS_SOURCE=rollekatalog`. Check the counts and the "Seneste synkronisering" line, and compare the users and organisation in `/admin` with Rollekatalog.
7. **Choose how logins are matched** (`DIRECTORY_MATCH`, `DIRECTORY_USERID_CLAIM`, `DIRECTORY_USERID_TRANSFORM`, see section 3).
8. **Make sure an administrator will exist**, then switch (section 7): at least one person who can log in via SSO must hold `tt-administrator` in Rollekatalog, and must match a Rollekatalog user. In rollekatalog mode there is no bootstrap administrator and local assignments are ignored.
9. **Schedule the sync** (section 6).

## 3. Matching a login to a Rollekatalog user

A login is linked to a Rollekatalog user automatically, from claims in the SSO ID token that better-auth stored (`external_identities`). Only trusted SSO providers are matched, never `credential` (email/password) accounts, and zero or several candidates never link.

| `DIRECTORY_MATCH` | Compares | Notes |
|---|---|---|
| `userid-claim` (default) | the claim named by `DIRECTORY_USERID_CLAIM` (default `preferred_username`) against `ext_user_id` (Rollekatalog `userId`), case-insensitively | usual choice |
| `extuuid-claim` | the same claim against `ext_uuid` (Rollekatalog `extUuid`); must be a uuid | only if the IdP really carries that uuid, see below |
| `email` | the `email` claim against the mirrored email | only with `email_verified === true`; many IdPs do not guarantee that |

**Entra ID vs Rollekatalog identifiers.** With Microsoft Entra ID the claims are Entra's:
- `preferred_username` (and `upn`) is the user principal name, typically `abc123@kommune.dk`. Rollekatalog's `userId` is usually the plain user name `abc123` without a domain. They do not match as they are.
- `oid` is the user's object id **in Entra ID**. Rollekatalog's `extUuid` is the identifier that the municipality's own identity source (for example the AD sync) delivered to Rollekatalog. The two are generally **different values**, even for the same person. Do not choose `extuuid-claim` with `DIRECTORY_USERID_CLAIM=oid` unless you have compared both values for a few known users.
- `DIRECTORY_USERID_TRANSFORM=strip-upn-domain` removes everything from the first `@` in the claim before it is compared (so `abc123@kommune.dk` becomes `abc123`). It applies to `userid-claim` only. Default `none`. Because it discards the tenant part of the UPN, a **Microsoft** login is only matched with it when `MICROSOFT_TENANT_ID` names one tenant (not `common`, `organizations` or `consumers`) and the login's `tid` claim equals it; otherwise the login is refused (no link). Disabled Rollekatalog rows are never link targets, so a reused userId does not make the new person ambiguous.

For Microsoft also use a single-tenant `MICROSOFT_TENANT_ID`; with the default tenant `common`, anyone with any Microsoft account can sign in, and you should not match on claims from such logins.

Verify with a known user before go-live: log in, then check in `/admin` (Brugere og roller) that the person is linked to the right Rollekatalog user. If the userId in Rollekatalog differs structurally from the claim (for example a number), `userid-claim` cannot match; use the claim that does carry it (`DIRECTORY_USERID_CLAIM`).

**Switching modes.** An app user who was linked to a `source='local'` directory row is moved to the matching Rollekatalog row at the next login, in one transaction (the link is unique per app user). A link that belongs to a different app user is never taken over (logged as a conflict, nothing changes). The released local row stays in the database.

## 4. Scope: who may manage what

Rollekatalog gives each assignment an optional constraint (*dataafgrænsning*). The app reads **org-unit constraints** only (type `http://digital-identity.dk/constraints/orgunit/1` or KOMBIT `http://sts.kombit.dk/constraints/orgenhed/1`; the values are org-unit uuids). KLE and other constraint types are never used as a scope and never stored.

`ROLLEKATALOG_SCOPE_STRATEGY`:

| Value | Scope of `tt-skabelonansvarlig` / `tt-logleser` |
|---|---|
| `constraint` (default) | the org units in the assignment's constraint |
| `constraint-or-manager` | the constraint, and if there is none, the units the person manages or substitutes for |
| `manager` | only the units the person manages or substitutes for (needs the ORG key, which every sync uses anyway) |

- **Descendants.** By default a scope unit also covers all its sub-units (`ROLLEKATALOG_SCOPE_DESCENDANTS=true`). With `false`, only that unit.
- **Unknown units are ignored.** Rollekatalog's organisation export leaves out inactive and excluded units. If all named units are unknown, the assignment gets no scope and is **not** widened to global.
- **Duplicates are unioned.** Several assignments of the same role to the same person give the union of their scopes. An unscoped duplicate never widens a scoped role.
- `tt-bruger` needs no scope. `tt-administrator` can never be scoped: constraint values on it are ignored.

### `ROLLEKATALOG_GLOBAL_ROLES` and why it exists

Rollekatalog **silently drops a constraint that resolves to empty** (for example a deleted unit): the assignment then looks as if it had no constraint at all, which in a naive implementation would mean "all units". The app therefore never reads "no scope" as "everywhere". When an assignment carries no usable org-unit scope:

- a role listed in `ROLLEKATALOG_GLOBAL_ROLES` becomes **global** (organisation-wide). Default: `tt-administrator` only;
- every other role gets **no row at all** (fail closed) and the sync counts it under "Roller uden område (ikke tildelt)" (`assignmentsWithoutScope`).

So a `tt-skabelonansvarlig` assigned without a unit grants nothing. If you want organisation-wide log readers, add `tt-logleser` to the list (`ROLLEKATALOG_GLOBAL_ROLES=tt-administrator,tt-logleser`); `none` allows no role at all, which would also make `tt-administrator` fail closed. A non-empty value that contains no valid role falls back to the default. The exception from the previous section holds: units that were named but are unknown never become global.

## 5. Staleness, removal and fail-closed behaviour

- **Staleness.** Every successful sync refreshes `synced_at` on all mirrored assignments, even when nothing changed. A `source='rollekatalog'` assignment older than `ROLE_STALE_MAX_SECONDS` (default 86400 = 24 h) is ignored when the app resolves a user: elevated capabilities vanish, the implicit baseline `tt-bruger` stays (unless `REQUIRE_ROLE_TO_LOGIN=true`, where the user then gets "Ingen adgang"). If syncs keep failing for longer than this, administrators lose their access, so alert on failed runs (section 6) and keep the interval well below the limit. A row exactly at the limit still counts. Staleness affects roles only; the `disabled` flag keeps its last known value.
- **Removal means disabled.** A user who is **missing from Rollekatalog's answer**, or who is `disabled` there, becomes `disabled=true` in the mirror: no roles, no baseline, `403` from the admin API and "Ingen adgang" in the app. The two cases are not told apart. The link and the row stay, so the person is re-enabled by the next sync when Rollekatalog lists them as active again. Org units are **never deleted** by the sync (a unit that disappears keeps its row, but loses its assignments and members). Role assignments, memberships and substitutes are deleted exactly as Rollekatalog no longer lists them.
- **Login refresh.** In rollekatalog mode each login asks `rolesAsList` (at most 3 s, no retry) about that one user. It can only take access **away**: `disabled: true` or a 404 disables the user (a 404 also appears for a wrong `ROLLEKATALOG_ITSYSTEM_ID` or `ROLLEKATALOG_DOMAIN`, see section 10), and a role that is no longer listed is deleted for that user. It never grants; new grants wait for the next sync, because `rolesAsList` carries no scope. Any error (timeout, 5xx, network, key rejected) changes nothing and never blocks the login. `rolesAsList` identifies roles by system-role identifier; if you use weights above 1, it may show fewer roles than the bulk call and revoke a lower-weight role until the next sync restores it (keep weight 1).
- **Mirror rows of the other source.** In local mode `source='rollekatalog'` assignments are ignored, and in rollekatalog mode `source='local'` assignments are ignored, because the other side could not edit or revoke them.

### Safety guards and the force button

A sync fetches everything first and applies it in **one transaction**: any failure rolls back and the mirror stays as it was. In addition:

| Guard | Condition | Result |
|---|---|---|
| Single run | another sync holds the Postgres advisory lock | `already_running` (HTTP 409), no new run row |
| Empty response | Rollekatalog returns zero users or zero org units | aborted with `empty_response`, nothing changed |
| Removal threshold | the run would disable more than `ROLLEKATALOG_SYNC_MAX_REMOVAL_PERCENT` (default 30) percent of the currently enabled mirrored users, or delete more than that share of mirrored assignments | aborted with `removal_threshold`, nothing changed. The first sync into an empty mirror has no threshold |

The admin button "Synkroniser nu" can be sent with **"Gennemtving"** (`{"force": true}`) to bypass the removal threshold after you have checked in Rollekatalog that the removal is intended (for example a reorganisation). Only a holder of `sync.run` can do this. The cron route never forces. `empty_response` and the other errors cannot be forced. The would-be numbers are written to the server log only (as `users=removed/base assignments=removed/base`), not to the UI.

Every run, successful or not, leaves a row in `sync_runs` (status `success` or `failed`, counts, error code) and one `directory.sync` event in the audit log (counts and codes only; source `system` for the scheduler, the administrator for the button). A run that was left as `running` by a crashed process is closed as `failed` with code `abandoned` by the next run.

## 6. Scheduling

The app has **no in-process timers** (they would run once per replica). Something external calls the cron route:

```
POST /api/internal/rollekatalog/sync
X-Cron-Secret: <INTERNAL_CRON_SECRET>
```

It answers 404 while `INTERNAL_CRON_SECRET` is unset and 401 on a wrong secret. Responses: `200` success, `409` already running, `502` aborted or the upstream/configuration failed, `500` unexpected; the body is only `{status, counts, errorCode}`. The route does not check `ACCESS_SOURCE`, so it can pre-populate the mirror before the switch.

**Option A: the compose service.** `docker-compose.yml` has an optional service `rollekatalog-sync` that runs a curl loop on the internal network (`http://app:3000`, the container's own port):

```bash
# .env: INTERNAL_CRON_SECRET=<openssl rand -hex 24>, ROLLEKATALOG_SYNC_INTERVAL_SECONDS=900
docker compose --profile rollekatalog up -d
docker compose logs -f rollekatalog-sync     # one line per run: "rollekatalog sync: http=200"
```

The interval defaults to 900 s and is at least 60 s (smaller values are replaced by 900). The service logs the HTTP status only. Unverified (no Docker was available when it was written): run `docker compose --profile rollekatalog config` and watch the first runs.

**Option B: a host cron or any scheduler**, for example every 15 minutes (use the app's public URL or an internal address):

```
*/15 * * * * curl -fsS -m 600 -X POST -H "X-Cron-Secret: $INTERNAL_CRON_SECRET" https://app.example.dk/api/internal/rollekatalog/sync -o /dev/null
```

Choose an interval comfortably below `ROLE_STALE_MAX_SECONDS`. Every sync calls `organisation/v3`, which Rollekatalog synchronizes: do not go below a few minutes. Monitor the result: `GET /api/admin/access/sync` returns the latest run, the admin overview shows it, and the audit log has the `directory.sync` events (the viewer filters by type).

## 7. Switching modes

**local to rollekatalog**
1. Complete the checklist up to and including a first sync, and verify the matching with your own login.
2. Make sure at least one person with a global `tt-administrator` in Rollekatalog can log in and is linked to their Rollekatalog user.
3. Set `ACCESS_SOURCE=rollekatalog` and restart the app. From now on the local role/org editing endpoints answer 409, local role assignments are ignored, and users with a link to a local row are moved to their Rollekatalog row at their next login.

**rollekatalog to local** (also the way out of a lock-out): set `ACCESS_SOURCE=local` and restart. Local assignments apply again and `source='rollekatalog'` assignments are ignored. Caveats: a user who was moved to a Rollekatalog row has no local link until an administrator links them again, and a Rollekatalog-sourced directory row that is still linked keeps its `disabled` flag. In local mode `BOOTSTRAP_ADMIN_EMAILS` can grant a first administrator again if none exists.

## 8. Environment variables

All are read at call time (restart, no rebuild); an invalid value falls back to the default instead of failing. `.env.example` and `.env.deploy.example` carry the same list.

| Variable | Default | Meaning |
|---|---|---|
| `ROLLEKATALOG_URL` | unset | Base URL. Unset or unusable means "not configured". Credentials in the URL are refused; query and fragment are dropped |
| `ROLLEKATALOG_READ_API_KEY` | unset | Key of the `READ_ACCESS` client |
| `ROLLEKATALOG_ORG_API_KEY` | unset | Key of the `ORGANISATION` client |
| `ROLLEKATALOG_ITSYSTEM_ID` | `os2taletiltekst` | IT system identifier (letters, digits, `_`, `-`) |
| `ROLLEKATALOG_DOMAIN` | unset | Rollekatalog domain; unset means its primary domain |
| `ROLLEKATALOG_TIMEOUT_MS` | `10000` | Per request (100 to 120000). The login check uses at most 3000 |
| `ROLLEKATALOG_MAX_RESPONSE_BYTES` | 64 MiB | Cap for the bulk responses (the single-user call has a fixed 1 MiB cap). Larger gives `too_large`. The default is a guess |
| `ROLLEKATALOG_ALLOW_HTTP` | `false` | `true` allows `http://` for a non-local host |
| `ROLLEKATALOG_SCOPE_STRATEGY` | `constraint` | see section 4 |
| `ROLLEKATALOG_SCOPE_DESCENDANTS` | `true` | see section 4 |
| `ROLLEKATALOG_GLOBAL_ROLES` | `tt-administrator` | see section 4 |
| `ROLLEKATALOG_SYNC_MAX_REMOVAL_PERCENT` | `30` | 0 to 100 |
| `ROLE_STALE_MAX_SECONDS` | `86400` | see section 5 |
| `DIRECTORY_USERID_TRANSFORM` | `none` | `none` or `strip-upn-domain`, see section 3 |
| `INTERNAL_CRON_SECRET` | unset | secret for the cron route (shared with the audit prune route) |
| `ROLLEKATALOG_SYNC_INTERVAL_SECONDS` | `900` | read by docker compose only |

Already existing and relevant: `ACCESS_SOURCE`, `REQUIRE_ROLE_TO_LOGIN`, `DIRECTORY_MATCH`, `DIRECTORY_USERID_CLAIM`.

## 9. Secrets and the URL

- The two API keys are secrets: keep them in `.env` or your secret store, never in the repository. They are never logged, never part of an error message, an audit event or any route response. The register script's `ITSYSTEM` key is **not** part of the app's configuration.
- The URL must be `https://`, except for `localhost`, `127.0.0.1` and `::1`, so that a key does not travel in cleartext by accident. Over a trusted private network you can opt out with `ROLLEKATALOG_ALLOW_HTTP=true`. An insecure or malformed URL makes the integration "not configured" (`insecure_url` or `not_configured`).
- Redirects are **not followed** (the `ApiKey` header would be sent to the redirect target); a 3xx answer is reported as `invalid_response`. Point `ROLLEKATALOG_URL` at the final address.
- Only GET requests are made, with at most 2 retries (3 attempts) and a backoff on timeout, 5xx, 429 and network errors, and never on 401, 403 or 404. The login check never retries.

## 10. Troubleshooting by error code

The codes appear in "Test forbindelse", in the response of the sync routes, in `sync_runs.error_code` and in the `directory.sync` audit event.

| Code | Meaning | What to check |
|---|---|---|
| `not_configured` | URL or one of the two keys is missing or malformed (a sync needs both keys) | `ROLLEKATALOG_URL`, `ROLLEKATALOG_READ_API_KEY`, `ROLLEKATALOG_ORG_API_KEY`; restart after a change |
| `insecure_url` | `http://` to a non-local host | use https, or `ROLLEKATALOG_ALLOW_HTTP=true` on a trusted network |
| `unauthorized` | Rollekatalog refused the key (401) | the key, and that it is sent for the right client (READ for read endpoints, ORG for organisation and manager). Statuses are modelled from source, not observed |
| `forbidden` | the key is valid but the client role is wrong (403) | READ key must be `READ_ACCESS`, ORG key `ORGANISATION`; an `ORGANISATION` client cannot read assignments |
| `not_found` | 404. For `rolesAsList`: unknown user, **or** unknown IT system or domain (empty body in both cases). A 404 from `v2/manager` is not an error (no managers) | `ROLLEKATALOG_ITSYSTEM_ID` (is the system registered? run the register script in dry-run) and `ROLLEKATALOG_DOMAIN`. A wrong id or domain makes the login refresh **disable each user at their next login** until it is corrected and the next sync re-enables them. Check with "Test forbindelse" before switching to rollekatalog mode |
| `timeout` | no answer within `ROLLEKATALOG_TIMEOUT_MS` | `organisation/v3` can be slow on a large installation: raise the timeout; check the network path |
| `network` | connection failed (DNS, TLS, refused) | firewall, DNS, certificate chain of the Rollekatalog host |
| `server_error` | 5xx or 429 after the retries | Rollekatalog's own log and load; try again later |
| `invalid_response` | the answer did not match our whitelist schema, was not JSON, or was a redirect or other unexpected status | version mismatch or a wrong URL (a login page instead of the API). "Test forbindelse" shows which endpoint |
| `too_large` | response above `ROLLEKATALOG_MAX_RESPONSE_BYTES` | raise the cap if the size is legitimate |
| `empty_response` | zero users or zero org units | Rollekatalog may be mid-import or the domain is wrong. Nothing was changed. Do not force: this cannot be forced |
| `removal_threshold` | too many users or assignments would be removed | verify in Rollekatalog that the removal is intended, then use "Gennemtving" on the admin button |
| `already_running` | another sync is running | wait; no action needed |
| `db_error` | the database transaction failed and was rolled back | app log (content-free); database availability and migrations |
| `abandoned` | a run was left as `running` by a crashed process | informational; the next run closes it |
| `unexpected` | anything else | app log |

Symptoms:
- **A user has no elevated role although Rollekatalog shows one.** Check the sync counts for `assignmentsWithoutScope` (the assignment named no org unit, or the strategy found none, and the role is not in `ROLLEKATALOG_GLOBAL_ROLES`), `assignmentsIgnoredRole` (not one of our four identifiers), `assignmentsSkippedUnknownUser` (the person is not in the organisation answer), and whether the last successful sync is older than `ROLE_STALE_MAX_SECONDS`.
- **A user is not linked.** `DIRECTORY_MATCH`, the claim and `DIRECTORY_USERID_TRANSFORM` (section 3); the person must exist in the mirror (run a sync first); a `conflict` is logged when the Rollekatalog row already belongs to a different app user.
- **Everybody lost access.** Look at the last sync run: failing syncs for longer than `ROLE_STALE_MAX_SECONDS`, or a wrong `ROLLEKATALOG_ITSYSTEM_ID` (login refresh). Temporary way out: `ACCESS_SOURCE=local` (section 7).

## 11. Privacy

- Rollekatalog's `organisation/v3` returns, per user, a **CPR number and a NemLog-in uuid**, plus phone numbers and KLE lists. The app's response schemas are whitelists: these fields are stripped when the answer is parsed and never enter our types, the database, logs or audit events. A test proves that no key matching `/cpr|nemlogin/i` survives the mapping. The response still passes through the app's memory over TLS (Rollekatalog offers no way to leave the fields out); limit that by giving the ORG client no more rights than `ORGANISATION` and by keeping the connection inside your network if you can.
- "Test forbindelse" reports only a boolean `cprFieldPresentInResponse` (the field names were seen, the values are not kept).
- Stored per user: Rollekatalog uuid, `extUuid`, `userId`, name, email, the disabled flag, unit memberships (no job titles) and role assignments. Per org unit: uuid, name, parent and manager. No CPR, NemLog-in id, phone, KLE or title data.
- The audit event `directory.sync` carries counts and short codes only.
- Every `rolesAsList` call (one per login) creates an audit row in Rollekatalog: its audit log will show one read per login by the API client.
