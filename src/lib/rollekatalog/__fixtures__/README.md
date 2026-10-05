# Rollekatalog test fixtures

**These fixtures are SYNTHETIC.** They were hand-written from the Java DTO classes of
OS2rollekatalog release `2026r4` (git `c7e7f88`). They were **not** recorded from a live
instance. All names, UUIDs, emails and ids are fictitious (`example.dk`, all-zero CPR).
Shapes follow the source, but real instances may differ in ordering and in omitted/extra
fields, so treat them as contract fixtures, not recordings.

| File | Endpoint | Source DTO classes (`dk.digitalidentity.rc.controller.api...`) |
|---|---|---|
| `organisation-v3.json` | `GET /api/organisation/v3` | `model.OrganisationDTO`, `model.UserDTO`, `model.PositionDTO`, `model.UserOUFunctionDTO`, `model.OrgUnitDTO`, `model.ManagerDTO`, enum `OrgUnitLevel` |
| `managers-v2.json` | `GET /api/v2/manager` | records `ManagerRecord` and `ManagerSubstituteRecord` in `v2.ManagerSubstituteApiV2` |
| `roles-as-list.json` | `GET /api/user/{userid}/rolesAsList?system=...` | `dto.UserResponseWithRolesDTO` (extends `dto.UserResponseDTO`) |
| `roles-as-list-disabled.json` | same, user with `disabled: true` | same |
| `role-assignments-with-constraints.json` | `GET /api/read/itsystem/roleAssignmentsWithContraints/{system}` | `dto.RoleAssignmentsWithContraints`, `dto.RoleAssignmentWithContraints`, `dto.ConstraintValue` |
| `user-assignments-v2.json` | `GET /api/v2/user/{userid}/assignments` | `model.UserUserRoleAssignmentAM`, `model.PostponedConstraintAM`, `model.UserRoleAM`, `model.SystemRoleAssignmentAM`, `model.SystemRoleAssignmentConstraintValueAM` (abbreviated: request/approver permission fields omitted) |

## Intentional properties

- `organisation-v3.json`: a 3-level tree (LEVEL_1 root, two LEVEL_2, one LEVEL_3), six users.
  - `sofie.s` is `disabled: true`.
  - `Team Selvbetjening` has `manager: null`. The DTO has no `@JsonInclude`, so the key is present with a null value.
  - `jens.t` and `anne.p` hold positions on more than one OU; `peter.d` has `doNotInherit: true`.
  - Every user carries the real DTO fields `cpr` (placeholder `"0000000000"`) and `nemloginUuid` (`null`). A mapper test can use these to prove the fields are dropped.
  - The real exporter only returns users that have at least one position, and it includes disabled users.
- `managers-v2.json`: `jens.t` manages Borgerservice and has `anne.p` as a substitute for it.
- `roles-as-list*.json`: a disabled user still gets a 200 with their roles. Callers must check `disabled`.
- `role-assignments-with-constraints.json`:
  - `constraintType` is the constraint type `entityId` (a URL), not its name or uuid.
  - `constraintValues` is the stored value split on `,`; for OU constraints these are OU uuids.
  - `anne.p` carries the KOMBIT OU constraint `http://sts.kombit.dk/constraints/orgenhed/1`.
  - `jens.t` carries the internal OU constraint `http://digital-identity.dk/constraints/orgunit/1` and a KLE constraint, so a mapper must pick by `entityId`.
  - `peter.d` has the same `roleIdentifier` twice, once constrained and once unconstrained. This can happen when the role has `allowPostponing` or several user roles contain the same system role.
  - `sofie.s` (disabled) is present, because the endpoint carries no `disabled` flag.
- `user-assignments-v2.json`: `postponedConstraints[].value` is a comma-joined string, not an array.

## Not covered by fixtures (no body)

- `rolesAsList` for an unknown or deleted user, unknown domain, or unknown system: HTTP 404 with an empty body.
- `roleAssignmentsWithContraints` for an unknown system: HTTP 404 with body `[]`.

The role identifiers (`referat_user`, `referat_lead`) and user-role identifiers are invented for these fixtures.
