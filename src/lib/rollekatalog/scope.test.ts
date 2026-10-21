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
    globalRoles: ['admin'],
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

// admin is never scoped (its own block below); bygger is the only role an org unit can narrow.
const SCOPED_ROLES: RoleKey[] = ['bygger'];

describe('deriveScope: org-unit constraint x situation, for the scoped role', () => {
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
  it('only admin is global by default; bygger without scope gets no row', () => {
    expect(deriveScope(input({ roleKey: 'admin' }))).toEqual(GLOBAL);
    expect(deriveScope(input({ roleKey: 'bygger' }))).toEqual(NONE);
  });

  it('an operator can allow bygger to be global when it has no scope (and then only the listed roles are)', () => {
    const globalRoles: RoleKey[] = ['bygger'];
    expect(deriveScope(input({ roleKey: 'bygger', globalRoles }))).toEqual(GLOBAL);
    expect(deriveScope(input({ roleKey: 'admin', globalRoles }))).toEqual(NONE);
  });

  it('a real scope always beats the global switch', () => {
    expect(deriveScope(input({ roleKey: 'bygger', constraints: [ou(A)], globalRoles: ['bygger'] }))).toEqual(
      scoped([A]),
    );
  });

  it('an assignment that names only unknown units is NOT widened to global, even for a global role', () => {
    expect(deriveScope(input({ roleKey: 'bygger', constraints: [ou(UNKNOWN)], globalRoles: ['bygger'] }))).toEqual(
      NONE,
    );
  });

  it('an empty constraint list (Rollekatalog dropped it) is the case the switch is for', () => {
    expect(deriveScope(input({ roleKey: 'bygger', constraints: [ou()], globalRoles: ['bygger'] }))).toEqual(GLOBAL);
  });

  it('GLOBAL_ROLES=none (empty list): neither admin nor bygger is global', () => {
    expect(deriveScope(input({ roleKey: 'admin', globalRoles: [] }))).toEqual(NONE);
    expect(deriveScope(input({ roleKey: 'bygger', globalRoles: [] }))).toEqual(NONE);
  });
});

describe('deriveScope: unrecognised constraint types fail closed', () => {
  const kle: ScopeConstraint = { constraintType: KLE, constraintValues: ['27.45.00'] };
  const future: ScopeConstraint = { constraintType: 'http://example.test/constraints/future/1', constraintValues: ['x'] };

  it('admin with only an unknown-type constraint gets no row', () => {
    expect(deriveScope(input({ roleKey: 'admin', constraints: [kle] }))).toEqual(NONE);
    expect(deriveScope(input({ roleKey: 'admin', constraints: [future] }))).toEqual(NONE);
    // The schemas hand over only the flag.
    expect(deriveScope(input({ roleKey: 'admin', hasUnrecognisedConstraints: true }))).toEqual(NONE);
  });

  it('bygger listed in GLOBAL_ROLES with an unknown-type constraint gets no row', () => {
    const globalRoles: RoleKey[] = ['bygger'];
    expect(deriveScope(input({ roleKey: 'bygger', constraints: [kle], globalRoles }))).toEqual(NONE);
    expect(deriveScope(input({ roleKey: 'bygger', hasUnrecognisedConstraints: true, globalRoles }))).toEqual(NONE);
  });

  it('every global-capable role without any constraint at all is global', () => {
    const globalRoles: RoleKey[] = ['admin', 'bygger'];
    for (const roleKey of globalRoles) {
      expect(deriveScope(input({ roleKey, globalRoles })), roleKey).toEqual(GLOBAL);
      expect(deriveScope(input({ roleKey, globalRoles, hasUnrecognisedConstraints: false })), roleKey).toEqual(GLOBAL);
    }
  });

  it('a blank-valued unknown-type constraint is not a constraint', () => {
    const blank: ScopeConstraint = { constraintType: KLE, constraintValues: ['', '  '] };
    expect(deriveScope(input({ roleKey: 'bygger', constraints: [blank], globalRoles: ['bygger'] }))).toEqual(GLOBAL);
  });

  it('a recognised known org unit still wins over an unknown-type constraint', () => {
    expect(deriveScope(input({ roleKey: 'bygger', constraints: [kle, ou(A)], globalRoles: ['bygger'] }))).toEqual(
      scoped([A]),
    );
    expect(deriveScope(input({ roleKey: 'bygger', constraints: [ou(A)], hasUnrecognisedConstraints: true }))).toEqual(
      scoped([A]),
    );
  });

  it('admin with an org-unit constraint stays global (constraints are ignored for it)', () => {
    expect(deriveScope(input({ roleKey: 'admin', constraints: [kle, ou(A)] }))).toEqual(GLOBAL);
  });
});

describe('deriveScope: admin is never scoped', () => {
  it('constraints are ignored', () => {
    expect(deriveScope(input({ roleKey: 'admin', constraints: [ou(A, B)] }))).toEqual(GLOBAL);
  });
  it('no constraint is global', () => {
    expect(deriveScope(input({ roleKey: 'admin' }))).toEqual(GLOBAL);
  });
  it('not in GLOBAL_ROLES means no row, even with a constraint', () => {
    expect(deriveScope(input({ roleKey: 'admin', constraints: [ou(A)], globalRoles: ['bygger'] }))).toEqual(NONE);
  });
});

describe('deriveScope: bruger needs no scope', () => {
  it('always one NULL-scope row, whatever the constraints or GLOBAL_ROLES', () => {
    expect(deriveScope(input({ roleKey: 'bruger' }))).toEqual(GLOBAL);
    expect(deriveScope(input({ roleKey: 'bruger', constraints: [ou(A)], globalRoles: [] }))).toEqual(GLOBAL);
  });
});

describe('deriveScope: descendants flag and purity', () => {
  it('passes ROLLEKATALOG_SCOPE_DESCENDANTS through', () => {
    expect(deriveScope(input({ roleKey: 'bygger', constraints: [ou(A)], includeDescendants: false }))).toEqual(
      scoped([A], false),
    );
  });

  it('does not mutate its input', () => {
    const constraints = [ou(B, A)];
    const snapshot = JSON.stringify(constraints);
    deriveScope(input({ roleKey: 'bygger', constraints }));
    expect(JSON.stringify(constraints)).toBe(snapshot);
  });

  it('covers every role key (a new role must be a conscious decision here)', () => {
    for (const role of ROLE_KEYS) {
      const r = deriveScope(input({ roleKey: role, constraints: [ou(A)] }));
      expect(['none', 'global', 'scoped']).toContain(r.kind);
    }
  });
});
