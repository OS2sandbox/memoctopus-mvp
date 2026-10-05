import { describe, expect, it } from 'vitest';
import { ROLE_KEYS, type RoleKey } from '@/lib/authz/types';
import { deriveScope } from './scope';
import type { DerivedScope, ScopeConstraint, ScopeInput, ScopeStrategy } from './types';

const A = '5a1b0000-0000-4000-8000-00000000000a';
const B = '5a1b0000-0000-4000-8000-00000000000b';
const M = '5a1b0000-0000-4000-8000-00000000000c';
const UNKNOWN = '5a1b0000-0000-4000-8000-0000000000ff';
const INTERNAL = 'http://digital-identity.dk/constraints/orgunit/1';
const KOMBIT = 'http://sts.kombit.dk/constraints/orgenhed/1';
const KLE = 'http://sts.kombit.dk/constraints/KLE/1';

const KNOWN = new Set([A, B, M]);

function input(over: Partial<ScopeInput> & { roleKey: RoleKey; strategy: ScopeStrategy }): ScopeInput {
  return {
    constraints: [],
    knownOrgUnitUuids: KNOWN,
    managedOrgUnitUuids: [],
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
const STRATEGIES: ScopeStrategy[] = ['constraint', 'constraint-or-manager', 'manager'];

describe('deriveScope: strategy x situation, for every scoped role', () => {
  // [label, constraints, managed, expected per strategy]
  const cases: Array<{
    label: string;
    constraints: ScopeConstraint[];
    managed: string[];
    expected: Record<ScopeStrategy, DerivedScope>;
  }> = [
    {
      label: 'no constraint, not a manager',
      constraints: [],
      managed: [],
      expected: { constraint: NONE, 'constraint-or-manager': NONE, manager: NONE },
    },
    {
      label: 'known constraint, not a manager',
      constraints: [ou(A)],
      managed: [],
      expected: { constraint: scoped([A]), 'constraint-or-manager': scoped([A]), manager: NONE },
    },
    {
      label: 'no constraint, manages a unit',
      constraints: [],
      managed: [M],
      expected: { constraint: NONE, 'constraint-or-manager': scoped([M]), manager: scoped([M]) },
    },
    {
      label: 'known constraint AND manages a unit (constraint wins unless strategy is manager)',
      constraints: [ou(A)],
      managed: [M],
      expected: { constraint: scoped([A]), 'constraint-or-manager': scoped([A]), manager: scoped([M]) },
    },
    {
      label: 'only unknown constraint units, not a manager (no scope, never widened)',
      constraints: [ou(UNKNOWN)],
      managed: [],
      expected: { constraint: NONE, 'constraint-or-manager': NONE, manager: NONE },
    },
    {
      label: 'only unknown constraint units, manages a unit (the fallback never replaces a named but invisible unit; manager ignores constraints)',
      constraints: [ou(UNKNOWN)],
      managed: [M],
      expected: { constraint: NONE, 'constraint-or-manager': NONE, manager: scoped([M]) },
    },
    {
      label: 'known and unknown constraint units (unknown ignored)',
      constraints: [ou(A, UNKNOWN)],
      managed: [],
      expected: { constraint: scoped([A]), 'constraint-or-manager': scoped([A]), manager: NONE },
    },
    {
      label: 'empty constraint values',
      constraints: [ou()],
      managed: [],
      expected: { constraint: NONE, 'constraint-or-manager': NONE, manager: NONE },
    },
    {
      label: 'empty constraint values, manages a unit',
      constraints: [ou()],
      managed: [M],
      expected: { constraint: NONE, 'constraint-or-manager': scoped([M]), manager: scoped([M]) },
    },
    {
      label: 'only a KLE constraint (not an org-unit scope), not a manager',
      constraints: [{ constraintType: KLE, constraintValues: ['27.45.00'] }],
      managed: [],
      expected: { constraint: NONE, 'constraint-or-manager': NONE, manager: NONE },
    },
    {
      label: 'KLE constraint values that look like uuids are still not a scope',
      constraints: [{ constraintType: KLE, constraintValues: [A] }],
      managed: [],
      expected: { constraint: NONE, 'constraint-or-manager': NONE, manager: NONE },
    },
    {
      label: 'KOMBIT org-unit constraint type',
      constraints: [{ constraintType: KOMBIT, constraintValues: [B] }],
      managed: [],
      expected: { constraint: scoped([B]), 'constraint-or-manager': scoped([B]), manager: NONE },
    },
    {
      label: 'two org-unit constraint types are unioned, sorted and de-duplicated',
      constraints: [ou(B, A), { constraintType: KOMBIT, constraintValues: [A] }],
      managed: [],
      expected: { constraint: scoped([A, B]), 'constraint-or-manager': scoped([A, B]), manager: NONE },
    },
    {
      label: 'duplicate role entries concatenated (one constrained, one empty) are unioned',
      constraints: [ou(A), ou()],
      managed: [],
      expected: { constraint: scoped([A]), 'constraint-or-manager': scoped([A]), manager: NONE },
    },
    {
      label: 'managed units: unknown and duplicate ones are dropped',
      constraints: [],
      managed: [M, M, UNKNOWN, A],
      expected: { constraint: NONE, 'constraint-or-manager': scoped([A, M]), manager: scoped([A, M]) },
    },
    {
      label: 'only unknown managed units',
      constraints: [],
      managed: [UNKNOWN],
      expected: { constraint: NONE, 'constraint-or-manager': NONE, manager: NONE },
    },
    {
      label: 'upper-case and padded uuids are normalised',
      constraints: [ou(`  ${A.toUpperCase()} `)],
      managed: [],
      expected: { constraint: scoped([A]), 'constraint-or-manager': scoped([A]), manager: NONE },
    },
  ];

  for (const role of SCOPED_ROLES) {
    for (const strategy of STRATEGIES) {
      for (const c of cases) {
        it(`${role} / ${strategy}: ${c.label}`, () => {
          expect(
            deriveScope(input({ roleKey: role, strategy, constraints: c.constraints, managedOrgUnitUuids: c.managed })),
          ).toEqual(c.expected[strategy]);
        });
      }
    }
  }
});

describe('deriveScope: GLOBAL_ROLES (the fail-closed switch)', () => {
  it('only tt-administrator is global by default; a scoped role without scope gets no row', () => {
    for (const strategy of STRATEGIES) {
      expect(deriveScope(input({ roleKey: 'tt-logleser', strategy }))).toEqual(NONE);
      expect(deriveScope(input({ roleKey: 'tt-skabelonansvarlig', strategy }))).toEqual(NONE);
    }
  });

  it('an operator can allow tt-logleser (and only it) to be global when it has no scope', () => {
    for (const strategy of STRATEGIES) {
      const globalRoles: RoleKey[] = ['tt-logleser'];
      expect(deriveScope(input({ roleKey: 'tt-logleser', strategy, globalRoles }))).toEqual(GLOBAL);
      expect(deriveScope(input({ roleKey: 'tt-skabelonansvarlig', strategy, globalRoles }))).toEqual(NONE);
    }
  });

  it('a real scope always beats the global switch', () => {
    expect(
      deriveScope(input({ roleKey: 'tt-logleser', strategy: 'constraint', constraints: [ou(A)], globalRoles: ['tt-logleser'] })),
    ).toEqual(scoped([A]));
  });

  it('an assignment that names only unknown units is NOT widened to global, even for a global role', () => {
    for (const strategy of ['constraint', 'constraint-or-manager'] as const) {
      expect(
        deriveScope(
          input({ roleKey: 'tt-logleser', strategy, constraints: [ou(UNKNOWN)], globalRoles: ['tt-logleser'] }),
        ),
      ).toEqual(NONE);
    }
  });

  it('an empty constraint list (Rollekatalog dropped it) is the case the switch is for', () => {
    expect(
      deriveScope(input({ roleKey: 'tt-logleser', strategy: 'constraint', constraints: [ou()], globalRoles: ['tt-logleser'] })),
    ).toEqual(GLOBAL);
  });

  it('GLOBAL_ROLES=none (empty list): administrator is not global either', () => {
    for (const strategy of STRATEGIES) {
      expect(deriveScope(input({ roleKey: 'tt-administrator', strategy, globalRoles: [] }))).toEqual(NONE);
    }
  });
});

describe('deriveScope: tt-administrator is never scoped', () => {
  for (const strategy of STRATEGIES) {
    it(`${strategy}: constraints and managed units are ignored`, () => {
      expect(
        deriveScope(
          input({ roleKey: 'tt-administrator', strategy, constraints: [ou(A, B)], managedOrgUnitUuids: [M] }),
        ),
      ).toEqual(GLOBAL);
    });
    it(`${strategy}: no constraint is global`, () => {
      expect(deriveScope(input({ roleKey: 'tt-administrator', strategy }))).toEqual(GLOBAL);
    });
    it(`${strategy}: not in GLOBAL_ROLES means no row, even with a constraint`, () => {
      expect(
        deriveScope(input({ roleKey: 'tt-administrator', strategy, constraints: [ou(A)], globalRoles: ['tt-logleser'] })),
      ).toEqual(NONE);
    });
  }
});

describe('deriveScope: tt-bruger needs no scope', () => {
  for (const strategy of STRATEGIES) {
    it(`${strategy}: always one NULL-scope row, whatever the constraints or GLOBAL_ROLES`, () => {
      expect(deriveScope(input({ roleKey: 'tt-bruger', strategy }))).toEqual(GLOBAL);
      expect(
        deriveScope(input({ roleKey: 'tt-bruger', strategy, constraints: [ou(A)], managedOrgUnitUuids: [M], globalRoles: [] })),
      ).toEqual(GLOBAL);
    });
  }
});

describe('deriveScope: descendants flag and purity', () => {
  it('passes ROLLEKATALOG_SCOPE_DESCENDANTS through', () => {
    expect(
      deriveScope(input({ roleKey: 'tt-logleser', strategy: 'constraint', constraints: [ou(A)], includeDescendants: false })),
    ).toEqual(scoped([A], false));
    expect(
      deriveScope(input({ roleKey: 'tt-logleser', strategy: 'manager', managedOrgUnitUuids: [M], includeDescendants: false })),
    ).toEqual(scoped([M], false));
  });

  it('does not mutate its input', () => {
    const constraints = [ou(B, A)];
    const managed = [M, A];
    const snapshot = JSON.stringify({ constraints, managed });
    deriveScope(input({ roleKey: 'tt-logleser', strategy: 'constraint-or-manager', constraints, managedOrgUnitUuids: managed }));
    expect(JSON.stringify({ constraints, managed })).toBe(snapshot);
  });

  it('covers every role key (a new role must be a conscious decision here)', () => {
    for (const role of ROLE_KEYS) {
      const r = deriveScope(input({ roleKey: role, strategy: 'constraint', constraints: [ou(A)] }));
      expect(['none', 'global', 'scoped']).toContain(r.kind);
    }
  });
});
