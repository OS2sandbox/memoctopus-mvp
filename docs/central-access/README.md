# Central access control: architecture overview

For engineers. Operators: start with `rollekatalog.md` (connecting a Rollekatalog), `audit.md` (the audit log) and `templates.md` (central templates); `dev-simulation.md` explains how to test everything locally without a real Rollekatalog. Where this text and the code differ, the code is right.

## Purpose

Per-user data stays in the browser and in per-user schemas. On top of that the app has a **central layer** in the shared `public` schema: who holds which role, in which part of the organisation (org units), an append-only audit log, and locked central minutes templates. Roles come either from administrators in the app (`ACCESS_SOURCE=local`, the default) or from OS2rollekatalog (`rollekatalog`).

Tables (Drizzle, `src/lib/db/schema.ts`, migrations `0001_central_access`, `0002_audit_events`, `0003_central_templates` in `drizzle/`): `directory_users`, `org_units`, `org_unit_members`, `role_assignments`, `external_identities`, `sync_runs`, `system_flags`, `audit_events`, `central_templates`, `central_template_versions`, `central_template_targets`. PostgreSQL 15 or newer is required (`NULLS NOT DISTINCT`).

Data flow: login (better-auth) -> session cookie with **no roles in it** -> every request calls `resolvePrincipal(userId)` (`src/lib/authz/principal.ts`), which reads `directory_users` and `role_assignments` live -> `Principal` -> guards. There is no cache, so a revoked role or a disabled user takes effect on the next request.

## Roles and capabilities

Roles are orthogonal capability sets, not a ladder. The only definition is `ROLE_DEFINITIONS` in `src/lib/authz/capabilities.ts` (pinned by `capabilities.test.ts`). The role keys are the identifiers of the system roles in Rollekatalog.

| Role key | Capabilities | NULL scope may mean "global" |
|---|---|---|
| `tt-bruger` | `template.use` | no |
| `tt-skabelonansvarlig` | `template.use`, `template.manage`, `directory.read` | no |
| `tt-logleser` | `template.use`, `audit.read`, `audit.export`, `directory.read` | yes |
| `tt-administrator` | all seven (adds `access.manage`, `sync.run`) | yes |

Scoped capabilities (limited to org units): `template.manage`, `audit.read`, `directory.read`. Global-only capabilities (`GLOBAL_ONLY_CAPABILITIES`): `audit.export`, `access.manage`, `sync.run` take effect only from a GLOBAL assignment, so `tt-administrator` cannot be granted for one unit (`scope_forbidden`) and a unit-scoped `tt-logleser` can read its unit's rows but not export. `role_assignments.role_key` is free text on purpose: a row with an unknown key grants nothing.

## Scope semantics and fail-closed rules

`Principal.scopes[capability]` is `{ global, roots: [{ orgUnitUuid, includeDescendants }] }`.

- An assignment with an org unit adds a root; `include_descendants` (default true) extends it to the subtree. A unit granted twice keeps the wider grant.
- A NULL scope sets `global` only for roles with `globalScopeAllowed`. A NULL-scope `tt-skabelonansvarlig` covers no unit. "No scope" is never read as "all units".
- An assignment is active in `[start_date, stop_date)`. Unknown role keys, expired and future rows grant nothing.
- **Last-administrator guard** (`admin-sql.ts`, used by revoke and bootstrap). An administrator counts as "another administrator" only with a local, global, started, **permanent** (`stop_date IS NULL`) assignment of an enabled, login-capable person. A grant with a `stop_date` is allowed but never makes the last permanent administrator expendable, so the only administrator cannot hand over to a colleague whose role lapses and then lock the system out.
- A disabled directory user has no roles and no capabilities, not even the baseline.
- Baseline: unless `REQUIRE_ROLE_TO_LOGIN=true`, every non-disabled principal implicitly holds `tt-bruger`, also users with no directory row.
- Org-tree reads (`scope.ts`) are cycle-safe: recursive CTEs use `UNION` and a depth cap `MAX_ORG_DEPTH` (64); deeper counts as not covered. Malformed uuids are "not in scope", not a 500.
- Resources outside the caller's scope answer 404, not 403 (`notFoundOrForbidden`).
- An invalid non-empty `ACCESS_SOURCE` throws `ConfigError`; routes answer 503 "Adgangskontrol er midlertidigt utilgængelig" and the layout shows the retry screen. A typo never means `local`.

## The two modes

Both modes use the same tables, told apart by `role_assignments.source` / `directory_users.source`. Permission code reads only the tables.

| | `local` (default) | `rollekatalog` |
|---|---|---|
| Who edits roles and org units | administrators in the app (`access.manage`) | Rollekatalog; the sync writes `source='rollekatalog'` rows |
| Local admin writes | work | answer 409: `assertLocalMode` in `access-admin.ts` throws `ReadOnlyModeError` (400 body validation can come first) |
| Rows that count | only `source='local'` | only `source='rollekatalog'` and not older than `ROLE_STALE_MAX_SECONDS` |
| Login -> directory user | explicit link `directory_users.app_user_id`, set by an admin | automatic, `matchDirectoryUser`, from SSO claims |
| First administrator | `BOOTSTRAP_ADMIN_EMAILS` (one-shot) | not applicable |

**In the admin UI.** Roles are read-only whenever Rollekatalog is the source (one source of truth, no hybrid editing): Administration → Brugere og roller then shows the card "Roller tildeles i Rollekatalog" instead of the grant and revoke controls. It names the Rollekatalog IT system to look under (`itSystem` in `GET /api/admin/access/sync`, from `ROLLEKATALOG_ITSYSTEM_ID`; an identifier, never a key), lists the four roles with their identifier and meaning (`labels.da.ts`), and says that changes appear after the next synchronisation. The "Sidst synkroniseret" line and, for `sync.run`, the "Synkroniser nu" panel sit on the same page. In local mode the page offers "Tildel rolle" and "Fjern" as before. On Organisation, each unit row has a chevron that expands the unit's members (name and e-mail, loaded on first expand, needs `access.manage`); the "Handlinger" column (edit, delete, edit members) exists only in local mode.

The symmetry is enforced in one pure function (`dropStaleAssignments`): rows of the other mode, rows of an unknown source and stale Rollekatalog rows are ignored, because the other side could not edit or revoke them.

## Enforcement points

- `withAuthz(label, capability, handler)` in `src/lib/authz/guard.ts`: 401 no session, 403 disabled or missing capability (+ `authz.denied`). `requireLocalSource` is an option of the wrapper; no route uses it, the service layer enforces read-only mode itself.
- `requireAppAccess()` in `src/lib/authz/app-access.ts` for the older `/api` routes (minutes, transcribe, export, meetings, bot, skabeloner): 401, 503 when the principal cannot be resolved (or `ConfigError`), 403 for a disabled user or, with `REQUIRE_ROLE_TO_LOGIN=true`, a user without a role (+ `authz.denied`). Routes that authenticate by shared secret (bot callbacks, cron, feed) are separate.
- `(app)/layout.tsx`: same refusal for pages (`NoAccess`), and `AccessUnavailable` when the lookup fails (fail closed). `/admin` pages are gated per section (`admin-sections.ts`, `page-gate.ts`; 404 without capability). `/admin` itself has no page: it redirects to the first section the user may open (the same order as the tab bar), so every role combination lands on a page it can use.
- Denials are recorded with `recordAuthzDenied` (`src/lib/audit/authz-denied.ts`); admin writes call `recordEvent(event, { tx })` on the same transaction as the change.

## Identity linking and bootstrap

- **Local mode** never links by email: an email/password sign-up can claim any address. The link is `directory_users.app_user_id`, set by an admin.
- **Rollekatalog mode** (`directory-match.ts`, `DIRECTORY_MATCH`): `userid-claim` (default, claim `DIRECTORY_USERID_CLAIM` vs `ext_user_id`), `extuuid-claim`, or `email` (needs `email_verified === true`). Never for `credential` accounts; Microsoft logins only with a single-tenant `MICROSOFT_TENANT_ID` and a matching `tid` (all modes and transforms); zero or several candidates never link; a row linked to another user is a `conflict`. A person re-created in Rollekatalog (new uuid, same userId) is re-linked from the DISABLED old row at the next login. Claims come from the whitelisted snapshot in `external_identities` (decoded from the stored `id_token`), never from the browser. Details in `rollekatalog.md`.
- **Bootstrap administrator** (`bootstrap.ts`, local mode only): grants a global `tt-administrator` to an SSO identity that proves an address in `BOOTSTRAP_ADMIN_EMAILS` (Microsoft: single-tenant `MICROSOFT_TENANT_ID` and matching `tid`; others: `email_verified === true`), while no usable permanent administrator exists (see the last-administrator guard above). It is one-shot: the flag `bootstrap_admin_done` in `public.system_flags` is written in the same transaction and under the same advisory lock as the grant. Recovery after a lock-out: `DELETE FROM system_flags WHERE key = 'bootstrap_admin_done';`, or insert a `role_assignments` row by SQL. It runs from `databaseHooks.session.create.after` (`login-hook.ts`), which never throws.

## Configuration

Read at call time (restart, no rebuild; never `NEXT_PUBLIC_*`): `src/lib/authz/config.ts`, `src/lib/audit/config.ts`, `src/lib/rollekatalog/config.ts`. Every variable with its default is in `.env.example`; `DEPLOY.md` has the rollout steps.

## Known gaps

- **Not run against a live Rollekatalog.** Everything was built from the source of release 2026r4 and tested against synthetic fixtures and an in-process mock. HTTP statuses for wrong keys and the size of `organisation/v3` are modelled, not observed (`rollekatalog.md`).
- **Postgres lane.** `*.pg.test.ts` run in CI against `postgres:16` (`.github/workflows/test.yml`); CI covers PostgreSQL 16 only. The UI is tested with jsdom, not in a real browser.
- **Per-instance, in-memory throttles.** The failed-login throttle, the client-event rate limit and per-type throttle are per process: with several app instances the limits multiply, and a restart resets them.
- **Stale membership.** Org-unit membership (and so central template recipients) is only as fresh as the last successful sync; `ROLE_STALE_MAX_SECONDS` applies to role assignments only. The sync never deletes org units.
- **Share CODE is not audited.** The stateless template share code is built and read in the browser; only the link flow produces `template.share` / `template.import`.
- **Client-reported events are self-reported** (`audit.md`), and a template changelog entry is permanent: neither the audit log nor the changelog has a per-person erasure path in the app.
