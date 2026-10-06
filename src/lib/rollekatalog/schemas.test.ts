import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RollekatalogError } from './errors';
import {
  INVALID_ROWS_MAX_PERCENT,
  INVALID_ROWS_MIN_ALLOWANCE,
  invalidRowAllowance,
  organisationSchema,
  parseOrThrow,
  roleAssignmentsSchema,
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
    expect(Object.keys(parsed.orgUnits[0]).sort()).toEqual(['name', 'parentOrgUnitUuid', 'uuid']);
  });

  it('keeps the disabled flag and multiple positions', () => {
    expect(parsed.users.find((u) => u.userId === 'sofie.s')?.disabled).toBe(true);
    expect(parsed.users.find((u) => u.userId === 'jens.t')?.positions).toHaveLength(2);
    expect(parsed.users.find((u) => u.userId === 'peter.d')?.positions[0].doNotInherit).toBe(true);
  });

  it('strips the manager of an org unit: it is not parsed, so even a malformed one cannot fail the payload', () => {
    expect(raw.orgUnits.some((o) => (o as { manager?: unknown }).manager)).toBe(true);
    expect(parsed.orgUnits.some((o) => 'manager' in o)).toBe(false);
    const out = parseOrThrow(organisationSchema, {
      users: [],
      orgUnits: [{ uuid: UUID_A, name: 'X', manager: { userId: 'no-uuid' } }],
    });
    expect(out.orgUnits[0]).toEqual({ uuid: UUID_A.toLowerCase(), name: 'X', parentOrgUnitUuid: null });
  });

  it('normalises uuids to lower case', () => {
    const out = parseOrThrow(organisationSchema, {
      users: [{ uuid: UUID_A, extUuid: UUID_A, userId: 'a', name: 'A', disabled: false, positions: [{ orgUnitUuid: UUID_A }] }],
      orgUnits: [{ uuid: UUID_A, name: 'X', parentOrgUnitUuid: UUID_A, manager: { uuid: UUID_A, userId: 'a' } }],
    });
    const lc = UUID_A.toLowerCase();
    expect(out.users[0]).toMatchObject({ uuid: lc, extUuid: lc });
    expect(out.users[0].positions[0].orgUnitUuid).toBe(lc);
    expect(out.orgUnits[0]).toMatchObject({ uuid: lc, parentOrgUnitUuid: lc });
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
      { users: [] }, // orgUnits missing
      { orgUnits: [] }, // users missing
      { users: 'x', orgUnits: [] },
      { users: {}, orgUnits: [] },
    ];
    for (const b of bad) expect(code(() => parseOrThrow(organisationSchema, b)), JSON.stringify(b)).toBe('invalid_response');
  });

  it('does not echo the payload in the error', () => {
    try {
      parseOrThrow(organisationSchema, { users: Array.from({ length: 4 }, () => ({ uuid: 'secret-value', name: 'A', disabled: false })), orgUnits: [] });
      throw new Error('expected invalid_response');
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('secret-value');
      expect(JSON.stringify(e)).not.toContain('secret-value');
    }
  });
});

describe('roleAssignmentsWithContraints', () => {
  const parsed = parseOrThrow(roleAssignmentsSchema, fx('role-assignments-with-constraints.json')).rows;
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
    expect(out.rows[0].assignments[0].roleConstraintValues).toEqual([]);
  });
  it('accepts an empty list (unknown system answers [])', () => {
    expect(parseOrThrow(roleAssignmentsSchema, [])).toEqual({ rows: [], skipped: 0 });
  });
  it('rejects a payload that is not an array', () => {
    expect(code(() => parseOrThrow(roleAssignmentsSchema, { a: 1 }))).toBe('invalid_response');
    expect(code(() => parseOrThrow(roleAssignmentsSchema, null))).toBe('invalid_response');
  });
});

describe('invalid-row allowance', () => {
  it('is max(3, 5 % rounded down): the thresholds live in one place', () => {
    expect(INVALID_ROWS_MIN_ALLOWANCE).toBe(3);
    expect(INVALID_ROWS_MAX_PERCENT).toBe(5);
    expect([0, 1, 10, 60, 79, 80, 99, 100, 1000, 50000].map(invalidRowAllowance)).toEqual([3, 3, 3, 3, 3, 4, 4, 5, 50, 2500]);
  });
});

const goodUser = (n: number, extra: Record<string, unknown> = {}) => ({
  uuid: `5a1b0000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  extUuid: null,
  userId: `u${n}`,
  name: `User ${n}`,
  email: null,
  disabled: false,
  positions: [],
  ...extra,
});
const goodUnit = (n: number, extra: Record<string, unknown> = {}) => ({
  uuid: `6b2c0000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  name: `Unit ${n}`,
  parentOrgUnitUuid: null,
  ...extra,
});
const users = (good: number, bad: number) => [
  ...Array.from({ length: good }, (_, i) => goodUser(i + 1)),
  ...Array.from({ length: bad }, (_, i) => goodUser(1000 + i, { uuid: `legacy-${i}` })),
];

describe('organisation v3: row-by-row tolerance', () => {
  it('drops one bad user uuid among good rows, parses the rest and reports the count', () => {
    const out = parseOrThrow(organisationSchema, {
      users: [goodUser(1), goodUser(2, { uuid: 'LEGACY-ID-1' }), goodUser(3)],
      orgUnits: [goodUnit(1)],
    });
    expect(out.users.map((u) => u.userId)).toEqual(['u1', 'u3']);
    expect(out.skipped).toEqual({ users: 1, orgUnits: 0, positions: 0 });
  });

  it('drops a bad org unit uuid, a unit without a name and non-object rows, and counts them', () => {
    const out = parseOrThrow(organisationSchema, {
      users: [goodUser(1)],
      orgUnits: [goodUnit(1), goodUnit(2, { uuid: 'x' }), goodUnit(3, { name: undefined }), null],
    });
    expect(out.orgUnits).toHaveLength(1);
    expect(out.skipped.orgUnits).toBe(3);
  });

  it('drops a user without the disabled flag (never read as enabled) and counts it', () => {
    const out = parseOrThrow(organisationSchema, { users: [goodUser(1), goodUser(2, { disabled: undefined })], orgUnits: [] });
    expect(out.users).toHaveLength(1);
    expect(out.skipped.users).toBe(1);
  });

  it('a malformed position costs the position only; a non-uuid orgUnitUuid is dropped quietly (its unit is counted as skipped)', () => {
    const out = parseOrThrow(organisationSchema, {
      users: [
        goodUser(1, {
          positions: [
            { orgUnitUuid: goodUnit(1).uuid },
            { orgUnitUuid: goodUnit(2).uuid, doNotInherit: 'yes' }, // wrong shape
            'not-an-object',
            { orgUnitUuid: 'legacy-unit' }, // valid shape, unit id is not a uuid
          ],
        }),
      ],
      orgUnits: [],
    });
    expect(out.users).toHaveLength(1);
    expect(out.users[0].positions.map((p) => p.orgUnitUuid)).toEqual([goodUnit(1).uuid]);
    expect(out.skipped).toEqual({ users: 0, orgUnits: 0, positions: 2 });
  });

  it('a user whose positions is not an array is a bad row', () => {
    const out = parseOrThrow(organisationSchema, { users: [goodUser(1), goodUser(2, { positions: 'x' })], orgUnits: [] });
    expect(out.skipped.users).toBe(1);
  });

  it('still fails the whole payload on payload-level corruption', () => {
    for (const bad of [null, 'x', [], { users: null, orgUnits: [] }, { users: [], orgUnits: {} }, {}]) {
      expect(code(() => parseOrThrow(organisationSchema, bad)), JSON.stringify(bad)).toBe('invalid_response');
    }
  });

  it('boundary: 10 rows tolerate 3 bad, 4 abort', () => {
    expect(parseOrThrow(organisationSchema, { users: users(7, 3), orgUnits: [] }).skipped.users).toBe(3);
    expect(code(() => parseOrThrow(organisationSchema, { users: users(6, 4), orgUnits: [] }))).toBe('invalid_response');
  });

  it('boundary: 1000 rows tolerate 50 bad, 51 abort', () => {
    expect(parseOrThrow(organisationSchema, { users: users(950, 50), orgUnits: [] }).skipped.users).toBe(50);
    expect(code(() => parseOrThrow(organisationSchema, { users: users(949, 51), orgUnits: [] }))).toBe('invalid_response');
  });

  it('boundary applies to org units too, per array', () => {
    const units = (good: number, bad: number) => [
      ...Array.from({ length: good }, (_, i) => goodUnit(i + 1)),
      ...Array.from({ length: bad }, (_, i) => goodUnit(1000 + i, { uuid: `legacy-${i}` })),
    ];
    expect(parseOrThrow(organisationSchema, { users: [goodUser(1)], orgUnits: units(7, 3) }).skipped.orgUnits).toBe(3);
    expect(code(() => parseOrThrow(organisationSchema, { users: [goodUser(1)], orgUnits: units(6, 4) }))).toBe('invalid_response');
  });

  it('an array of nothing but bad rows aborts (a corrupt export never becomes an empty mirror)', () => {
    expect(code(() => parseOrThrow(organisationSchema, { users: users(0, 4), orgUnits: [] }))).toBe('invalid_response');
  });

  it('the abort neither echoes nor logs anything', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      parseOrThrow(organisationSchema, { users: users(0, 4), orgUnits: [] });
    } catch (e) {
      expect(JSON.stringify(e) + String(e)).not.toContain('legacy-');
    }
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('the cpr / nemloginUuid whitelist is unchanged for the rows that stay', () => {
    const out = parseOrThrow(organisationSchema, {
      users: [goodUser(1, { cpr: '0101010000', nemloginUuid: 'secret', phone: '1' }), goodUser(2, { uuid: 'bad', cpr: '0202020000' })],
      orgUnits: [],
    });
    expect(JSON.stringify(out)).not.toMatch(/0101010000|0202020000|secret/);
    expect(Object.keys(out.users[0]).sort()).toEqual(['disabled', 'email', 'extUuid', 'name', 'positions', 'userId', 'uuid']);
  });
});

describe('roleAssignmentsWithContraints: row-by-row tolerance', () => {
  const row = (n: number, extra: Record<string, unknown> = {}) => ({
    extUuid: null,
    userId: `u${n}`,
    assignments: [{ roleIdentifier: 'tt-logleser', roleConstraintValues: [] }],
    ...extra,
  });

  it('drops a row with a wrong shape and keeps the rest', () => {
    const out = parseOrThrow(roleAssignmentsSchema, [row(1), row(2, { assignments: 'x' }), row(3, { userId: 5 }), 'junk', row(4)]);
    expect(out.rows.map((r) => r.userId)).toEqual(['u1', 'u4']);
    expect(out.skipped).toBe(3);
  });

  it('drops a bad assignment entry inside a valid row and keeps the row', () => {
    const out = parseOrThrow(roleAssignmentsSchema, [
      row(1, {
        assignments: [
          { roleIdentifier: 'tt-logleser', roleConstraintValues: [] },
          { roleName: 'n' }, // no roleIdentifier
          { roleIdentifier: 'tt-logleser', roleConstraintValues: [{ constraintType: 'x', constraintValues: [1] }] },
        ],
      }),
    ]);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].assignments).toHaveLength(1);
    expect(out.skipped).toBe(2);
  });

  it('boundary: 10 rows tolerate 3 bad, 4 abort', () => {
    const rows = (good: number, bad: number) => [
      ...Array.from({ length: good }, (_, i) => row(i)),
      ...Array.from({ length: bad }, (_, i) => row(100 + i, { assignments: 7 })),
    ];
    expect(parseOrThrow(roleAssignmentsSchema, rows(7, 3)).skipped).toBe(3);
    expect(code(() => parseOrThrow(roleAssignmentsSchema, rows(6, 4)))).toBe('invalid_response');
  });

  it('boundary: bad assignment entries are guarded against all entries', () => {
    const entries = (good: number, bad: number) => [
      ...Array.from({ length: good }, () => ({ roleIdentifier: 'tt-logleser' })),
      ...Array.from({ length: bad }, () => ({ nope: true })),
    ];
    expect(parseOrThrow(roleAssignmentsSchema, [row(1, { assignments: entries(7, 3) })]).skipped).toBe(3);
    expect(code(() => parseOrThrow(roleAssignmentsSchema, [row(1, { assignments: entries(6, 4) })]))).toBe('invalid_response');
  });
});
