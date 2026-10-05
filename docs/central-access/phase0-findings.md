# Phase 0 findings

Audience: engineers implementing Phases 1-3. Everything marked "unverified" was not checked at runtime.

## Summary

**What was done**
- Fixed a `search_path` leak in `queryUserSchema()` (pooled connections kept the previous user's schema).
- Verified the better-auth API surface against the installed 1.6.11 (read from `dist/` source, no runtime execution).
- Investigated the Drizzle migration folder.
- Answered the Rollekatalog unknowns from the OS2rollekatalog source (release 2026r4, commit c7e7f88) and wrote synthetic fixtures.
- Added `SKABELON_SHARE_CODE` / `SKABELON_SHARE_LINK` to the compose/env files.

**What changed in the repo**
- `src/lib/db/user-schema.ts` (modified) and `src/lib/db/user-schema.test.ts` (new, 9 tests).
- `docker-compose.yml` and `.env.deploy.example` (modified).
- `src/lib/rollekatalog/__fixtures__/` (new: 6 JSON files + README.md).
- `docs/central-access/phase0-findings.md` (this file).

**Needs a human decision**
- Which central tables the first migration (0001) covers (section 3).
- Whether to delete `drizzle/0000_wet_impossible_man.sql` (section 3).
- Whether any deployed DB is in a non-standard migration state (section 3; not inspectable here).
- Which `ROLLEKATALOG_SCOPE_STRATEGY` values the plan offers (section 4; the plan's list was not available to the author of the recommendation).
- Raise the better-auth floor in `package.json` (`^1.2.7`, verified only on 1.6.11).
- ESLint has no config; lint cannot gate this worktree (section 6).

## 1. search_path leak fix

**Defect (verified by reading code).** `queryUserSchema()` ran a session-level `SET search_path TO "<schema>", public` and then `client.release()` with no reset. The pooled connection kept the previous user's search_path.

**Fix (`src/lib/db/user-schema.ts`, `finally` block of `queryUserSchema`).**
- Runs `RESET search_path` in its own try/catch.
- If the reset fails, the client is released with `client.release(true)` (the pool destroys it).
- Because it is in `finally`, it also runs when the user query throws; the reset error is swallowed so the caller sees the original result or error.
- Public signatures unchanged. One short WHY comment added.
- `ensureUserSchema()` needs no change: it never sets `search_path` and all its statements are schema-qualified.

**Tests (`src/lib/db/user-schema.test.ts`, 9, all pass; `pool` mocked with a fake client recording query/release order).**
- `getUserSchemaName > prefixes with u_ and replaces dashes`
- `queryUserSchema > sets a quoted search_path and runs the query with its params`
- `queryUserSchema > resets search_path after a successful query and before release`
- `queryUserSchema > resets and releases even when the query throws, and the original error propagates`
- `queryUserSchema > destroys the connection when RESET fails, without masking the result`
- `queryUserSchema > destroys the connection when RESET fails, without masking the original query error`
- `queryUserSchema > runs ensureUserSchema only once per user per process`
- `queryUserSchema > ensureUserSchema does not set search_path on its pooled client`
- `queryUserSchemaOne > returns the first row, or null when there are none`

**Review verdict: sound.** No defect found, no code changed in review.
- `release(discard)` matches pg-pool semantics (read in `node_modules/pg-pool/index.js`); release is called exactly once on every path.
- Mutation checks: removing the RESET line fails 5/9 tests; replacing `release(discard)` with `release()` fails 4/9; restored file passes 9/9.

**Other exposure.** `search_path` is set only in `user-schema.ts`. The shared `pool` also serves the better-auth Drizzle adapter and `db.insert(sharedSkabeloner)` calls (unqualified queries). No per-user/public table name collision was found today, and the reset removes the exposure.

**Not verified / residual**
- Not tested against a live Postgres.
- If `RESET` hangs on a half-dead socket, `finally` waits on it; no timeout added (not verified whether pg timeouts cover it).
- Not audited: whether any caller passes `BEGIN`/multi-statement SQL to `queryUserSchema`. If a query fails inside an open transaction, RESET fails and the connection is destroyed (acceptable).
- Out of scope, unchanged: `ensureUserSchema` catch runs `ROLLBACK` even if failure was before `BEGIN` (harmless warning; a failing ROLLBACK could mask the original error).
- Other `pool` hits (`speaker-labels.ts`, `RecordingScreen.tsx`, `TranscriptReview.tsx`) were not opened; probably an unrelated identifier.

## 2. better-auth 1.6.x API verification

Verified against better-auth 1.6.11 (`package-lock.json` pins 1.6.11; `package.json` declares `^1.2.7`; `@better-auth/core` is `^1.6.11`). Read from `dist/*.mjs/.d.mts`; no runtime execution.

| # | Topic | Exists | Exact API | Consequence |
|---|---|---|---|---|
| 1 | genericOAuth claims | yes | `mapProfileToUser(profile): Partial<User>`; `getUserInfo(tokens)`; `overrideUserInfo` (default false). Default getUserInfo decodes the id token (no signature verification) and spreads ALL claims into `mapProfileToUser` if it has `sub` and `email`; else falls back to userinfo endpoint. Return type has no index signature (extra keys are a TS error). | Raw claims are visible only inside `mapProfileToUser`, in `databaseHooks.user.create.before` (first creation only), or later by decoding `accounts.id_token` (stored plaintext, refreshed each sign-in). Extra claims persist only with `user.additionalFields` plus a drizzle column. Do not override `getUserInfo` (loses the claims). Keep `overrideUserInfo` off (can change `user.email`). |
| 2 | Microsoft social provider | yes | `socialProviders.microsoft.mapProfileToUser(profile)` (index signature OK); `overrideUserInfoOnSignIn` (default false); `tenantId` default `common`. Profile types include `oid`, `tid`, `upn`, `preferred_username`, `roles`, `groups`, `hasgroups`. Callback keeps only `.user`; the raw `data` is discarded. | Use `mapProfileToUser` for oid/tid/upn/groups. Spread in `auth/index.ts` (`{ ...microsoft, mapProfileToUser }`); keep `providers.ts` free of DB imports. With `common` tenant, check `tid` inside `mapProfileToUser` (throwing aborts login). Entra often omits `email` -> `email_not_found`. Directory match key should be oid(+tid) or upn, not email. Id token is decoded, not verified, on the code-flow path. |
| 3 | databaseHooks | yes | `databaseHooks.{user,session,account,verification}.{create,update,delete}.{before,after}`; context is `GenericEndpointContext \| null` (`.path` is the route template without basePath, `.params`, `.headers`). `create.before` returning false aborts. After-hooks run after the transaction commits. `session.create` fills `ipAddress`/`userAgent` before hooks. | Log `auth.login` in `session.create.after` and branch on `ctx.path` (`/sign-in/email`, `/sign-up/email`, `/callback/:id`, `/oauth2/callback/:providerId`). Do not log `session.token`. Logout via `session.delete.after` only when `ctx?.path === '/sign-out'` (the hook also fires for expiry cleanup, revoke endpoints, password-reset revocation; not for ON DELETE CASCADE). `session.create.before` returning false blocks login (password 401, OAuth redirect `unable_to_create_session`). Default IP source is `x-forwarded-for` only; set `advanced.ipAddress.ipAddressHeaders` to match the proxy (else `''` in production). |
| 4 | Request hooks / login_failed | yes | `import { createAuthMiddleware, isAPIError, APIError } from 'better-auth/api'`; `betterAuth({ hooks: { before, after } })`. Matcher is always true: filter on `ctx.path`. In `after`, `ctx.context.returned` is the result (APIError instance on throw); `ctx.context.responseHeaders` holds `location`; `ctx.context.newSession` is set when a cookie session was issued. | Password failure: `/sign-in/email` with `returned.statusCode >= 400` (`body.code` e.g. `INVALID_EMAIL_OR_PASSWORD`). OAuth callbacks signal success AND failure with a 302 APIError, so detect failure via the `error` query param in `location` (or `newSession == null`). Failures have no userId (attempted email is untrusted/PII; hash or truncate; plus ip). Wrap logging in try/catch so it cannot alter the response. Rate-limit (429) responses probably bypass the hook (unverified at runtime). |
| 5 | additionalFields / customSession / session.user | yes | `user.additionalFields` (`DBFieldAttribute`, supports `returned`, `input`); `customSession` from `better-auth/plugins`. Default `session.user` = `{id, name, email, emailVerified, image, createdAt, updatedAt}`. | Roles are NOT in the cookie or `session.user` today. Do not add a `role` additionalField or the admin plugin; resolve role live from our own table by `session.user.id`. If a field is ever added, declare `{ returned: false, input: false }`. `customSession` not needed. Note `/get-session` already returns `session.token`, ipAddress, userAgent. |
| 6 | admin / organization plugins | yes | `better-auth/plugins/admin` (adds `role`, `banned`, ...; `session.impersonatedBy`); `better-auth/plugins/organization` (adds organization/member/invitation tables). | Deliberately not used: they add role/ban columns and public tables our drizzle schema does not manage. Role catalogue lives in our own tables. |
| 7 | `session.cookieCache` | yes | `session.cookieCache.enabled` default false; when enabled maxAge 300 s, strategy `compact`. Session defaults: expiresIn 7 d, updateAge 1 d. | `src/lib/auth/index.ts` sets no `session`, so the cache is off and every `getSession` reads the DB. Leave it off. |
| 8 | Account linking | yes | `account.accountLinking.{enabled, disableImplicitLinking, requireLocalEmailVerified (default true, deprecated), trustedProviders, allowDifferentEmails}`. | With current config, an SSO login for an existing email/password user is REFUSED (`error=account_not_linked`): password sign-ups stay `emailVerified=false`, so the local-verified check can never pass. Not a silent merge or takeover. Plan must not assume automatic merge. Do not set `trustedProviders` / `requireLocalEmailVerified=false`. The existing comment in `auth/index.ts` (~59-65) slightly understates this: `trustedProviders` drops only the incoming-IdP check, the local check remains. Reverse order (SSO first, then password sign-up) was not analysed. |
| 9 | `emailVerified` on SSO login | yes | Generic: id-token `email_verified` (else false). Microsoft: `email_verified`, or membership in `verified_primary_email`/`verified_secondary_email`. `mapProfileToUser` may override. Schema default false. | Microsoft logins normally end up `emailVerified=false` (Entra does not emit these claims by default). Password sign-ups are always false. A bootstrap rule "allow-listed email AND `emailVerified`" will silently not match them. Define bootstrap per provider (generic OIDC with `email_verified === true`; Microsoft single-tenant with matched `tid`) plus an allow-listed email, evaluated server-side against the DB row. Whether Keycloak/Authentik emit `email_verified` is IdP-side and was not verified. |

### Plan adjustments

1. Replace "hooks.after for auth.login" with `databaseHooks.session.create.after` (see row 3).
2. `auth.logout`: `databaseHooks.session.delete.after`, emit only when `ctx?.path === '/sign-out'`. Reword the plan: logout is hooked via session.delete, not `hooks.after`.
3. `auth.login_failed`: request-level `hooks.after = createAuthMiddleware(...)`; filter on `ctx.path`; for OAuth callbacks inspect the `location` `error` param. Failed attempts have no userId.
4. Do not promise raw Entra/OIDC claims in the session or DB. Derive directory matches at login time and store our own result in our tables.
5. Do not override `getUserInfo` just to read claims.
6. Typing differs: generic OAuth `mapProfileToUser` returns `Partial<User>` (no extra keys); Microsoft's allows extra keys.
7. Microsoft default tenant is `common`; for directory matching require single-tenant `MICROSOFT_TENANT_ID` or check `profile.tid`. If email is mapped from `preferred_username`/`upn`, state it is not a verified address.
8. Keep roles out of the cookie (no role field, no admin/organization plugin, cookieCache off).
9. Account linking wording per row 8; add UI handling for `?error=account_not_linked` or a signed-in `linkSocial`/`oauth2.link` flow.
10. Bootstrap-admin rule per row 9.
11. Blocking deactivated users: `databaseHooks.session.create.before` returning false (no admin "ban" plugin needed).
12. IP capture: configure `advanced.ipAddress.ipAddressHeaders` and make sure the proxy overwrites client-supplied values.
13. Raise the declared floor to `^1.6.11` when implementing.

## 3. Drizzle migration folder

**Facts**
- `drizzle/` contains `0000_past_shooting_star.sql`, `0000_wet_impossible_man.sql`, `meta/0000_snapshot.json`, `meta/_journal.json`; all tracked by git.
- The two `.sql` files are byte-identical (2615 bytes, same sha1). The journal has one entry (idx 0, tag `0000_past_shooting_star`, when 1781616696550).
- History: `past_shooting_star` came in with 42b0507 and f3c4b24 (#80). `wet_impossible_man` came in with 5eaa346, whose journal listed it with when=1781689102251; f3c4b24 restored the journal to `past_shooting_star` but did not delete the second file. A deployment that ran 5eaa346 may have recorded `created_at=1781689102251` in `drizzle.__drizzle_migrations`.
- `wet_impossible_man` is referenced nowhere. `past_shooting_star` appears only in `_journal.json:9`. `scripts/migrate.mjs` is itself unreferenced (dead code).
- Migrations are applied by the compose `migrate` service (Dockerfile `migrate` stage, `npx drizzle-kit migrate`) and `npm run db:migrate`. Both are journal-driven, so an `.sql` not in the journal is never executed (migrator behaviour is from general drizzle knowledge; its source was not read).
- `schema.ts` matches the snapshot: a probe in a temp copy (`drizzle-kit generate`) printed "No schema changes, nothing to migrate"; the real `drizzle/` was untouched. `generate` needs only a non-empty `DATABASE_URL` placeholder.
- `shared_skabeloner` (with FK to `users(id)` ON DELETE cascade) is already in 0000.
- Runtime DDL (`ensureSharedSkabelonerTable` in `src/lib/skabeloner/shared-table.ts`) differs from the schema: no FK (its comment says so deliberately) and `created_at` is `TIMESTAMPTZ` vs `timestamp` in Drizzle/0000. It never adds the FK.
- Consequence: on a normal deployment `migrate` runs first, so the table has the FK and the runtime DDL is a no-op. Conflict arises only where the runtime path created the table before 0000 ran (applying 0000 then fails with `relation "shared_skabeloner" already exists`). A DB that recorded `created_at=1781689102251` skips `past_shooting_star` (older `when`) and accepts any newly generated migration.
- Real databases could not be inspected; their states are unknown.

**Recommendation**
1. Stray file: dead and harmless. Delete `drizzle/0000_wet_impossible_man.sql` in a separate cleanup commit, after confirming (see questions). Do not touch the journal or snapshot and do not rename either file.
2. New migration: safe to run `npx drizzle-kit generate --name=<descriptive>`. Expect one new `0001_<name>.sql`, an updated journal entry and `0001_snapshot.json`. Review the SQL by hand, commit the three files together, and check `git status drizzle/`.
3. `shared_skabeloner` on DBs where the runtime DDL ran first: do not edit 0000. Either a custom idempotent migration (`drizzle-kit generate --custom`: `CREATE TABLE IF NOT EXISTS` plus a guarded `ADD CONSTRAINT` via a `pg_constraint` DO block; note the FK add fails if orphan `owner_user_id` rows exist) or, for dev DBs only, drop the table and re-migrate. Aligning timestamp vs timestamptz and removing `ensureSharedSkabelonerTable` are separate, optional decisions (changing the Drizzle column to `withTimezone` would itself generate a migration).
4. `scripts/migrate.mjs`: keep or remove is a separate decision.

**Open questions**
- Which central (public-schema) tables does Phase 0/1 need? Should 0001 cover only the new role-catalogue / prompt-control / logging tables and leave `shared_skabeloner` unchanged?
- May the byte-identical `0000_wet_impossible_man.sql` be deleted in a separate cleanup commit?
- Do any deployed DBs (e.g. production) have `__drizzle_migrations` rows from the `wet_impossible_man` era, or a runtime-created `shared_skabeloner` without FK?
- Reconcile `shared_skabeloner` schema vs runtime DDL, and eventually drop `ensureSharedSkabelonerTable`?
- Keep or remove `scripts/migrate.mjs`?
- The `.env.deploy.example` / `docker-compose.yml` changes are the compose/env work in section 5; they were not inspected for migrate-related changes.

## 4. Rollekatalog unknowns

Method: source-derived from OS2rollekatalog release 2026r4 (c7e7f88; `rc.version` in source is "2026 r4"), not a live instance. No Docker daemon was reachable, and a live instance would need MariaDB, SAML login and a UI-created API client. Paths are relative to `ui/src/main/java/dk/digitalidentity/rc` (`rc/`). Confidence is "confirmed in source" unless noted; 403/401 behaviour and the 400 for a missing param were not verified live.

### Q1. OrgUnit constraint JSON shape and identification
- **Answer.** `roleAssignmentsWithContraints` returns `[{extUuid, userId, assignments:[{roleIdentifier, roleName, roleConstraintValues:[{constraintType, constraintValues:string[]}]}]}]`. `constraintType` is the ConstraintType `entityId` (a URL), not name or uuid. `constraintValues` is the resolved value split on `,`; for OU constraints these are OU uuids.
  - OU entityIds: KOMBIT `http://sts.kombit.dk/constraints/orgenhed/1`; internal `http://digital-identity.dk/constraints/orgunit/1`. No literal "OrganisationEnhed" string exists in source. KLE is `http://sts.kombit.dk/constraints/KLE/1`.
  - The internal OU type is seeded by Flyway V1_29 (uuid `49be31cf-a1c5-4be1-bb96-73e693cce3ef`, name "Enhed", ui_type REGEX). KOMBIT types are created by the KOMBIT import, so their uuid/name/ui_type are unverified (dev seed uses name "Organisation", REGEX).
  - Inherited/level/manager/function variants resolve to uuid lists; `SELECTED_INHERITED` resolves `+uuid,-uuid` to plain uuids; `VALUE` is the raw stored string; `POSTPONED` is joined with `,`.
  - A constraint whose resolved value is empty is DROPPED (log.warn "broken constraint"), so such a role looks unconstrained.
  - `/api/v2/user/{id}/assignments` returns `postponedConstraints:[{value, constraintTypeId, constraintTypeEntityId, systemRoleId}]`.
  - For custom IT-systems (v2 POST allows AD, SAML, MANUAL) `roleIdentifier`/`roleName` are the SYSTEM role's; for KOMBIT systems it is the built user-role identifier. The same `roleIdentifier` can repeat per user with different constraints.
- **Evidence.** `rc/controller/api/ReadOnlyApi.java:125-137`; `rc/controller/api/dto/ConstraintValue.java:9-10`; `rc/service/UserService.java:946-1140` (switch 1021-1115, empty drop 1117-1123, `.type(entityId)` 1126; `shouldExpandToBsr` 956, 1408); `rc/config/Constants.java:65-71`; `db/migration/mysql/V1_29__extend_assigner_role.sql:1-2`; `rc/controller/api/model/PostponedConstraintAM.java`; `rc/controller/api/mapper/RoleMapper.java:96-103`; `rc/controller/api/v2/ItSystemApiV2.java:158-210`; `rc/service/kombit/KOMBITService.java:~1147`; `rc/bootstrap/dev/DevDataDefinitions.java:71-75`; `rc/util/OrganisationConstraintUtil.java:26-38`.
- **Impact.** Key on the entityId URL and treat both as an OU scope; values are always an array of uuids. Look types up via `GET /api/v2/constraint` and match on entityId, never on name/uuid. Missing OU constraint = unconstrained. Union duplicate `roleIdentifier` entries per user (an unconstrained entry wins). A custom IT-system role wanting an OU constraint must reference an existing ConstraintType.

### Q2. Effective vs direct assignments
- **Answer.** Effective, except one path. All read the materialised `current_assignment` table (`CurrentAssignmentCalculator`): direct user-role and role-group assignments, OU assignments walked up all ancestors (unless `doNotInherit`), title-conditioned OU assignments, function/manager/substitute assignments, negative exceptions. Excluded: deleted users and ended assignments (stopDate <= today).
  - `roleAssignmentsWithContraints`: no flag; all users with any current assignment.
  - `rolesAsList`: no flag; effective. Caveats: system roles are filtered to the max `weight` per IT-system (default 1, normally a no-op), and the native systemRoles SQL has no date filter while userRoles does.
  - `/api/read/itsystem/{system}?indirectRoles=false` (default) returns only DIRECT rows; `indirectRoles=true` returns all. Grouped per user role, not per user.
  - Results are filtered to one domain (default primary "Administrativt"). Disabled users are NOT filtered anywhere.
- **Evidence.** `rc/service/assignment/CurrentAssignmentCalculator.java:38-100`; `rc/service/assignment/rules/OrgUnitAssignmentRule.java`, `TitleAssignmentRule.java`; `rc/service/assignment/AssignmentService.java:132-136,152-154,161-172`; `rc/dao/assignment/CurrentAssignmentDao.java:81-87,107-114,137-145`; `rc/controller/api/ReadOnlyApi.java:113,125,179-181`; `rc/controller/api/UserApi.java:146,157`; `rc/service/SystemRoleService.java:217-233`; `rc/dao/SystemRoleDao.java:34-42`.
- **Impact.** `roleAssignmentsWithContraints` is the single "who has which role with resolved OU scope" source; no client-side re-expansion. Join `disabled` from organisation/v3. Do not use `/api/read/itsystem/{system}` without `indirectRoles=true`.

### Q3. `GET /api/v2/manager` gating and access
- **Answer.** Not gated by `rc.substituteManagerAPI.enabled` (default false) or any other property; that flag applies only to the legacy v1 `/api/manager`. The class is `@RequireApiOrganisationRole`. A READ_ACCESS key is refused (ApiSecurityFilter grants it only `ROLE_API_READ_ACCESS`). Only ORGANISATION and ADMINISTRATOR clients carry `ROLE_API_ORGANISATION`. No READ_ACCESS endpoint returns manager info (grepped the READ_ACCESS controllers and DTOs). v2 lists only users managing at least one active OU, plus substitutes (with `orgUnitUuid`); the manager-to-OU mapping comes from organisation/v3 `orgUnits[].manager`. Empty result is 200 `[]`.
- **Evidence.** `rc/controller/api/v2/ManagerSubstituteApiV2.java:33,66-97`; `rc/controller/api/ManagerSubstituteApi.java:54-58,75-79,126-130`; `rc/config/model/SubstituteManagerAPI.java:12`; `rc/security/ApiSecurityFilter.java:50-82`; `rc/service/UserService.java:1578-1583`; `rc/service/OrgUnitService.java:187-189`.
- **Impact.** Manager sync needs an ORGANISATION-type key; READ_ACCESS alone cannot get manager info. Avoid ADMINISTRATOR (also grants AUDITLOG, CICS_ADMIN, ROLE_MANAGEMENT).

### Q4. Runtime OpenAPI path
- **Answer.** No override. springdoc 3.0.1 defaults apply: JSON at `/v3/api-docs`, UI at `/swagger-ui/index.html`. Only `springdoc.paths-to-match` is set (`/api/v2/**`, `/api/function/**`, `/api/organisation/v3/**`, `/api/title/**`, `/api/read/**`, `/api/user/**`, `/api/itsystem/**`, `/api/ou/**`, `/api/constraint/**`, `/api/manager/**`, `/api/overwriteUserRoleAssignments/**`), which covers our planned endpoints. The ApiKey filter covers only `/api/*`, `/manage/info`, `/manage/prometheus`; `/v3/**` is not in `di.saml.pages.nonsecured`, so it is on the SAML-protected side and an ApiKey client cannot read it. Caveat: how the external SAML library treats unlisted paths is not in this repo, so this is inferred from config, not observed.
- **Evidence.** `resources/default.properties:91,94-95`; `ui/pom.xml:270-272`; `rc/security/ApiSecurityFilterConfiguration.java:20`; `rc/security/SwaggerSecurityFilterConfiguration.java:15`; `rc/filter/SwaggerSecurityFilter.java`.
- **Impact.** Do not plan on fetching the spec at runtime with an ApiKey. Use the DTO sources of the pinned release (as the fixtures do) or have an operator export it via SAML login. Pin the supported Rollekatalog version; shape drift is a maintenance risk.

### Q5. Access role per endpoint
- **Answer.** Class-level annotations; no method-level overrides found on the controllers checked.
  1. `GET /api/user/{userid}/rolesAsList`: READ_ACCESS.
  2. `GET /api/organisation/v3`: ORGANISATION (handler is `synchronized`).
  3. `GET /api/v2/manager`: ORGANISATION.
  4. `GET /api/read/itsystem/roleAssignmentsWithContraints/{system}`: READ_ACCESS.
  5. `POST /api/v2/itsystem`: ITSYSTEM.
  6. `POST /api/v2/itsystem/{id}/systemroles`: ITSYSTEM.
  - Extras: `GET /api/v2/constraint` is READ_ACCESS; `GET /api/v2/user/{id}/assignments` is ROLE_MANAGEMENT.
  - Client type to authorities: READ_ACCESS -> {READ_ACCESS}; ORGANISATION -> {ORGANISATION} (does not imply READ_ACCESS); ITSYSTEM -> {READ_ACCESS, ITSYSTEM}; ROLE_MANAGEMENT -> {ROLE_MANAGEMENT, READ_ACCESS, ITSYSTEM}; ADMINISTRATOR -> all six.
  - Auth is the custom header `ApiKey: <key>` (not `Authorization`). Missing/invalid key gives 401, missing role 403 (Spring default; not verified live).
- **Evidence.** `rc/controller/api/UserApi.java:45`; `OrganisationApi.java:42,196-203`; `v2/ManagerSubstituteApiV2.java:33`; `ReadOnlyApi.java:65`; `v2/ItSystemApiV2.java:59,158,259`; `v2/ConstraintApiV2.java:22`; `v2/UserApiV2.java:36,46`; `rc/security/Require*Role.java`; `rc/security/ApiSecurityFilter.java:40-82`.
- **Impact.** Two API clients cover the plan: ORGANISATION (organisation/v3 + manager) and ITSYSTEM (rolesAsList, roleAssignmentsWithContraints, constraint list, itsystem + systemroles POST). Document both keys in the settings UI. Do not request ROLE_MANAGEMENT (can assign roles) or ADMINISTRATOR.

### Q6. `rolesAsList` edge cases
- **Answer.** Unknown or deleted user: 404 with an EMPTY body. Lookup by `userId` in the requested domain (default primary), falling back to `extUuid` when exactly one matches. Unknown domain or unknown system: 404, empty body. System lookup tries identifier, then uuid; the numeric-id path is dead code (never resolves). Missing `system` param: Spring's 400 (body not inspected). Disabled (not deleted) user: 200 with the normal body and `disabled: true`; roles are NOT blanked. User with no roles: 200 with empty arrays and `nameID` set. IT-system with `accessBlocked=true`: filtered out (200, empty arrays). Shape: `{nameID, userRoles[], systemRoles[], dataRoles[], functionRoles[], roleMap{identifier: "Name (System)"}, disabled}`. EVERY successful call writes an audit-log entry (`EventType.LOGIN_EXTERNAL`). `nameID` is `C=DK,O=<cvr>,CN=<name>,Serial=<extUuid>`.
- **Evidence.** `rc/controller/api/UserApi.java:112-192` (user 121-125, disabled 127, systems 129-143, accessBlocked 142, audit 184, 404 186-189), `:293-326`; `rc/service/UserService.java:182-193,164-166,723-734,1625-1691`; `rc/service/assignment/CurrentAssignmentCalculator.java:42`; `rc/controller/api/dto/UserResponseWithRolesDTO.java:9-18`.
- **Impact.** Treat 404 as "no such user or system" without parsing a body. Check `disabled` and deny disabled users rather than trusting a non-empty role list. Do not use `rolesAsList` for bulk polling (one audit row per call); use `roleAssignmentsWithContraints` per IT-system. Identify users by `userId` (or `extUuid`), not uuid.

### Q7. OrgUnit `manager` in `/api/organisation/v3`
- **Answer.** `OrgUnitDTO.manager` is `ManagerDTO {uuid, userId}` (no name/email), set when the unit has a manager. Without one it is serialised as `"manager": null` (no `@JsonInclude` or Jackson inclusion property found); treat absent as null anyway. Export covers only OUs with `active=true` and `isActiveAndIncluded` (configured exclusion list). Users are those with `deleted=false` and at least one position; disabled users ARE included with `disabled: true`. `UserDTO` also exposes cpr, nemloginUuid, email, phone. `OrgUnitDTO` has `titleIdentifiers` (title uuids, null when none) but no title names.
- **Evidence.** `rc/controller/api/model/OrgUnitDTO.java:26,38-41`; `ManagerDTO.java`; `rc/service/OrganisationExporter.java:23-34`; `rc/service/OrgUnitService.java:281-283`; `rc/service/UserService.java:216-218`; `rc/controller/api/model/UserDTO.java:25-26,38-39`; `rc/dao/model/OrgUnit.java:89-90`.
- **Impact.** Model `manager` as optional/nullable and resolve a unit's manager by walking up to the nearest ancestor with one (the fixture has "Team Selvbetjening" with null manager under "Borgerservice"). Drop cpr and nemloginUuid at the mapper boundary. Join manager on uuid/userId against `users[]`; a manager with no position is not exported, so the join can miss.

### Scope-strategy recommendation
The plan's list of `ROLLEKATALOG_SCOPE_STRATEGY` values was not available, so this is by behaviour only.
- Default to taking scope from the server-resolved OU constraint in `roleAssignmentsWithContraints` (OU uuids): already effective, needs only the ITSYSTEM key, no manager data.
- Fail closed: a user with the Referat role but no OU constraint, or an empty list, must NOT silently get "all units" (Rollekatalog drops empty-resolving constraints, `UserService.java:1117`). Fall back to the user's own position OUs from organisation/v3, or deny, depending on what the plan offers.
- Manager-based scoping should be opt-in: needs a second ORGANISATION-type key, and the OU-to-manager mapping must come from organisation/v3.
- Always check `disabled` in every strategy.

### Fixtures
Location: `src/lib/rollekatalog/__fixtures__/` (`organisation-v3.json`, `managers-v2.json`, `roles-as-list.json`, `roles-as-list-disabled.json`, `role-assignments-with-constraints.json`, `user-assignments-v2.json`, `README.md`).

**SYNTHETIC caveat.** These were hand-written from the DTO sources of release 2026r4, not captured from a real Rollekatalog. They show shape, not real data or real KOMBIT constraint type uuids/names. UUIDs follow `xxxx0000-0000-4000-8000-00000000000N`; names are fictitious; emails use `example.dk`; the only CPR-shaped value is the placeholder `0000000000`. Re-validate against a real instance before relying on them.

## 5. Compose/env gap

- Gap: `SKABELON_SHARE_CODE` and `SKABELON_SHARE_LINK` (read at runtime by `src/lib/skabeloner/share-config.ts`) were not passed through by compose.
- Fix: `docker-compose.yml` app service now has `- SKABELON_SHARE_CODE=${SKABELON_SHARE_CODE:-true}` and `- SKABELON_SHARE_LINK=${SKABELON_SHARE_LINK:-false}` with a short comment. Defaults match `share-config.ts` (code sharing on unless `'false'`; link sharing on only when `'true'`); an empty value falls back to the default.
- `.env.deploy.example`: added a "Skabelon sharing" section with both vars.
- No `docker-compose.*.yml` overlay redefines the app environment wholesale (they override individual keys), so none were changed. `DEPLOY.md` documents only OIDC vars; no change.
- Not verified: `docker compose config` was not run (docker not installed here). `docker-compose.yml` parsed as valid YAML with ruby and the app environment contains both entries; interpolation was not independently verified.

## 6. Verification status

| Check | Baseline (before changes) | After Phase 0 |
|---|---|---|
| `npm test` (Vitest) | 1900 passed, 1 failed | 1909 passed, 1 failed (94 files); +9 = new `user-schema.test.ts`; no new failures |
| `npx tsc --noEmit` | exit 0, no output | exit 0, no output; `user-schema.test.ts` is in the tsc program |
| `npm run lint` | fails | fails (unchanged) |

- The one failing test, `src/components/recording/MeetingBotScreen.test.tsx > MeetingBotScreen > downloads the recording into IndexedDB and navigates to review when the bot ends`, also failed in the baseline run before any change. Its root cause was not investigated.
- Lint: the repo has no ESLint config and no `eslint` entry in `package.json`, so `next lint` opens an interactive "How would you like to configure ESLint?" prompt and exits 1. It lints nothing, and this is not a code violation. Lint cannot gate this worktree until someone adds an ESLint config (`next lint` is also deprecated; Next also warns about multiple lockfiles).
- `npm ci` OK; installed better-auth is 1.6.11.
- Fixture/doc scan found no real emails and no real CPR numbers; the scan of this document was a grep only (the two 10-digit numbers it flagged are Unix-epoch timestamps).

**Not verified**
- Nothing was run against a live Postgres, a live Rollekatalog, or a live IdP; better-auth behaviour is read from source only.
- Real DB migration state (section 3).
- KOMBIT constraint type uuid/name/ui_type (section 4, Q1).
- 401/403/400 response behaviours of Rollekatalog and SAML handling of `/v3/api-docs`.
- Whether all callers of `queryUserSchema` avoid `BEGIN`/multi-statement SQL.
- Entra group overage behaviour (>200 groups) and Keycloak/Authentik `email_verified` defaults (general knowledge, not in `node_modules`).
- The `docker-compose.yml` / `.env.deploy.example` changes were made by the compose task; the migrate-related content of those diffs was not inspected.
