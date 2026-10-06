import { describe, expect, it } from 'vitest';
import { ROLE_KEYS, type RoleKey } from '@/lib/authz/types';
import { deriveScope } from './scope';
import type { DerivedScope, ScopeConstraint, ScopeInput } from './types';

const A = '5a1b0000-0000-4000-8000-00000000000a';
const B = '5a1b0000-0000-4000-8000-00000000000b';
const C = '5a1b0000-0000-4000-8000-00000000000c';
const UNKNOWN = '5a1b0000-0000-4000-8000-0000000000ff';
const INTERNAL = 'http://digital-identity.dk/constraints/orgunit/1';
const KOMBIT = 'http://sts.kombit.dk/constraints/orgenhed/1';
const KLE = 'http://sts.kombit.dk/constraints/KLE/1';

const KNOWN = new Set([A, B, C]);

function input(over: Partial<ScopeInput> & { roleKey: RoleKey }): ScopeInput {
  return {
    constraints: [],
    knownOrgUnitUuids: KNOWN,
    globalRoles: ['tt-administrator'],
    includeDescendants: true,
    ...over,
  };
}

const ou = (...values: string[]): ScopeConstraint => ({ constraintType: INTERNAL, constraintValues: values });
const scoped = (units: string[], includeDescendants = true): DerivedScope => ({
  kind: 'scoped',
  orgUnitUuids: units,
  includeDescendants,
});
const NONE: DerivedScope = { kind: 'none' };
const GLOBAL: DerivedScope = { kind: 'global' };

const SCOPED_ROLES: RoleKey[] = ['tt-skabelonansvarlig', 'tt-logleser'];

describe('deriveScope: org-unit constraint x situation, for every scoped role', () => {
  const cases: Array<{ label: string; constraints: ScopeConstraint[]; expected: DerivedScope }> = [
    { label: 'no constraint', constraints: [], expected: NONE },
    { label: 'known constraint', constraints: [ou(A)], expected: scoped([A]) },
    { label: 'only unknown constraint units (no scope, never widened)', constraints: [ou(UNKNOWN)], expected: NONE },
    { label: 'known and unknown constraint units (unknown ignored)', constraints: [ou(A, UNKNOWN)], expected: scoped([A]) },
    { label: 'empty constraint values', constraints: [ou()], expected: NONE },
    {
      label: 'only a KLE constraint (not an org-unit scope)',
      constraints: [{ constraintType: KLE, constraintValues: ['27.45.00'] }],
      expected: NONE,
    },
    {
      label: 'KLE constraint values that look like uuids are still not a scope',
      constraints: [{ constraintType: KLE, constraintValues: [A] }],
      expected: NONE,
    },
    {
      label: 'KOMBIT org-unit constraint type',
      constraints: [{ constraintType: KOMBIT, constraintValues: [B] }],
      expected: scoped([B]),
    },
    {
      label: 'two org-unit constraint types are unioned, sorted and de-duplicated',
      constraints: [ou(B, A), { constraintType: KOMBIT, constraintValues: [A] }],
      expected: scoped([A, B]),
    },
    {
      label: 'duplicate role entries concatenated (one constrained, one empty) are unioned',
      constraints: [ou(A), ou()],
      expected: scoped([A]),
    },
    {
      label: 'upper-case and padded uuids are normalised',
      constraints: [ou(`  ${A.toUpperCase()} `)],
      expected: scoped([A]),
    },
  ];

  for (const role of SCOPED_ROLES) {
    for (const c of cases) {
      it(`${role}: ${c.label}`, () => {
        expect(deriveScope(input({ roleKey: role, constraints: c.constraints }))).toEqual(c.expected);
      });
    }
  }
});

describe('deriveScope: GLOBAL_ROLES (the fail-closed switch)', () => {
  it('only tt-administrator is global by default; a scoped role without scope gets no row', () => {
    expect(deriveScope(input({ roleKey: 'tt-logleser' }))).toEqual(NONE);
    expect(deriveScope(input({ roleKey: 'tt-skabelonansvarlig' }))).toEqual(NONE);
  });

  it('an operator can allow tt-logleser (and only it) to be global when it has no scope', () => {
    const globalRoles: RoleKey[] = ['tt-logleser'];
    expect(deriveScope(input({ roleKey: 'tt-logleser', globalRoles }))).toEqual(GLOBAL);
    expect(deriveScope(input({ roleKey: 'tt-skabelonansvarlig', globalRoles }))).toEqual(NONE);
  });

  it('a real scope always beats the global switch', () => {
    expect(deriveScope(input({ roleKey: 'tt-logleser', constraints: [ou(A)], globalRoles: ['tt-logleser'] }))).toEqual(
      scoped([A]),
    );
  });

  it('an assignment that names only unknown units is NOT widened to global, even for a global role', () => {
    expect(deriveScope(input({ roleKey: 'tt-logleser', constraints: [ou(UNKNOWN)], globalRoles: ['tt-logleser'] }))).toEqual(
      NONE,
    );
  });

  it('an empty constraint list (Rollekatalog dropped it) is the case the switch is for', () => {
    expect(deriveScope(input({ roleKey: 'tt-logleser', constraints: [ou()], globalRoles: ['tt-logleser'] }))).toEqual(GLOBAL);
  });

  it('GLOBAL_ROLES=none (empty list): administrator is not global either', () => {
    expect(deriveScope(input({ roleKey: 'tt-administrator', globalRoles: [] }))).toEqual(NONE);
  });
});

describe('deriveScope: unrecognised constraint types fail closed', () => {
  const kle: ScopeConstraint = { constraintType: KLE, constraintValues: ['27.45.00'] };
  const future: ScopeConstraint = { constraintType: 'http://example.test/constraints/future/1', constraintValues: ['x'] };

  it('tt-administrator with only an unknown-type constraint gets no row', () => {
    expect(deriveScope(input({ roleKey: 'tt-administrator', constraints: [kle] }))).toEqual(NONE);
    expect(deriveScope(input({ roleKey: 'tt-administrator', constraints: [future] }))).toEqual(NONE);
    // The schemas hand over only the flag.
    expect(deriveScope(input({ roleKey: 'tt-administrator', hasUnrecognisedConstraints: true }))).toEqual(NONE);
  });

  it('tt-logleser listed in GLOBAL_ROLES with an unknown-type constraint gets no row', () => {
    const globalRoles: RoleKey[] = ['tt-logleser'];
    expect(deriveScope(input({ roleKey: 'tt-logleser', constraints: [kle], globalRoles }))).toEqual(NONE);
    expect(deriveScope(input({ roleKey: 'tt-logleser', hasUnrecognisedConstraints: true, globalRoles }))).toEqual(NONE);
  });

  it('every global-capable role without any constraint at all is global', () => {
    const globalRoles: RoleKey[] = ['tt-administrator', 'tt-logleser', 'tt-skabelonansvarlig'];
    for (const roleKey of globalRoles) {
      expect(deriveScope(input({ roleKey, globalRoles })), roleKey).toEqual(GLOBAL);
      expect(deriveScope(input({ roleKey, globalRoles, hasUnrecognisedConstraints: false })), roleKey).toEqual(GLOBAL);
    }
  });

  it('a blank-valued unknown-type constraint is not a constraint', () => {
    const blank: ScopeConstraint = { constraintType: KLE, constraintValues: ['', '  '] };
    expect(deriveScope(input({ roleKey: 'tt-logleser', constraints: [blank], globalRoles: ['tt-logleser'] }))).toEqual(GLOBAL);
  });

  it('a recognised known org unit still wins over an unknown-type constraint', () => {
    expect(deriveScope(input({ roleKey: 'tt-logleser', constraints: [kle, ou(A)], globalRoles: ['tt-logleser'] }))).toEqual(
      scoped([A]),
    );
    expect(deriveScope(input({ roleKey: 'tt-logleser', constraints: [ou(A)], hasUnrecognisedConstraints: true }))).toEqual(
      scoped([A]),
    );
  });

  it('tt-administrator with an org-unit constraint stays global (constraints are ignored for it)', () => {
    expect(deriveScope(input({ roleKey: 'tt-administrator', constraints: [kle, ou(A)] }))).toEqual(GLOBAL);
  });
});

describe('deriveScope: tt-administrator is never scoped', () => {
  it('constraints are ignored', () => {
    expect(deriveScope(input({ roleKey: 'tt-administrator', constraints: [ou(A, B)] }))).toEqual(GLOBAL);
  });
  it('no constraint is global', () => {
    expect(deriveScope(input({ roleKey: 'tt-administrator' }))).toEqual(GLOBAL);
  });
  it('not in GLOBAL_ROLES means no row, even with a constraint', () => {
    expect(deriveScope(input({ roleKey: 'tt-administrator', constraints: [ou(A)], globalRoles: ['tt-logleser'] }))).toEqual(
      NONE,
    );
  });
});

describe('deriveScope: tt-bruger needs no scope', () => {
  it('always one NULL-scope row, whatever the constraints or GLOBAL_ROLES', () => {
    expect(deriveScope(input({ roleKey: 'tt-bruger' }))).toEqual(GLOBAL);
    expect(deriveScope(input({ roleKey: 'tt-bruger', constraints: [ou(A)], globalRoles: [] }))).toEqual(GLOBAL);
  });
});

describe('deriveScope: descendants flag and purity', () => {
  it('passes ROLLEKATALOG_SCOPE_DESCENDANTS through', () => {
    expect(deriveScope(input({ roleKey: 'tt-logleser', constraints: [ou(A)], includeDescendants: false }))).toEqual(
      scoped([A], false),
    );
  });

  it('does not mutate its input', () => {
    const constraints = [ou(B, A)];
    const snapshot = JSON.stringify(constraints);
    deriveScope(input({ roleKey: 'tt-logleser', constraints }));
    expect(JSON.stringify(constraints)).toBe(snapshot);
  });

  it('covers every role key (a new role must be a conscious decision here)', () => {
    for (const role of ROLE_KEYS) {
      const r = deriveScope(input({ roleKey: role, constraints: [ou(A)] }));
      expect(['none', 'global', 'scoped']).toContain(r.kind);
    }
  });
});
