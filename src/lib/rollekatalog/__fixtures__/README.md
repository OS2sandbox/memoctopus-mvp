# Rollekatalog test fixtures

**These fixtures are SYNTHETIC.** Hand-written from the Java DTO classes of OS2rollekatalog
release `2026r4`, not recorded from a live instance. All names, UUIDs and emails are fictitious
(`example.dk`, all-zero CPR), so treat them as contract fixtures. They are served by
`../mock-server.ts`, which the client, mapper, sync and end-to-end tests use. The source facts
behind them are listed in `docs/central-access/rollekatalog.md` ("Assumptions taken from the
Rollekatalog source").

- `organisation-v3.json`: `GET /api/organisation/v3`, a 4-level org tree (5 units) with nine users, one of them disabled. The users still carry `cpr`, `nemloginUuid`, phone and KLE fields, and the org units still carry `manager`, as the real payload does. The schemas strip all of them (`../schemas.ts`), and `../schemas.test.ts` uses them as positive controls to prove nothing survives parsing.
- `role-assignments-with-constraints.json`: `GET /api/read/itsystem/roleAssignmentsWithContraints/{system}`, ten user entries with one edge case each: scoped (internal and KOMBIT org-unit constraint types), a KLE constraint that must be ignored, duplicate assignments of one role, an unconstrained role that needs a scope, an administrator with a constraint, an unknown role identifier, and a user that is not in the organisation answer.
