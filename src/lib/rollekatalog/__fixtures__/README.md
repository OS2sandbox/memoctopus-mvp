# Rollekatalog test fixtures

**These fixtures are SYNTHETIC.** They were hand-written from the Java DTO classes of
OS2rollekatalog release `2026r4` (git `c7e7f88`). They were **not** recorded from a live
instance. All names, UUIDs, emails and ids are fictitious (`example.dk`, all-zero CPR).
Shapes follow the source, but real instances may differ in ordering and in omitted/extra
fields, so treat them as contract fixtures, not recordings.

Used by `src/lib/rollekatalog/mock-server.ts` (and through it by the client, sync and login
refresh tests) and by `scripts/mock-rollekatalog.mjs`.

| File | Endpoint | Source DTO classes (`dk.digitalidentity.rc.controller.api...`) |
|---|---|---|
| `organisation-v3.json` | `GET /api/organisation/v3` | `model.OrganisationDTO`, `model.UserDTO`, `model.PositionDTO`, `model.UserOUFunctionDTO`, `model.OrgUnitDTO`, `model.ManagerDTO`, enum `OrgUnitLevel` |
| `managers-v2.json` | `GET /api/v2/manager` | records `ManagerRecord` and `ManagerSubstituteRecord` in `v2.ManagerSubstituteApiV2` |
| `roles-as-list.json` | `GET /api/user/{userid}/rolesAsList?system=...` | `dto.UserResponseWithRolesDTO` (extends `dto.UserResponseDTO`) |
| `roles-as-list-disabled.json` | same, user with `disabled: true` | same |
| `role-assignments-with-constraints.json` | `GET /api/read/itsystem/roleAssignmentsWithContraints/{system}` | `dto.RoleAssignmentsWithContraints`, `dto.RoleAssignmentWithContraints`, `dto.ConstraintValue` |
| `constraints-v2.json` | `GET /api/v2/constraint` | `model.ConstraintTypeAM` (the `49be31cf-...` uuid and `Enhed` name are the Flyway V1_29 seed; the KOMBIT/KLE entries are invented) |
| `user-assignments-v2.json` | `GET /api/v2/user/{userid}/assignments` | `model.UserUserRoleAssignmentAM`, `model.PostponedConstraintAM`, `model.UserRoleAM`, `model.SystemRoleAssignmentAM`, `model.SystemRoleAssignmentConstraintValueAM` (abbreviated; not used by the app) |

Role identifiers are our four system roles (`tt-bruger`, `tt-skabelonansvarlig`,
`tt-logleser`, `tt-administrator`) plus one foreign one (`referat_legacy`).

## Intentional properties

Org uuids are `5a1b...000N`, users `7e5e...000N`, `extUuid` `9d3c...000N`.

- `organisation-v3.json`: a 4-level tree: `Eksempel Kommune` (1) > `Borgerservice` (2) >
  `Team Selvbetjening` (3) > `Digital Support` (5), plus `Økonomi` (4) under the root. Nine users.
  - `sofie.s` is `disabled: true`.
  - `Team Selvbetjening` (3) has `manager: null`. The DTO has no `@JsonInclude`, so the key is present with a null value.
  - `Digital Support` (5) has a manager (`ghost.m`, uuid `7e5e...0099`) who has no position and so is
    NOT in `users[]`: a join of manager to mirror misses.
  - `jens.t`, `anne.p` and `rune.a` hold positions on more than one unit; `peter.d` has `doNotInherit: true`.
  - Every user carries the real DTO fields `cpr` (placeholder `"0000000000"`), `nemloginUuid`, `phone` and
    KLE lists. A mapper test uses these to prove the fields are dropped.
  - The real exporter only returns users that have at least one position, and it includes disabled users.
- `managers-v2.json`: `jens.t` manages Borgerservice and has `anne.p` as a substitute for it. `ghost.m`
  (not in organisation v3) is listed with `ida.l` as substitute for Digital Support, so a substitute can
  reference a manager that is not in the mirror.
- `roles-as-list*.json`: a disabled user still gets a 200 with their roles. Callers must check `disabled`.
- `role-assignments-with-constraints.json` (one case per user):
  - `anne.p`: `tt-bruger` unconstrained, `tt-skabelonansvarlig` with the KOMBIT OU constraint
    `http://sts.kombit.dk/constraints/orgenhed/1` and TWO units (3, 4).
  - `jens.t`: `tt-skabelonansvarlig` with the internal OU constraint `http://digital-identity.dk/constraints/orgunit/1`
    (unit 2) plus a KLE constraint, so a mapper must pick by `entityId`.
  - `peter.d`: `tt-skabelonansvarlig` twice, once constrained (unit 3) and once unconstrained (duplicate `roleIdentifier`).
  - `sofie.s` (disabled): `tt-bruger`. The endpoint carries no `disabled` flag.
  - `lars.f`: `tt-bruger` and `tt-logleser` constrained to unit 4 and to the UNKNOWN unit `5a1b...0077` (partly unknown).
  - `mette.e`: `tt-administrator` WITH an OU constraint (must be ignored: administrator is never scoped).
  - `ida.l`: `tt-logleser` with no constraint (no scope, and not a default global role).
  - `ole.k`: `tt-skabelonansvarlig` constrained ONLY to the unknown unit `5a1b...0077` (all unknown = no scope)
    and a non-tt role `referat_legacy` (ignored).
  - `rune.a`: `tt-administrator` with no constraint (global).
  - `ghost.u`: an assignment for a user that is not in organisation v3.
- `user-assignments-v2.json`: `postponedConstraints[].value` is a comma-joined string, not an array.

## Not covered by fixtures (no body)

- `rolesAsList` for an unknown or deleted user, unknown domain, or unknown system: HTTP 404 with an empty body.
- `roleAssignmentsWithContraints` for an unknown system: HTTP 404 with body `[]`.
