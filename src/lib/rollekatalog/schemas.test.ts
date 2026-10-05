import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RollekatalogError } from './errors';
import {
  constraintTypesSchema,
  managersSchema,
  organisationSchema,
  parseOrThrow,
  roleAssignmentsSchema,
  rolesAsListSchema,
} from './schemas';

const fx = (name: string): unknown => JSON.parse(readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8'));

const FORBIDDEN_KEY = /cpr|nemlogin|phone|kle/i;

function forbiddenKeys(value: unknown, trail = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenKeys(v, `${trail}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [
      ...(FORBIDDEN_KEY.test(k) ? [`${trail}.${k}`] : []),
      ...forbiddenKeys(v, `${trail}.${k}`),
    ]);
  }
  return [];
}

const UUID_A = '5A1B0000-0000-4000-8000-000000000001';
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof RollekatalogError ? e.code : `other:${String(e)}`;
  }
  return null;
};

describe('organisation v3', () => {
  const raw = fx('organisation-v3.json') as { users: Array<Record<string, unknown>>; orgUnits: unknown[] };
  const parsed = parseOrThrow(organisationSchema, raw);

  it('the raw fixture really contains the fields we must drop (positive control)', () => {
    expect(forbiddenKeys(raw).length).toBeGreaterThan(10);
    expect(raw.users[0]).toHaveProperty('cpr');
    expect(raw.users[0]).toHaveProperty('nemloginUuid');
  });

  it('parses the fixture: 9 users, 5 units, 4 levels', () => {
    expect(parsed.users).toHaveLength(9);
    expect(parsed.orgUnits).toHaveLength(5);
    const byUuid = new Map(parsed.orgUnits.map((o) => [o.uuid, o]));
    let depth = 0;
    for (let cur = byUuid.get('5a1b0000-0000-4000-8000-000000000005'); cur; cur = byUuid.get(cur.parentOrgUnitUuid ?? '')) depth++;
    expect(depth).toBe(4);
  });

  it('drops cpr, nemloginUuid, phone and KLE: no key survives (deep scan)', () => {
    expect(forbiddenKeys(parsed)).toEqual([]);
    expect(JSON.stringify(parsed)).not.toContain('0000000000"');
  });

  it('exposes only whitelisted keys on users, positions and units', () => {
    expect(Object.keys(parsed.users[0]).sort()).toEqual(['disabled', 'email', 'extUuid', 'name', 'positions', 'userId', 'uuid']);
    expect(Object.keys(parsed.users[0].positions[0]).sort()).toEqual(['doNotInherit', 'orgUnitUuid', 'titleUuid']);
    expect(Object.keys(parsed.orgUnits[0]).sort()).toEqual(['manager', 'name', 'parentOrgUnitUuid', 'uuid']);
  });

  it('keeps the disabled flag and multiple positions', () => {
    expect(parsed.users.find((u) => u.userId === 'sofie.s')?.disabled).toBe(true);
    expect(parsed.users.find((u) => u.userId === 'jens.t')?.positions).toHaveLength(2);
    expect(parsed.users.find((u) => u.userId === 'peter.d')?.positions[0].doNotInherit).toBe(true);
  });

  it('models manager as null when absent or null, and keeps a manager that is not in users', () => {
    const team = parsed.orgUnits.find((o) => o.name === 'Team Selvbetjening');
    expect(team?.manager).toBeNull();
    const support = parsed.orgUnits.find((o) => o.name === 'Digital Support');
    expect(support?.manager?.userId).toBe('ghost.m');
    expect(parsed.users.some((u) => u.userId === 'ghost.m')).toBe(false);
    const noKey = parseOrThrow(organisationSchema, {
      users: [],
      orgUnits: [{ uuid: UUID_A, name: 'X' }],
    });
    expect(noKey.orgUnits[0]).toEqual({ uuid: UUID_A.toLowerCase(), name: 'X', parentOrgUnitUuid: null, manager: null });
  });

  it('normalises uuids to lower case', () => {
    const out = parseOrThrow(organisationSchema, {
      users: [{ uuid: UUID_A, extUuid: UUID_A, userId: 'a', name: 'A', disabled: false, positions: [{ orgUnitUuid: UUID_A }] }],
      orgUnits: [{ uuid: UUID_A, name: 'X', parentOrgUnitUuid: UUID_A, manager: { uuid: UUID_A, userId: 'a' } }],
    });
    const lc = UUID_A.toLowerCase();
    expect(out.users[0]).toMatchObject({ uuid: lc, extUuid: lc });
    expect(out.users[0].positions[0].orgUnitUuid).toBe(lc);
    expect(out.orgUnits[0]).toMatchObject({ uuid: lc, parentOrgUnitUuid: lc, manager: { uuid: lc } });
  });

  it('tolerates null/missing optional user fields (positions null, no email, non-uuid extUuid)', () => {
    const out = parseOrThrow(organisationSchema, {
      users: [{ uuid: UUID_A, extUuid: 'S-1-5-21-123', userId: null, name: null, email: null, disabled: false, positions: null }],
      orgUnits: [],
    });
    expect(out.users[0]).toEqual({ uuid: UUID_A.toLowerCase(), extUuid: null, userId: null, name: UUID_A.toLowerCase(), email: null, disabled: false, positions: [] });
  });

  it('drops a position without an org unit', () => {
    const out = parseOrThrow(organisationSchema, {
      users: [{ uuid: UUID_A, name: 'A', disabled: false, positions: [{ orgUnitUuid: null }, { orgUnitUuid: UUID_A }] }],
      orgUnits: [],
    });
    expect(out.users[0].positions).toHaveLength(1);
  });

  it('rejects malformed payloads as invalid_response', () => {
    const bad: unknown[] = [
      null,
      [],
      {},
      { users: [], orgUnits: 'x' },
      { users: [{ uuid: 'not-a-uuid', name: 'A', disabled: false }], orgUnits: [] },
      { users: [{ uuid: UUID_A, name: 'A' }], orgUnits: [] }, // disabled missing: never read as enabled
      { users: [], orgUnits: [{ uuid: UUID_A }] }, // name missing
      { users: [], orgUnits: [{ uuid: UUID_A, name: 'X', manager: { userId: 'x' } }] },
    ];
    for (const b of bad) expect(code(() => parseOrThrow(organisationSchema, b)), JSON.stringify(b)).toBe('invalid_response');
  });

  it('does not echo the payload in the error', () => {
    try {
      parseOrThrow(organisationSchema, { users: [{ uuid: 'secret-value', name: 'A', disabled: false }], orgUnits: [] });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('secret-value');
      expect(JSON.stringify(e)).not.toContain('secret-value');
    }
  });
});

describe('managers v2', () => {
  const parsed = parseOrThrow(managersSchema, fx('managers-v2.json'));
  it('parses managers and substitutes with the manager uuid', () => {
    expect(parsed).toHaveLength(4);
    const jens = parsed.find((m) => m.userId === 'jens.t');
    expect(jens?.managerSubstitutes).toEqual([
      {
        uuid: '7e5e0000-0000-4000-8000-000000000003',
        userId: 'anne.p',
        orgUnitUuid: '5a1b0000-0000-4000-8000-000000000002',
        managerUuid: '7e5e0000-0000-4000-8000-000000000002',
      },
    ]);
  });
  it('whitelists keys (no org unit name, no manager user id on substitutes)', () => {
    const sub = parsed.flatMap((m) => m.managerSubstitutes)[0];
    expect(Object.keys(sub).sort()).toEqual(['managerUuid', 'orgUnitUuid', 'userId', 'uuid']);
  });
  it('accepts an empty list and tolerates managerSubstitutes null', () => {
    expect(parseOrThrow(managersSchema, [])).toEqual([]);
    expect(parseOrThrow(managersSchema, [{ uuid: UUID_A, managerSubstitutes: null }])[0].managerSubstitutes).toEqual([]);
  });
  it('rejects malformed payloads', () => {
    expect(code(() => parseOrThrow(managersSchema, {}))).toBe('invalid_response');
    expect(code(() => parseOrThrow(managersSchema, [{ name: 'x' }]))).toBe('invalid_response');
    expect(code(() => parseOrThrow(managersSchema, [{ uuid: UUID_A, managerSubstitutes: [{ uuid: UUID_A }] }]))).toBe('invalid_response');
  });
});

describe('roleAssignmentsWithContraints', () => {
  const parsed = parseOrThrow(roleAssignmentsSchema, fx('role-assignments-with-constraints.json'));
  it('parses every user and keeps constraint type as the entityId URL', () => {
    expect(parsed).toHaveLength(10);
    const anne = parsed.find((u) => u.userId === 'anne.p');
    expect(anne?.assignments[1].roleConstraintValues).toEqual([
      {
        constraintType: 'http://sts.kombit.dk/constraints/orgenhed/1',
        constraintValues: ['5a1b0000-0000-4000-8000-000000000003', '5a1b0000-0000-4000-8000-000000000004'],
      },
    ]);
  });
  it('keeps duplicate roleIdentifier entries as they come', () => {
    const peter = parsed.find((u) => u.userId === 'peter.d');
    expect(peter?.assignments.map((a) => a.roleIdentifier)).toEqual(['tt-skabelonansvarlig', 'tt-skabelonansvarlig']);
  });
  it('has no forbidden keys and tolerates null lists', () => {
    expect(forbiddenKeys(parsed)).toEqual([]);
    const out = parseOrThrow(roleAssignmentsSchema, [{ extUuid: null, userId: 'x', assignments: [{ roleIdentifier: 'a', roleConstraintValues: null }] }]);
    expect(out[0].assignments[0].roleConstraintValues).toEqual([]);
  });
  it('accepts an empty list (unknown system answers [])', () => {
    expect(parseOrThrow(roleAssignmentsSchema, [])).toEqual([]);
  });
  it('rejects malformed payloads', () => {
    expect(code(() => parseOrThrow(roleAssignmentsSchema, { a: 1 }))).toBe('invalid_response');
    expect(code(() => parseOrThrow(roleAssignmentsSchema, [{ userId: 'x', assignments: [{ roleName: 'n' }] }]))).toBe('invalid_response');
    expect(code(() => parseOrThrow(roleAssignmentsSchema, [{ userId: 'x', assignments: [{ roleIdentifier: 'a', roleConstraintValues: [{ constraintType: 'x', constraintValues: [1] }] }] }]))).toBe('invalid_response');
  });
});

describe('rolesAsList', () => {
  it('parses the fixtures and strips roleMap', () => {
    const ok = parseOrThrow(rolesAsListSchema, fx('roles-as-list.json'));
    expect(ok.disabled).toBe(false);
    expect(ok.systemRoles).toEqual(['tt-bruger', 'tt-skabelonansvarlig']);
    expect(ok).not.toHaveProperty('roleMap');
    const off = parseOrThrow(rolesAsListSchema, fx('roles-as-list-disabled.json'));
    expect(off.disabled).toBe(true);
    expect(off.systemRoles).toEqual(['tt-bruger']);
  });
  it('tolerates missing role lists but never a missing disabled flag', () => {
    expect(parseOrThrow(rolesAsListSchema, { disabled: false }).systemRoles).toEqual([]);
    expect(code(() => parseOrThrow(rolesAsListSchema, { systemRoles: ['tt-bruger'] }))).toBe('invalid_response');
    expect(code(() => parseOrThrow(rolesAsListSchema, { systemRoles: 'tt-bruger', disabled: false }))).toBe('invalid_response');
  });
});

describe('constraint types', () => {
  it('parses the fixture and strips description/regex', () => {
    const out = parseOrThrow(constraintTypesSchema, fx('constraints-v2.json'));
    expect(out.map((c) => c.entityId)).toContain('http://digital-identity.dk/constraints/orgunit/1');
    expect(out[0]).not.toHaveProperty('regex');
    expect(out[0]).not.toHaveProperty('description');
  });
  it('rejects malformed payloads', () => {
    expect(code(() => parseOrThrow(constraintTypesSchema, [{ id: 'x', entityId: 'y' }]))).toBe('invalid_response');
    expect(code(() => parseOrThrow(constraintTypesSchema, 'nope'))).toBe('invalid_response');
  });
});
