# Central access control: architecture overview

Audience: engineers working on Phases 1-5. This describes what is in the code after Phase 4 (the sections on roles, scope and local mode are from Phase 1 and still hold). Where the original plan differs from the code, the code is documented here. Evidence for the Rollekatalog and better-auth facts is in `phase0-findings.md`.

## What Phase 1 delivers

- Seven central tables in the shared `public` schema (Drizzle, migration `drizzle/0001_central_access.sql`): `directory_users`, `org_units`, `org_unit_members`, `org_unit_substitutes`, `role_assignments`, `external_identities`, `sync_runs`.
- A pure role/capability resolver, a live `Principal` loader, scope (org tree) helpers, pure permission predicates and the `withAuthz` route wrapper, all in `src/lib/authz/`.
- Login-time hooks: capture of whitelisted SSO claims, first-administrator bootstrap and (rollekatalog mode only) directory matching.
- An audit seam (`src/lib/audit/seam.ts`) that every admin write and every authz denial already calls (a no-op in Phase 1, persisted since Phase 2).

Data flow: login (better-auth) -> session cookie with **no roles in it** -> on each request `resolvePrincipal(userId)` reads `directory_users` + `role_assignments` live -> `Principal` -> `withAuthz` / predicates. There is no cache, so a revoked role or a disabled user takes effect on the next request.

## Roles

Roles are orthogonal capability sets, not a ladder. The only definition is `ROLE_DEFINITIONS` in `src/lib/authz/capabilities.ts`; a tripwire test in `capabilities.test.ts` pins it.

| Role key (`SystemRole`) | Danish name | Capabilities | NULL scope may mean "global" |
|---|---|---|---|
| `tt-bruger` | Bruger | `template.use` | no |
| `tt-skabelonansvarlig` | Skabelonansvarlig | `template.use`, `template.manage`, `directory.read` | **no** |
| `tt-logleser` | Logleser | `template.use`, `audit.read`, `audit.export`, `directory.read` | yes |
| `tt-administrator` | Administrator | all seven | yes |

Role keys must match what is registered in Rollekatalog as IT system roles (`^[A-Za-z0-9_-]+$`). `role_assignments.role_key` is free text on purpose: rows with an unknown key are ignored by the resolver rather than rejected, because Rollekatalog may sync roles we do not use.

## Capabilities

| Capability | Scoped to org units | Held by |
|---|---|---|
| `template.use` | no | every role |
| `template.manage` | yes | `tt-skabelonansvarlig`, `tt-administrator` |
| `audit.read` | yes | `tt-logleser`, `tt-administrator` |
| `audit.export` | no | `tt-logleser`, `tt-administrator` |
| `directory.read` | yes | `tt-skabelonansvarlig`, `tt-logleser`, `tt-administrator` |
| `access.manage` | no | `tt-administrator` |
| `sync.run` | no | `tt-administrator` |

`audit.export` carries no scope of its own and only takes effect from a global assignment (see Scope semantics), so a unit-scoped log reader cannot export. Phase 2 kept it that way: the CSV export still limits its rows by the caller's `audit.read` scope, so an export never shows more than the viewer does (see `audit.md`).

## Scope semantics

`Principal.scopes[capability]` exists only for the scoped capabilities and has the shape `{ global: boolean, roots: [{ orgUnitUuid, includeDescendants }] }`.

- An assignment with a `scope_org_unit_uuid` adds a root. `include_descendants` (default true) extends it to the subtree. If the same unit is granted twice, the wider grant wins.
- An assignment with a NULL scope sets `global = true` **only** for roles with `globalScopeAllowed` (`tt-logleser`, `tt-administrator`).
- **Global-only capabilities:** `access.manage`, `sync.run` and `audit.export` cannot be narrowed to an org unit, so they only take effect from a GLOBAL assignment (`GLOBAL_ONLY_CAPABILITIES`). `tt-administrator` therefore cannot be granted for one unit (the grant is rejected with `scope_forbidden`), and a unit-scoped `tt-logleser` can read its unit but not export the whole log. Otherwise a "unit administrator" could promote themselves to a global one.
- **Fail closed:** a NULL-scope `tt-skabelonansvarlig` contributes nothing. The capability is listed but its scope is `{ global: false, roots: [] }`, which covers no unit. Rollekatalog also drops constraints that resolve to empty, so "no scope" must never be read as "all units" (see `phase0-findings.md`).
- Time window: an assignment is active in `[start_date, stop_date)`. Expired and not-yet-started rows grant nothing.
- A disabled directory user gets no roles and no capabilities (not even the baseline), and `withAuthz` answers 403.
- Org-tree reads (`scope.ts`) are cycle-safe: recursive CTEs use `UNION` plus a depth cap (`MAX_ORG_DEPTH` = 64), and anything deeper than the cap counts as not covered. Cycle prevention when moving a unit (`updateOrgUnit`) does NOT use that cap: it walks up from the new parent without a depth limit (`UNION` still ends it on bad data), so a deep chain cannot hide a cycle. Malformed uuids are "not in scope", not a 500.
- `capabilityCoversUnit(p, cap, unitUuid, coveredUnits)` in `permissions.ts` is the pure check. A `null` unit (an organisation-wide item) is reachable only with a global scope.

Baseline: unless `REQUIRE_ROLE_TO_LOGIN=true`, every non-disabled principal implicitly holds `tt-bruger`, including users with no directory row at all. With `true`, a user without an active assignment has no roles.

Denial conventions (`guard.ts`): 401 no session, 403 disabled or missing capability, 404 for a resource outside the caller's scope (existence is not leaked), 409 for local-provider writes while `ACCESS_SOURCE=rollekatalog`. Each denial calls `recordAuthzDenied`.

## Local mode vs rollekatalog mode

Both modes write the same tables, told apart by the `source` column. Permission code reads only the tables.

| | `ACCESS_SOURCE=local` (default) | `ACCESS_SOURCE=rollekatalog` |
|---|---|---|
| Who edits roles and org units | administrators in the app (`access.manage`) | Rollekatalog; the sync (Phase 3) writes `source='rollekatalog'` rows |
| Local write endpoints (`withAuthz(..., { requireLocalSource: true })`) | work | answer 409; only `source='local'` rows are ever editable. Leftover `source='local'` assignments are **ignored** when resolving a principal (they could not be revoked any more). The reverse holds too: in local mode `source='rollekatalog'` rows are ignored |
| Link login -> directory user | explicit: `directory_users.app_user_id`, set by an admin | automatic via `matchDirectoryUser`, from trusted SSO claims |
| Bootstrap administrator | `BOOTSTRAP_ADMIN_EMAILS` | not applicable |

**Local mode never matches by email.** An attacker could password-sign-up with an address that has a pre-assigned role (the app does not verify email on sign-up). `resolvePrincipal` therefore finds the directory row only through `app_user_id`.

**Rollekatalog mode matching** (`directory-match.ts`, mode `DIRECTORY_MATCH`):
- `userid-claim` (default): `directory_users.ext_user_id` against the ID-token claim named by `DIRECTORY_USERID_CLAIM` (default `preferred_username`).
- `extuuid-claim`: the same claim, compared to `ext_uuid` (must be a uuid).
- `email`: requires `email_verified === true`.
- Only accounts from a trusted SSO provider are matched; `provider_id = 'credential'` is refused. Only rows with `source = 'rollekatalog'` are link targets. Zero or several candidates never link (`no_match` / `ambiguous`), and an already-linked row or user is a `conflict`, never a takeover.
- Claims come from a whitelisted snapshot in `external_identities` (`identity.ts`, decoded from the `id_token` that better-auth stored), never from the browser.

**Bootstrap administrator** (`bootstrap.ts`, local mode only): grants a global `tt-administrator` while no active administrator exists, for an SSO identity that proves an address in `BOOTSTRAP_ADMIN_EMAILS`. Microsoft needs a single-tenant `MICROSOFT_TENANT_ID` (not `common`/`organizations`/`consumers`) and a matching `tid`; other providers need `email_verified === true`. "No active administrator" uses the same definition as the last-administrator guard (`admin-sql.ts`): a local, global, active assignment of an enabled person with a linked app user, so a deleted or disabled sole admin cannot lock bootstrap out. A transaction-level advisory lock keeps two concurrent first logins from both granting. All of it runs from `databaseHooks.session.create.after`, wrapped so that it can never block a login.

## Configuration

Read at call time in `src/lib/authz/config.ts` (never `NEXT_PUBLIC_*`; restart, no rebuild). Unknown values fall back to the default instead of throwing.

| Variable | Default | Meaning |
|---|---|---|
| `ACCESS_SOURCE` | `local` | `local` or `rollekatalog` |
| `REQUIRE_ROLE_TO_LOGIN` | `false` | `true` removes the implicit baseline role and makes the `(app)` layout show "Ingen adgang" to users without a role. Disabled users get that page regardless. Only pages are gated: the older `/api` routes outside `/api/admin` and `/api/me` do not check the principal yet |
| `BOOTSTRAP_ADMIN_EMAILS` | empty | comma list, case-insensitive |
| `DIRECTORY_MATCH` | `userid-claim` | `userid-claim`, `extuuid-claim` or `email` |
| `DIRECTORY_USERID_CLAIM` | `preferred_username` | claim carrying the Rollekatalog user id |
| `AUTH_IP_HEADERS` | unset | headers better-auth reads the client IP from; read once at startup in `src/lib/auth/ip-headers.ts` |
| `DIRECTORY_USERID_TRANSFORM` and the `ROLLEKATALOG_*` / `ROLE_STALE_MAX_SECONDS` settings | see `rollekatalog.md` | Phase 3, read in `src/lib/rollekatalog/config.ts` (same rules: call time, invalid value falls back to the default) |

## Testing

- Pure resolver, predicates, config, guard and matching logic: ordinary Vitest tests next to the code. Build principals with `makePrincipal()` / `FAKE_PRINCIPAL_ADMIN` from `src/test/helpers.ts`.
- `*.pg.test.ts` (migration, constraints, recursive org-tree queries, identity capture) need PostgreSQL 15+ (`NULLS NOT DISTINCT`) and run only when `TEST_DATABASE_URL` is set; see the header of `src/test/pg.ts`. They were written without a database available, so treat them as unexecuted until you have run them once.

## Status after Phase 2

Phase 2 (the audit log) is done; see `audit.md` for the full contract. `recordAdminAction(tx, event)` and `recordAuthzDenied(event)` in `src/lib/audit/seam.ts` now persist to `public.audit_events` (migration `0002_audit_events`); the Phase 1 call sites did not change. Events carry ids and codes only, never meeting titles or free text. The log viewer is the `/admin/log` section (any holder of `audit.read`), the CSV export needs `audit.export`, and a SIEM feed and a retention prune route exist (both off until their env vars are set).

## Status after Phase 3

Phase 3 (the Rollekatalog provider) is implemented; the operator guide is `rollekatalog.md`, the code is in `src/lib/rollekatalog/`.

- **Read-only authority.** A GET-only client (`ApiKey` header, two keys: READ_ACCESS and ORGANISATION), whitelisting zod schemas (cpr, nemloginUuid, phones and KLE never enter our types), and error codes only, never messages. The app never calls a Rollekatalog write endpoint; `scripts/rollekatalog-register.mjs` (dry-run by default) is the one-off, operator-run registration of the IT system and its four roles.
- **Sync** (`sync.ts`): advisory lock, fetch first, then one transaction; mirror of users, org units, memberships, substitutes and role assignments with `source='rollekatalog'`. Empty-response guard, removal threshold with a `force` override on the admin button, a `sync_runs` row and a `directory.sync` audit event per run. Scheduled from outside (cron route `POST /api/internal/rollekatalog/sync`, optional compose service `rollekatalog-sync`); admin routes `POST/GET /api/admin/access/sync` and `POST /api/admin/access/rollekatalog/check` ("Test forbindelse").
- **Scope** (`scope.ts`, pure): `ROLLEKATALOG_SCOPE_STRATEGY` of `constraint`, `constraint-or-manager` or `manager`; no usable scope never means "everywhere" except for the roles in `ROLLEKATALOG_GLOBAL_ROLES` (default `tt-administrator`).
- **Staleness** (`dropStaleAssignments`): Rollekatalog-sourced assignments older than `ROLE_STALE_MAX_SECONDS` are ignored; the baseline stays. Mode symmetry in both directions.
- **Login** (`login-refresh.ts`, `directory-match.ts`): a short, never-blocking `rolesAsList` check that can only revoke or disable; `DIRECTORY_USERID_TRANSFORM`; relinking of an app user from a local directory row to the Rollekatalog row when the mode is switched.
- **Tests**: unit tests against an in-process mock (`mock-server.ts`, also runnable as `node scripts/mock-rollekatalog.mjs`) and gated `*.pg.test.ts` (sync, lock, transaction, login refresh, relink, end to end).
- **Not verified**: everything ran against synthetic fixtures and the mock, never against a live Rollekatalog. Run "Test forbindelse" on the real instance before go-live. The compose service was never started. Of the gated Postgres tests, `sync.pg.test.ts` and `e2e.pg.test.ts` were run once on PostgreSQL 18 (not on 15, the documented minimum); `login-refresh.pg.test.ts` and the Phase 3 additions to `directory-match.pg.test.ts` were written without a database and have not been run, so treat them as unexecuted until you run them with `TEST_DATABASE_URL`.
- **Known gaps**: org units that disappear upstream are never deleted (no stale flag in the schema); the removal-threshold numbers are only in the server log, not in the UI; `rolesAsList` identifies roles by system-role identifier and filters by weight, so keep all four roles at weight 1; the local link of a user relinked to a Rollekatalog row is not restored when you switch back to local mode.

## Status after Phase 4

Phase 4 (central templates) is implemented; the operator and implementer guide is `templates.md`, the code is in `src/lib/skabeloner/` (`central.ts` manager service, `resolve.ts` recipient resolution), `src/app/api/admin/central-templates/`, `src/app/api/minutes/route.ts` and the admin page `/admin/skabeloner`.

- **What it does.** A holder of `template.manage` creates a locked template owned by an org unit in their scope and delegates it to org units inside that unit's subtree. Recipients (members of a target unit, or of a descendant when `include_descendants`; only linked, non-disabled directory users) can generate minutes with it but cannot edit it. The server enforces the lock in `POST /api/minutes`; the prompt text is never sent to recipients.
- **Changelog.** Every write needs a change note (10-2000 characters) and appends an immutable version row (trigger-protected, no prune bypass) in the same transaction as the change and its `central_template.*` audit event. Concurrent edits are caught with `baseVersion` (409). Templates are archived, never deleted; an org unit that owns a template cannot be deleted.
- **Provenance.** `templateRef` is returned by `/api/minutes`, stored with the minutes in IndexedDB and shown in the minutes screen; `minutes.generate` audits `templateSource: 'central'` and `templateVersion`.
- **Not verified.** `central.pg.test.ts` and `resolve.pg.test.ts` (and the migration on a real instance) have never run against a real Postgres; the UI was only tested with jsdom and mocked `fetch`. Phase 4 added no environment variables.
- **Known gaps** (details in `templates.md`): personal templates are still allowed; recipient membership is only as fresh as the last successful sync; targets are checked against the owner subtree at write time only; the older `/api` routes, `/api/minutes` included, still do not consult the principal.

## Still not done (Phase 5, rollout)

Phase 5 is hardening and rollout (plan section 10). What remains:

- **Run the unrun lanes.** `TEST_DATABASE_URL=postgres://... npx vitest run src/lib/skabeloner src/lib/audit src/lib/authz` on the Postgres version you deploy (15 or newer; the compose file pins 16), including `central.pg.test.ts`, `resolve.pg.test.ts` and the Phase 3 files listed above, and apply migration `0003_central_templates` to a copy of production first. Try the admin page and the review screen in a real browser.
- **Rollekatalog go-live check.** Run "Test forbindelse" and a first sync against the real instance (`rollekatalog.md`), then confirm that recipients of a test template match the real org tree.
- **Deployment docs.** Update `DEPLOY.md` (Rollekatalog setup, migration order, the client-side audit limits, the central template rollout) and re-check `.env.example` and `docker-compose.yml` against the full variable list; Phase 4 itself adds none.
- **Rollout order** (plan section 10): migrations; deploy with `ACCESS_SOURCE=local` and `REQUIRE_ROLE_TO_LOGIN=false` (no behaviour change for users); enable audit; create a first administrator and a few `tt-skabelonansvarlig` assignments; pilot one central template with one department; switch to `rollekatalog` per environment after a successful sync.
- **GDPR notes for the client.** The audit log stores user id, name snapshot, IP (`AUDIT_STORE_IP`) and user agent; choose `AUDIT_RETENTION_DAYS` and schedule the prune route. The template changelog stores the actor's name snapshot and the change notes and has no retention or erasure path (append-only by design); decide whether that is acceptable. Content stays out of the audit log by construction.
- **Open product decisions.** The `(app)/layout.tsx` fail-open versus fail-closed behaviour for users the access check cannot resolve (deliberately unchanged in Phases 3 and 4); whether recipients should be allowed to see central prompts (default: no, see `templates.md` for how to flip); whether to add a "central templates only" policy per org unit or a per-template default.
- **Older routes.** `/api/meetings`, `/api/bot`, `/api/minutes` and the rest still only check the session, so disabled users and `REQUIRE_ROLE_TO_LOGIN` are not enforced there and a refusal is never an `authz.denied` event; they migrate to `withAuthz` gradually.
- **Phase 2 gaps worth knowing**: the share-code flow for templates is client-side and not logged. The full list is under "Known limitations" in `audit.md`.
- The unjournaled `drizzle/0000_wet_impossible_man.sql` is untouched (a human decision, see `phase0-findings.md`).
