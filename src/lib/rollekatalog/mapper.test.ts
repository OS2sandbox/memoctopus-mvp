import { describe, expect, it } from 'vitest';
import type { RoleKey } from '@/lib/authz/types';
import { mapToMirror, type MapperConfig, type MapperInput, type MirrorSet } from './mapper';
import { fixtureData } from './mock-server';
import { organisationSchema, roleAssignmentsSchema } from './schemas';

const U = (n: number) => `7e5e0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const O = (n: number) => `5a1b0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const E = (n: number) => `9d3c0000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const DEFAULTS: MapperConfig = { globalRoles: ['admin'] };

function fixtureInput(): MapperInput {
  const d = fixtureData();
  return {
    organisation: organisationSchema.parse({ users: d.users, orgUnits: d.orgUnits }),
    assignments: roleAssignmentsSchema.parse(d.roleAssignments),
  };
}

/** Builds a payload from compact descriptions; goes through the real schemas. */
function input(over: {
  users?: unknown[];
  orgUnits?: unknown[];
  assignments?: unknown[];
}): MapperInput {
  return {
    organisation: organisationSchema.parse({ users: over.users ?? [], orgUnits: over.orgUnits ?? [] }),
    assignments: roleAssignmentsSchema.parse(over.assignments ?? []),
  };
}

const user = (n: number, extra: Record<string, unknown> = {}) => ({
  uuid: U(n),
  extUuid: E(n),
  userId: `user${n}`,
  name: `User ${n}`,
  email: `user${n}@example.dk`,
  disabled: false,
  positions: [],
  ...extra,
});
const unit = (n: number, parent: number | string | null, extra: Record<string, unknown> = {}) => ({
  uuid: O(n),
  name: `Unit ${n}`,
  parentOrgUnitUuid: parent === null ? null : typeof parent === 'number' ? O(parent) : parent,
  manager: null,
  ...extra,
});
const OU = 'http://digital-identity.dk/constraints/orgunit/1';
const assignment = (n: number, ...roles: Array<{ id: string; units?: number[] }>) => ({
  extUuid: E(n),
  userId: `user${n}`,
  assignments: roles.map((r) => ({
    roleIdentifier: r.id,
    roleName: null,
    roleConstraintValues: r.units ? [{ constraintType: OU, constraintValues: r.units.map(O) }] : [],
  })),
});

const rolesOf = (set: MirrorSet, userUuid: string) =>
  set.assignments
    .filter((a) => a.directoryUserUuid === userUuid)
    .map((a) => `${a.roleKey}@${a.scopeOrgUnitUuid ?? 'null'}`)
    .sort();

describe('mapToMirror with the fixtures', () => {
  const set = mapToMirror(fixtureInput(), DEFAULTS);

  it('maps every user, keyed on the Rollekatalog uuid, with ext ids and the disabled flag', () => {
    expect(set.users).toHaveLength(9);
    const sofie = set.users.find((u) => u.extUserId === 'sofie.s');
    expect(sofie).toMatchObject({ uuid: U(5), extUuid: E(5), disabled: true, name: 'Sofie Syntetisk', email: 'sofie.s@example.dk' });
    expect(set.users.find((u) => u.extUserId === 'mette.e')?.disabled).toBe(false);
  });

  it('orders org units parents-first and keeps the 4-level tree', () => {
    expect(set.orgUnits.map((u) => u.uuid)).toEqual([O(1), O(2), O(4), O(3), O(5)]);
    const pos = new Map(set.orgUnits.map((u, i) => [u.uuid, i]));
    for (const u of set.orgUnits) if (u.parentUuid) expect(pos.get(u.parentUuid)!).toBeLessThan(pos.get(u.uuid)!);
    expect(set.orgUnits.find((u) => u.uuid === O(5))?.parentUuid).toBe(O(3));
    expect(set.stats.orgUnitsOrphaned).toBe(0);
    expect(set.stats.orgUnitCyclesBroken).toBe(0);
  });

  it('does not carry the fixture\'s org-unit managers into the mirror', () => {
    expect(set.orgUnits.every((u) => !('managerUuid' in u))).toBe(true);
  });

  it('builds members from positions (12 distinct user/unit pairs)', () => {
    expect(set.members).toHaveLength(12);
    const pairs = set.members.map((m) => `${m.directoryUserUuid}|${m.orgUnitUuid}`);
    expect(new Set(pairs).size).toBe(12);
    expect(pairs).toContain(`${U(2)}|${O(2)}`);
    expect(pairs).toContain(`${U(2)}|${O(3)}`);
  });

  it('maps role assignments per the fixture cases', () => {
    // bygger is not tied to org units: whatever its constraints (two KOMBIT units, KLE, an unknown unit,
    // none), it becomes one NULL-scope row.
    expect(rolesOf(set, U(3))).toEqual(['bruger@null', 'bygger@null']); // anne: two KOMBIT units
    expect(rolesOf(set, U(2))).toEqual(['bygger@null']); // jens: internal type plus KLE
    expect(rolesOf(set, U(6))).toEqual(['bygger@null']); // peter: duplicate entries unioned
    expect(rolesOf(set, U(5))).toEqual(['bruger@null']); // disabled user keeps the row; the principal checks `disabled`
    expect(rolesOf(set, U(4))).toEqual(['bruger@null', 'bygger@null']); // lars: unknown unit
    expect(rolesOf(set, U(1))).toEqual(['admin@null']); // mette: constraint on admin ignored
    expect(rolesOf(set, U(9))).toEqual(['admin@null']);
    expect(rolesOf(set, U(7))).toEqual(['bygger@null']); // ida: bygger without constraint
    expect(rolesOf(set, U(8))).toEqual(['bygger@null']); // ole: bygger with only an unknown unit
    expect(set.assignments).toHaveLength(11);
  });

  it('counts what it dropped', () => {
    expect(set.stats.assignmentsIgnoredRole).toBe(1); // referat_legacy
    expect(set.stats.assignmentsSkippedUnknownUser).toBe(1); // ghost.u
    expect(set.stats.assignmentsWithoutScope).toBe(0);
  });

  it('every row is unscoped and covers descendants', () => {
    expect(set.assignments.every((a) => a.scopeOrgUnitUuid === null && a.includeDescendants)).toBe(true);
  });

  it('never produces more than one row per (user, role, scope)', () => {
    const keys = set.assignments.map((a) => `${a.directoryUserUuid}|${a.roleKey}|${a.scopeOrgUnitUuid}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('is deterministic', () => {
    expect(mapToMirror(fixtureInput(), DEFAULTS)).toEqual(set);
  });
});

describe('mapToMirror: GLOBAL_ROLES on the fixtures', () => {
  it('only decides the administrators: without admin in it, mette and rune get no row; byggere are unaffected', () => {
    const set = mapToMirror(fixtureInput(), { globalRoles: [] });
    expect(rolesOf(set, U(1))).toEqual([]);
    expect(rolesOf(set, U(9))).toEqual([]);
    expect(rolesOf(set, U(7))).toEqual(['bygger@null']);
    expect(set.stats.assignmentsWithoutScope).toBe(2);
  });
});

describe('mapToMirror: org tree edge cases', () => {
  const users = [user(1)];

  it('stores a unit whose parent was not fetched with a NULL parent and counts it', () => {
    const set = mapToMirror(
      input({ users, orgUnits: [unit(1, null), unit(2, 1), unit(3, 99)] }),
      DEFAULTS,
    );
    expect(set.orgUnits.find((u) => u.uuid === O(3))?.parentUuid).toBeNull();
    expect(set.orgUnits.find((u) => u.uuid === O(2))?.parentUuid).toBe(O(1));
    expect(set.stats.orgUnitsOrphaned).toBe(1);
    expect(set.stats.orgUnitCyclesBroken).toBe(0);
  });

  it('breaks a two-unit cycle at its smallest uuid, deterministically, and counts it', () => {
    const a = mapToMirror(input({ users, orgUnits: [unit(1, 2), unit(2, 1)] }), DEFAULTS);
    const b = mapToMirror(input({ users, orgUnits: [unit(2, 1), unit(1, 2)] }), DEFAULTS);
    expect(a).toEqual(b);
    expect(a.stats.orgUnitCyclesBroken).toBe(1);
    expect(a.orgUnits.find((u) => u.uuid === O(1))?.parentUuid).toBeNull();
    expect(a.orgUnits.find((u) => u.uuid === O(2))?.parentUuid).toBe(O(1));
    expect(a.orgUnits.map((u) => u.uuid)).toEqual([O(1), O(2)]);
  });

  it('breaks a self parent', () => {
    const set = mapToMirror(input({ users, orgUnits: [unit(1, 1)] }), DEFAULTS);
    expect(set.orgUnits).toEqual([expect.objectContaining({ uuid: O(1), parentUuid: null })]);
    expect(set.stats.orgUnitCyclesBroken).toBe(1);
  });

  it('breaks a long cycle with a tail hanging off it and never stores a cycle', () => {
    const units = [unit(3, 2), unit(2, 4), unit(4, 3), unit(7, 4), unit(8, 7), unit(1, null)];
    const set = mapToMirror(input({ users, orgUnits: units }), DEFAULTS);
    expect(set.stats.orgUnitCyclesBroken).toBe(1);
    // Cut at the smallest uuid of the cycle (O(2)); the tail keeps hanging below the cycle.
    expect(set.orgUnits.find((u) => u.uuid === O(2))?.parentUuid).toBeNull();
    expect(set.orgUnits).toHaveLength(6);
    const parent = new Map(set.orgUnits.map((u) => [u.uuid, u.parentUuid]));
    for (const id of parent.keys()) {
      const seen = new Set<string>();
      for (let cur: string | null | undefined = id; cur; cur = parent.get(cur)) {
        expect(seen.has(cur)).toBe(false);
        seen.add(cur);
      }
    }
    const pos = new Map(set.orgUnits.map((u, i) => [u.uuid, i]));
    for (const u of set.orgUnits) if (u.parentUuid) expect(pos.get(u.parentUuid)!).toBeLessThan(pos.get(u.uuid)!);
  });

  it('counts two separate cycles', () => {
    const set = mapToMirror(input({ users, orgUnits: [unit(1, 2), unit(2, 1), unit(3, 4), unit(4, 3)] }), DEFAULTS);
    expect(set.stats.orgUnitCyclesBroken).toBe(2);
    expect(set.orgUnits.filter((u) => u.parentUuid === null).map((u) => u.uuid)).toEqual([O(1), O(3)]);
  });

  it('keeps the first of two units with the same uuid', () => {
    const set = mapToMirror(input({ users, orgUnits: [unit(1, null, { name: 'First' }), unit(1, null, { name: 'Second' })] }), DEFAULTS);
    expect(set.orgUnits).toHaveLength(1);
    expect(set.orgUnits[0].name).toBe('First');
  });

  it('lower-cases uuids before they are compared', () => {
    const set = mapToMirror(
      input({ users, orgUnits: [unit(1, null, { uuid: O(1).toUpperCase() }), unit(2, O(1).toUpperCase())] }),
      DEFAULTS,
    );
    expect(set.orgUnits.map((u) => u.uuid)).toEqual([O(1), O(2)]);
    expect(set.orgUnits[1].parentUuid).toBe(O(1));
  });
});

describe('mapToMirror: users and members edge cases', () => {
  it('only the first user with a given ext_uuid keeps it (the column is UNIQUE) and a duplicate uuid is dropped', () => {
    const set = mapToMirror(
      input({
        users: [user(1), user(2, { extUuid: E(1) }), user(1, { name: 'Dup' })],
        orgUnits: [unit(1, null)],
      }),
      DEFAULTS,
    );
    expect(set.users).toHaveLength(2);
    expect(set.users.find((u) => u.uuid === U(1))).toMatchObject({ extUuid: E(1), name: 'User 1' });
    expect(set.users.find((u) => u.uuid === U(2))?.extUuid).toBeNull();
  });

  it('a non-uuid extUuid becomes null (the user is keyed on uuid only)', () => {
    const set = mapToMirror(input({ users: [user(1, { extUuid: 'CN=ad-style' })], orgUnits: [unit(1, null)] }), DEFAULTS);
    expect(set.users[0].extUuid).toBeNull();
  });

  it('drops positions on units that were not fetched and de-duplicates repeated positions', () => {
    const p = (n: number) => ({ orgUnitUuid: O(n), titleUuid: null, doNotInherit: false });
    const set = mapToMirror(
      input({ users: [user(1, { positions: [p(1), p(1), p(55)] })], orgUnits: [unit(1, null)] }),
      DEFAULTS,
    );
    expect(set.members).toEqual([{ directoryUserUuid: U(1), orgUnitUuid: O(1) }]);
  });
});

describe('mapToMirror: invalid rows', () => {
  const p = (n: number) => ({ orgUnitUuid: O(n), titleUuid: null, doNotInherit: false });

  it('reports the schema skip counts in the stats; a skipped unit turns its children into roots and its members into nothing', () => {
    const set = mapToMirror(
      input({
        users: [user(1, { positions: [p(1), p(2)] }), user(2, { uuid: 'legacy-user', positions: [p(1)] })],
        orgUnits: [unit(1, null), unit(2, 1), unit(3, 'legacy-unit'), unit(4, 3), unit(5, null, { uuid: 'legacy-unit' })],
        assignments: [assignment(1, { id: 'bygger' }), 'junk', { userId: 7 }],
      }),
      DEFAULTS,
    );
    expect(set.stats).toMatchObject({ usersSkippedInvalid: 1, orgUnitsSkippedInvalid: 1, assignmentRowsSkippedInvalid: 2, membershipsSkippedInvalid: 0 });
    expect(set.users.map((u) => u.uuid)).toEqual([U(1)]);
    // Unit 3's parent id is not a uuid: it is a root. Unit 4 still hangs under 3.
    expect(set.orgUnits.find((u) => u.uuid === O(3))?.parentUuid).toBeNull();
    expect(set.orgUnits.find((u) => u.uuid === O(4))?.parentUuid).toBe(O(3));
  });

  it('an assignment of a skipped user counts as an unknown user, never as a role', () => {
    const set = mapToMirror(
      input({
        users: [user(1, { uuid: 'legacy-user', extUuid: E(1) }), user(2)],
        orgUnits: [unit(1, null)],
        assignments: [assignment(1, { id: 'bygger', units: [1] })],
      }),
      DEFAULTS,
    );
    expect(set.assignments).toEqual([]);
    expect(set.stats).toMatchObject({ usersSkippedInvalid: 1, assignmentsSkippedUnknownUser: 1 });
  });
});

describe('mapToMirror: assignment edge cases', () => {
  const base = { users: [user(1), user(2)], orgUnits: [unit(1, null), unit(2, 1)] };

  it('joins by extUuid first, then by userId (case-insensitive), and never by an ambiguous userId', () => {
    const set = mapToMirror(
      input({
        ...base,
        users: [user(1), user(2), user(3, { userId: 'USER1' })],
        assignments: [
          { extUuid: E(2), userId: 'wrong', assignments: [{ roleIdentifier: 'bruger', roleConstraintValues: [] }] },
          { extUuid: null, userId: 'user2', assignments: [{ roleIdentifier: 'admin', roleConstraintValues: [] }] },
          { extUuid: null, userId: 'USER1', assignments: [{ roleIdentifier: 'bruger', roleConstraintValues: [] }] },
        ],
      }),
      DEFAULTS,
    );
    expect(rolesOf(set, U(2))).toEqual(['admin@null', 'bruger@null']);
    // user1 and USER1 collide case-insensitively: not guessed.
    expect(rolesOf(set, U(1))).toEqual([]);
    expect(rolesOf(set, U(3))).toEqual([]);
    expect(set.stats.assignmentsSkippedUnknownUser).toBe(1);
  });

  it('never falls back to userId when the entry carries an extUuid the mirror does not know', () => {
    const set = mapToMirror(
      input({
        ...base,
        assignments: [
          { extUuid: E(9), userId: 'user1', assignments: [{ roleIdentifier: 'admin', roleConstraintValues: [] }] },
        ],
      }),
      DEFAULTS,
    );
    expect(set.assignments).toEqual([]);
    expect(set.stats.assignmentsSkippedUnknownUser).toBe(1);
  });

  it('only matches our three role identifiers exactly', () => {
    const set = mapToMirror(
      input({
        ...base,
        assignments: [
          assignment(1, { id: 'bruger' }, { id: 'BRUGER' }, { id: 'referat_admin' }, { id: 'bygger-x' }),
        ],
      }),
      DEFAULTS,
    );
    expect(rolesOf(set, U(1))).toEqual(['bruger@null']);
    expect(set.stats.assignmentsIgnoredRole).toBe(3);
  });

  it('unions duplicate (user, role) entries into one unscoped row', () => {
    const set = mapToMirror(
      input({
        ...base,
        assignments: [assignment(1, { id: 'bygger', units: [1] }, { id: 'bygger', units: [2] }, { id: 'bygger' })],
      }),
      DEFAULTS,
    );
    expect(rolesOf(set, U(1))).toEqual(['bygger@null']);
  });

  it('an admin not in GLOBAL_ROLES gets no row and is counted; bygger needs no GLOBAL_ROLES', () => {
    const roles: RoleKey[] = ['bygger'];
    const set = mapToMirror(input({ ...base, assignments: [assignment(1, { id: 'bygger' }), assignment(2, { id: 'admin' })] }), {
      globalRoles: roles,
    });
    expect(rolesOf(set, U(1))).toEqual(['bygger@null']);
    expect(rolesOf(set, U(2))).toEqual([]);
    expect(set.stats.assignmentsWithoutScope).toBe(1);
  });

  describe('unrecognised constraint types fail closed', () => {
    const KLE_C = [{ constraintType: 'http://sts.kombit.dk/constraints/KLE/1', constraintValues: ['27.45.00'] }];
    const entry = (n: number, role: string, constraints: unknown[]) => ({
      extUuid: E(n),
      userId: `user${n}`,
      assignments: [{ roleIdentifier: role, roleName: null, roleConstraintValues: constraints }],
    });

    it('admin with only a KLE constraint gets no row and is counted; a bygger with one still gets its row', () => {
      const set = mapToMirror(
        input({
          ...base,
          users: [user(1), user(2), user(3)],
          assignments: [
            entry(1, 'admin', KLE_C),
            entry(2, 'bygger', KLE_C),
            { extUuid: E(3), userId: 'user3', assignments: [{ roleIdentifier: 'bygger', roleConstraintValues: [] }] },
          ],
        }),
        { ...DEFAULTS, globalRoles: ['admin', 'bygger'] },
      );
      expect(rolesOf(set, U(1))).toEqual([]);
      expect(rolesOf(set, U(2))).toEqual(['bygger@null']);
      expect(rolesOf(set, U(3))).toEqual(['bygger@null']);
      expect(set.stats.assignmentsWithoutScope).toBe(1);
    });

    it('an unknown-type admin entry cannot be widened by an unconstrained sibling', () => {
      const set = mapToMirror(
        input({
          ...base,
          assignments: [
            {
              extUuid: E(1),
              userId: 'user1',
              assignments: [
                { roleIdentifier: 'admin', roleConstraintValues: KLE_C },
                { roleIdentifier: 'admin', roleConstraintValues: [] },
              ],
            },
          ],
        }),
        DEFAULTS,
      );
      expect(rolesOf(set, U(1))).toEqual([]);
      expect(set.stats.assignmentsWithoutScope).toBe(1);
    });
  });

  describe('a dropped invalid entry drops the whole (user, role) group', () => {
    const scopedEntry = { roleIdentifier: 'bygger', roleConstraintValues: [{ constraintType: OU, constraintValues: [O(1)] }] };
    const brokenEntry = { roleIdentifier: 'bygger', roleConstraintValues: [{ constraintType: OU, constraintValues: [5] }] };
    const plain = { roleIdentifier: 'bygger', roleConstraintValues: [] };

    it('a broken scoped entry next to an unconstrained one never leaves a global row (even for a GLOBAL_ROLES role)', () => {
      const set = mapToMirror(
        input({ ...base, assignments: [{ extUuid: E(1), userId: 'user1', assignments: [brokenEntry, plain] }] }),
        { ...DEFAULTS, globalRoles: ['bygger'] },
      );
      expect(rolesOf(set, U(1))).toEqual([]);
      expect(set.stats.assignmentRowsSkippedInvalid).toBe(1);
    });

    it('also drops a valid scoped sibling, and only for the affected role and user', () => {
      const set = mapToMirror(
        input({
          ...base,
          assignments: [
            {
              extUuid: E(1),
              userId: 'user1',
              assignments: [scopedEntry, brokenEntry, { roleIdentifier: 'bruger', roleConstraintValues: [] }],
            },
            { extUuid: E(2), userId: 'user2', assignments: [scopedEntry] },
          ],
        }),
        DEFAULTS,
      );
      expect(rolesOf(set, U(1))).toEqual(['bruger@null']);
      expect(rolesOf(set, U(2))).toEqual(['bygger@null']);
    });

    it('applies across rows that resolve to the same user, and to a group whose only entry was the broken one', () => {
      const set = mapToMirror(
        input({
          ...base,
          assignments: [
            { extUuid: E(1), userId: 'user1', assignments: [brokenEntry] },
            { extUuid: null, userId: 'user1', assignments: [plain] },
          ],
        }),
        { ...DEFAULTS, globalRoles: ['bygger'] },
      );
      expect(rolesOf(set, U(1))).toEqual([]);
    });

    it('an invalid entry for a role that is not ours poisons nothing', () => {
      const set = mapToMirror(
        input({
          ...base,
          assignments: [
            { extUuid: E(1), userId: 'user1', assignments: [{ roleIdentifier: 'other-role', roleConstraintValues: 'x' }, scopedEntry] },
          ],
        }),
        DEFAULTS,
      );
      expect(rolesOf(set, U(1))).toEqual(['bygger@null']);
    });
  });

  it('the same user listed twice is merged into one group', () => {
    const set = mapToMirror(
      input({ ...base, assignments: [assignment(1, { id: 'bygger', units: [1] }), assignment(1, { id: 'bygger', units: [2] })] }),
      DEFAULTS,
    );
    expect(rolesOf(set, U(1))).toEqual(['bygger@null']);
  });
});

describe('privacy: nothing personal beyond the whitelist survives mapping', () => {
  it('no key matching /cpr|nemlogin/i anywhere in the mapped output, and no phone, KLE or title data', () => {
    // The fixture carries cpr "0000000000", nemloginUuid, phone and KLE lists on every user.
    const raw = JSON.stringify(fixtureData().users);
    expect(raw).toMatch(/cpr/);
    expect(raw).toMatch(/nemlogin/i);

    const set = mapToMirror(fixtureInput(), DEFAULTS);
    const keys: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        for (const [k, val] of Object.entries(v)) {
          keys.push(k);
          walk(val);
        }
      }
    };
    walk(set);
    expect(keys.filter((k) => /cpr|nemlogin/i.test(k))).toEqual([]);
    expect(keys.filter((k) => /phone|kle|title|position/i.test(k))).toEqual([]);

    const out = JSON.stringify(set);
    expect(out).not.toContain('"0000000000"'); // the placeholder cpr value, as a whole string
    expect(out).not.toContain('27.45.00');
    expect(out).not.toContain('Kommunaldirektør'); // job titles are not stored
    expect([...new Set(keys)].sort()).toEqual(
      [
        'assignments', 'directoryUserUuid', 'disabled', 'email', 'extUserId', 'extUuid', 'includeDescendants',
        'members', 'name', 'orgUnitCyclesBroken', 'orgUnitUuid', 'orgUnits', 'orgUnitsOrphaned', 'parentUuid', 'roleKey',
        'scopeOrgUnitUuid', 'stats', 'assignmentsIgnoredRole',
        'assignmentsSkippedUnknownUser', 'assignmentsWithoutScope', 'users', 'uuid',
        'usersSkippedInvalid', 'orgUnitsSkippedInvalid', 'assignmentRowsSkippedInvalid', 'membershipsSkippedInvalid',
      ].sort(),
    );
  });
});
