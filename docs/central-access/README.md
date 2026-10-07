# Central access control: architecture overview

For engineers. Operators: start with `idp.md` (identity providers, SAML, roles from claims), `rollekatalog.md` (connecting a Rollekatalog), `audit.md` (the audit log) and `templates.md` (central templates); `dev-simulation.md` explains how to test everything locally without a real Rollekatalog. Where this text and the code differ, the code is right.

## Purpose

Meetings, transcripts, minutes and audio stay in the browser (IndexedDB); the per-user PostgreSQL schemas hold only personal templates (the meeting tables they still create are unused legacy). On top of that the app has a **central layer** in the shared `public` schema: who holds which role, in which part of the organisation (org units), an append-only audit log, and locked central minutes templates. Roles come from administrators in the app (`ACCESS_SOURCE=local`, the default, meant for development and demos), from the IdP's role claims at every login (`claims`, the municipal setup: rights are managed outside the app, `idp.md`), or from OS2rollekatalog (`rollekatalog`, dormant unless chosen). Independently of the mode, OS2rollekatalog can serve as the read-only **role catalogue** a superuser picks from when making a shared prompt available to roles (`rollekatalog.md` section 12); the people get the prompt through the role claims they already log in with.

Tables (Drizzle, `src/lib/db/schema.ts`, migrations `0001_central_access`, `0002_audit_events`, `0003_central_templates`, `0004_claims_roles` in `drizzle/`): `directory_users`, `org_units`, `org_unit_members`, `role_assignments`, `external_identities`, `sync_runs`, `system_flags`, `audit_events`, `central_templates`, `central_template_versions`, `central_template_targets`, `central_template_principal_targets` (the roles and groups a template is made available to; a RESTRICT foreign key to the catalogue), `external_roles` (the role/group catalogue, filled from `AUTH_CONFIG_FILE` and optionally from Rollekatalog) and `user_external_roles` (which catalogue values a person's IdP claimed at their last login; a composite foreign key keeps anything outside the catalogue out). A central template may have **no owner org unit** (organisation-wide; global managers only), which is what makes shared prompts work in claims mode where there is no org tree. PostgreSQL 15 or newer is required (`NULLS NOT DISTINCT`).

Data flow: login (better-auth) -> session cookie with **no roles in it** -> every request calls `resolvePrincipal(userId)` (`src/lib/authz/principal.ts`), which reads `directory_users` and `role_assignments` live -> `Principal` -> guards. There is no cache, so a revoked role or a disabled user takes effect on the next request.

## Roles and capabilities

Roles are orthogonal capability sets, not a ladder. The only definition is `ROLE_DEFINITIONS` in `src/lib/authz/capabilities.ts` (pinned by `capabilities.test.ts`). The role keys are the identifiers of the system roles in Rollekatalog.

| Role key | Capabilities | NULL scope may mean "global" |
|---|---|---|
| `tt-bruger` | `template.use` | no |
| `tt-skabelonansvarlig` | `template.use`, `template.manage`, `directory.read` | yes (the "superuser" who manages every shared prompt; a claim carries no org unit) |
| `tt-logleser` | `template.use`, `audit.read`, `audit.export`, `directory.read` | yes |
| `tt-administrator` | all seven (adds `access.manage`, `sync.run`) | yes |

Scoped capabilities (limited to org units): `template.manage`, `audit.read`, `directory.read`. Global-only capabilities (`GLOBAL_ONLY_CAPABILITIES`): `audit.export`, `access.manage`, `sync.run` take effect only from a GLOBAL assignment, so `tt-administrator` cannot be granted for one unit (`scope_forbidden`) and a unit-scoped `tt-logleser` can read its unit's rows but not export. `role_assignments.role_key` is free text on purpose: a row with an unknown key grants nothing.

## Scope semantics and fail-closed rules

`Principal.scopes[capability]` is `{ global, roots: [{ orgUnitUuid, includeDescendants }] }`.

- An assignment with an org unit adds a root; `include_descendants` (default true) extends it to the subtree. A unit granted twice keeps the wider grant.
- A NULL scope sets `global` only for roles with `globalScopeAllowed` (`tt-skabelonansvarlig`, `tt-logleser`, `tt-administrator`). On a role without it (`tt-bruger`) a NULL scope contributes nothing. "No scope" is never read as "all units" for a role that may not be global. `access.manage`, `sync.run` and `audit.export` need a GLOBAL assignment whatever the role.
- An assignment is active in `[start_date, stop_date)`. Unknown role keys, expired and future rows grant nothing.
- **Last-administrator guard** (`admin-sql.ts`, used by revoke and bootstrap). An administrator counts as "another administrator" only with a local, global, started, **permanent** (`stop_date IS NULL`) assignment of an enabled, login-capable person. A grant with a `stop_date` is allowed but never makes the last permanent administrator expendable, so the only administrator cannot hand over to a colleague whose role lapses and then lock the system out.
- A disabled directory user has no roles and no capabilities, not even the baseline.
- Baseline: unless `REQUIRE_ROLE_TO_LOGIN=true`, every non-disabled principal implicitly holds `tt-bruger`, also users with no directory row.
- Org-tree reads (`scope.ts`) are cycle-safe: recursive CTEs use `UNION` and a depth cap `MAX_ORG_DEPTH` (64); deeper counts as not covered. Malformed uuids are "not in scope", not a 500.
- Resources outside the caller's scope answer 404, not 403 (`notFoundOrForbidden`).
- An invalid non-empty `ACCESS_SOURCE` throws `ConfigError`; routes answer 503 "Adgangskontrol er midlertidigt utilgængelig" and the layout shows the retry screen. A typo never means `local`.

## The three modes

All modes use the same tables, told apart by `role_assignments.source` / `directory_users.source` (`local`, `rollekatalog`, `claims`). Permission code reads only the tables.

| | `local` (default) | `rollekatalog` | `claims` |
|---|---|---|---|
| Who edits roles and org units | administrators in the app (`access.manage`) | Rollekatalog; the sync writes `source='rollekatalog'` rows | nobody in the app: the IdP's role/group claims at each login write `source='claims'` rows |
| Local admin writes | work, unless the kill switch `ACCESS_LOCAL_ADMIN=false` | answer 409 | answer 409 |
| Rows that count | only `source='local'` | only `source='rollekatalog'` and not older than `ROLE_STALE_MAX_SECONDS` | only `source='claims'` and not older than `ROLE_CLAIMS_MAX_SECONDS` (default 8 h) |
| Login -> directory user | explicit link `directory_users.app_user_id`, set by an admin | automatic, `matchDirectoryUser`, from SSO claims | the person's own row (`app_user_id`), created at the first claims login with `source='claims'` |
| First administrator | `BOOTSTRAP_ADMIN_EMAILS` (one-shot) | not applicable | not applicable: break-glass is on the IdP side |
| Last-administrator guard | applies (local grants) | not applicable | not applicable (only local grants count) |

The kill switch is `localAdminEnabled()` in `config.ts`: on by default in `local` mode only, and always off in the other two, because local rows are ignored there and a local write would be inert. It gates grant/revoke, org-unit and member edits (`assertLocalMode` in `access-admin.ts` throws `ReadOnlyModeError`, 409 `read_only`, with a message that names who owns the roles) and the first-administrator bootstrap (`local_admin_disabled`). `/api/me` reports it as `readOnly`, which switches the admin pages to their read-only form.

**Claims mode in one paragraph.** The login hook (`login-hook.ts`) takes the role and group claims of THIS login (OIDC: what the profile mapper saw in id_token + userinfo, handed over through `claims-stash.ts`, else the stored id_token; SAML: the attributes delivered to the sso plugin's `provisionUser`), and `claims-roles.ts` replaces, in ONE transaction, the person's `source='claims'` rows (global NULL scope, `synced_at = now()`) and their `user_external_roles`. Values in the `roles` section's `appRoleMap` / `groupRoleMap` become roles; unknown values grant nothing; a malformed claim, an unusable `roles` section, no claims at all, or a disabled person leaves nothing (fail closed). Only catalogue values (`external_roles`) are ever stored for a person. A password sign-in clears the person's claims rows instead (a session without IdP claims inherits nothing). `resolvePrincipal` still reads live and counts a claims row only while it is younger than `ROLE_CLAIMS_MAX_SECONDS`; in claims mode the better-auth session lasts exactly that long and is never extended, so a session cannot outlive the snapshot it was granted on. Config: `idp.md`.

**In the admin UI.** Roles are read-only whenever Rollekatalog is the source (one source of truth, no hybrid editing): Administration → Brugere og roller then shows the card "Roller tildeles i Rollekatalog" instead of the grant and revoke controls. It names the Rollekatalog IT system to look under (`itSystem` in `GET /api/admin/access/sync`, from `ROLLEKATALOG_ITSYSTEM_ID`; an identifier, never a key), lists the four roles with their identifier and meaning (`labels.da.ts`), and says that changes appear after the next synchronisation. The "Sidst synkroniseret" line and, for `sync.run`, the "Synkroniser nu" panel sit on the same page. In local mode the page offers "Tildel rolle" and "Fjern" as before. On Organisation, each unit row has a chevron that expands the unit's members (name and e-mail, loaded on first expand, needs `access.manage`); the "Handlinger" column (edit, delete, edit members) exists only in local mode.

In claims mode the same page shows "Roller følger med fra login" (who assigns the roles, that a change takes effect at the person's next login, and the four roles); Organisation shows the read-only banner; the Rollekatalog sync panel and "Sidst synkroniseret" line only appear in `rollekatalog` mode.

The symmetry is enforced in one pure function (`dropStaleAssignments`): rows of the other modes, rows of an unknown source and stale rows (Rollekatalog: `ROLE_STALE_MAX_SECONDS`; claims: `ROLE_CLAIMS_MAX_SECONDS`) are ignored, because the other side could not edit or revoke them.

## Enforcement points

- `withAuthz(label, capability, handler)` in `src/lib/authz/guard.ts`: 401 no session, 403 disabled or missing capability (+ `authz.denied`). `requireLocalSource` is an option of the wrapper (409 when `localAdminEnabled()` is false); no route uses it, the service layer enforces read-only mode itself.
- `requireAppAccess()` in `src/lib/authz/app-access.ts` for the older `/api` routes (minutes, transcribe, export, meetings, bot, skabeloner): 401, 503 when the principal cannot be resolved (or `ConfigError`), 403 for a disabled user or, with `REQUIRE_ROLE_TO_LOGIN=true`, a user without a role (+ `authz.denied`). Routes that authenticate by shared secret (bot callbacks, cron, feed) are separate.
- `(app)/layout.tsx`: same refusal for pages (`NoAccess`), and `AccessUnavailable` when the lookup fails (fail closed). `/admin` pages are gated per section (`admin-sections.ts`, `page-gate.ts`; 404 without capability). `/admin` itself has no page: it redirects to the first section the user may open (the same order as the tab bar), so every role combination lands on a page it can use.
- Denials are recorded with `recordAuthzDenied` (`src/lib/audit/authz-denied.ts`). Central template writes call `recordEvent(event, { tx })` on the same transaction as the change; role, org-unit, member and user-link changes are **not audited** (out of the log's scope).

## Identity linking and bootstrap

- **Local mode** never links by email: an email/password sign-up can claim any address. The link is `directory_users.app_user_id`, set by an admin.
- **Rollekatalog mode** (`directory-match.ts`, `DIRECTORY_MATCH`): `userid-claim` (default, claim `DIRECTORY_USERID_CLAIM` vs `ext_user_id`), `extuuid-claim`, or `email` (needs `email_verified === true`). Never for `credential` accounts; Microsoft logins only with a single-tenant `MICROSOFT_TENANT_ID` and a matching `tid` (all modes and transforms); zero or several candidates never link; a row linked to another user is a `conflict`. A person re-created in Rollekatalog (new uuid, same userId) is re-linked from the DISABLED old row at the next login. Claims come from the whitelisted snapshot in `external_identities` (decoded from the stored `id_token`), never from the browser. Details in `rollekatalog.md`.
- **Claims mode** matches nothing by e-mail or claim: the claims of the login ARE the roles, written to the person's own directory row (`claims-roles.ts`). SAML logins have no id_token, so their identity snapshot (`external_identities`, same whitelist) is built from the mapped attributes (`captureIdentityFromAttributes`). Role and group values are never part of that snapshot.
- **Bootstrap administrator** (`bootstrap.ts`, local mode with the local admin on only): grants a global `tt-administrator` to an SSO identity that proves an address in `BOOTSTRAP_ADMIN_EMAILS` (Microsoft: single-tenant `MICROSOFT_TENANT_ID` and matching `tid`; others: `email_verified === true`), while no usable permanent administrator exists (see the last-administrator guard above). It is one-shot: the flag `bootstrap_admin_done` in `public.system_flags` is written in the same transaction and under the same advisory lock as the grant. Recovery after a lock-out: `DELETE FROM system_flags WHERE key = 'bootstrap_admin_done';`, or insert a `role_assignments` row by SQL. It runs from `databaseHooks.session.create.after` (`login-hook.ts`), which never throws.

## Configuration

Read at call time (restart, no rebuild; never `NEXT_PUBLIC_*`): `src/lib/authz/config.ts` (`ACCESS_SOURCE`, `ACCESS_LOCAL_ADMIN`, `ROLE_CLAIMS_MAX_SECONDS`, ...), `src/lib/audit/config.ts`, `src/lib/rollekatalog/config.ts`. The identity providers and the role mapping come from the JSON file `AUTH_CONFIG_FILE`, read once per process (`src/lib/auth/config-file.ts`, resolved in `src/lib/auth/providers.ts`; `idp.md`). Every variable with its default is in `.env.example`; `DEPLOY.md` has the rollout steps.

## Known gaps

- **Not run against a live Rollekatalog.** Everything was built from the source of release 2026r4 and tested against synthetic fixtures and an in-process mock. HTTP statuses for wrong keys and the size of `organisation/v3` are modelled, not observed (`rollekatalog.md`).
- **Postgres lane.** `*.pg.test.ts` run in CI against `postgres:16` (`.github/workflows/test.yml`); CI covers PostgreSQL 16 only. The UI is tested with jsdom, not in a real browser.
- **Per-instance, in-memory throttles.** The failed-login cap, the client-event rate limit and per-type throttle are per process: with several app instances the limits multiply, and a restart resets them.
- **Role catalogue endpoints and identifiers are unverified.** The Rollekatalog read paths for the catalogue come from the source of the development branch, not a live instance, and whether the IdP's claim values equal the catalogue identifiers is an open question for the client; shared prompts by role only reach people where they match (`rollekatalog.md` section 12, `templates.md`).
- **Stale membership.** Org-unit membership (and so central template recipients) is only as fresh as the last successful sync; `ROLE_STALE_MAX_SECONDS` applies to role assignments only. The sync never deletes org units.
- **Share CODE is not audited.** The stateless template share code is built and read in the browser; only the link flow produces `template.share` / `template.import`.
- **Client-reported events are self-reported** (`audit.md`), and a template changelog entry is permanent: neither the audit log nor the changelog has a per-person erasure path in the app.
