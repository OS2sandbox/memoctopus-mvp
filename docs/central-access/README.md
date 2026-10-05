# Central access control: architecture overview

Audience: engineers working on Phases 1-5. This describes what is in the code after Phase 1. Where the original plan differs from the code, the code is documented here. Evidence for the Rollekatalog and better-auth facts is in `phase0-findings.md`.

## What Phase 1 delivers

- Seven central tables in the shared `public` schema (Drizzle, migration `drizzle/0001_central_access.sql`): `directory_users`, `org_units`, `org_unit_members`, `org_unit_substitutes`, `role_assignments`, `external_identities`, `sync_runs`.
- A pure role/capability resolver, a live `Principal` loader, scope (org tree) helpers, pure permission predicates and the `withAuthz` route wrapper, all in `src/lib/authz/`.
- Login-time hooks: capture of whitelisted SSO claims, first-administrator bootstrap and (rollekatalog mode only) directory matching.
- A no-op audit seam (`src/lib/audit/seam.ts`) that every admin write and every authz denial already calls.

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

`audit.export` carries no scope of its own and only takes effect from a global assignment (see Scope semantics), so a unit-scoped log reader cannot export. If Phase 2 wants scoped exports it must limit rows by the caller's `audit.read` scope and relax `GLOBAL_ONLY_CAPABILITIES` deliberately.

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
| Local write endpoints (`withAuthz(..., { requireLocalSource: true })`) | work | answer 409; only `source='local'` rows are ever editable. Leftover `source='local'` assignments are **ignored** when resolving a principal (they could not be revoked any more) |
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

## Testing

- Pure resolver, predicates, config, guard and matching logic: ordinary Vitest tests next to the code. Build principals with `makePrincipal()` / `FAKE_PRINCIPAL_ADMIN` from `src/test/helpers.ts`.
- `*.pg.test.ts` (migration, constraints, recursive org-tree queries, identity capture) need PostgreSQL 15+ (`NULLS NOT DISTINCT`) and run only when `TEST_DATABASE_URL` is set; see the header of `src/test/pg.ts`. They were written without a database available, so treat them as unexecuted until you have run them once.

## Deliberately not in Phase 1

- **Audit log.** `recordAdminAction(tx, event)` and `recordAuthzDenied(event)` are no-ops marked `TODO(phase2)`. Phase 2 implements the table and the bodies; callers do not change. Events carry ids and codes only, never meeting titles or free text.
- **Rollekatalog client and sync** (Phase 3): no HTTP client, no `sync_runs` writes, no login refresh. `dropStaleAssignments` in `principal.ts` is a pass-through placeholder for the staleness limit (elevated capabilities dropped, baseline kept) that Phase 3 must fill in. Nothing reads `cpr` or `nemloginUuid`, and nothing must ever persist them.
- **Existing API routes** (`/api/meetings`, `/api/bot`, `/api/minutes` and so on) still only check the session. Disabled users and `REQUIRE_ROLE_TO_LOGIN` are enforced by `withAuthz` and the `(app)` layout only; routes migrate to `withAuthz` gradually.
- **Central templates** (Phase 4): no template tables, no resolution or enforcement in `/api/minutes`.
- Admin UI is limited to what `src/lib/authz/admin-sections.ts` lists (Overblik, Brugere og roller, Organisation); the template and log sections arrive with their phases. UI checks are advisory, the server re-checks everything.
- The unjournaled `drizzle/0000_wet_impossible_man.sql` is untouched (a human decision, see `phase0-findings.md`).
