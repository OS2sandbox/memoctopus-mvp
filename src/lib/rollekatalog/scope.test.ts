import { describe, expect, it } from 'vitest';
import { ROLE_KEYS, type RoleKey } from '@/lib/authz/types';
import { deriveScope } from './scope';
import type { DerivedScope, ScopeConstraint, ScopeInput } from './types';

const A = '5a1b0000-0000-4000-8000-00000000000a';
const B = '5a1b0000-0000-4000-8000-00000000000b';
const UNKNOWN = '5a1b0000-0000-4000-8000-0000000000ff';
const INTERNAL = 'http://digital-identity.dk/constraints/orgunit/1';
const KOMBIT = 'http://sts.kombit.dk/constraints/orgenhed/1';
const KLE = 'http://sts.kombit.dk/constraints/KLE/1';

function input(over: Partial<ScopeInput> & { roleKey: RoleKey }): ScopeInput {
  return { constraints: [], globalRoles: ['admin'], ...over };
}

const ou = (...values: string[]): ScopeConstraint => ({ constraintType: INTERNAL, constraintValues: values });
const kle: ScopeConstraint = { constraintType: KLE, constraintValues: ['27.45.00'] };
const future: ScopeConstraint = { constraintType: 'http://example.test/constraints/future/1', constraintValues: ['x'] };
const NONE: DerivedScope = { kind: 'none' };
const GLOBAL: DerivedScope = { kind: 'global' };

describe('deriveScope: bruger and bygger are not tied to org units', () => {
  const cases: Array<{ label: string; constraints: ScopeConstraint[]; flag?: boolean }> = [
    { label: 'no constraint', constraints: [] },
    { label: 'a known org-unit constraint', constraints: [ou(A)] },
    { label: 'an unknown org unit', constraints: [ou(UNKNOWN)] },
    { label: 'two org-unit constraint types', constraints: [ou(B, A), { constraintType: KOMBIT, constraintValues: [A] }] },
    { label: 'an empty constraint', constraints: [ou()] },
    { label: 'a KLE constraint', constraints: [kle] },
    { label: 'an unrecognised constraint type', constraints: [future] },
    { label: 'the unrecognised-constraint flag from the schemas', constraints: [], flag: true },
  ];

  for (const role of ['bruger', 'bygger'] as const) {
    for (const c of cases) {
      it(`${role}: ${c.label} gives one NULL-scope row`, () => {
        expect(
          deriveScope(input({ roleKey: role, constraints: c.constraints, hasUnrecognisedConstraints: c.flag })),
        ).toEqual(GLOBAL);
      });
    }
  }

  it('GLOBAL_ROLES does not matter for them', () => {
    expect(deriveScope(input({ roleKey: 'bygger', globalRoles: [] }))).toEqual(GLOBAL);
    expect(deriveScope(input({ roleKey: 'bruger', constraints: [ou(A)], globalRoles: [] }))).toEqual(GLOBAL);
  });
});

describe('deriveScope: admin is never scoped, and needs GLOBAL_ROLES', () => {
  it('no constraint is global', () => {
    expect(deriveScope(input({ roleKey: 'admin' }))).toEqual(GLOBAL);
  });

  it('org-unit constraints are ignored', () => {
    expect(deriveScope(input({ roleKey: 'admin', constraints: [ou(A, B)] }))).toEqual(GLOBAL);
    expect(deriveScope(input({ roleKey: 'admin', constraints: [kle, ou(A)] }))).toEqual(GLOBAL);
  });

  it('not in GLOBAL_ROLES means no row, with or without a constraint', () => {
    expect(deriveScope(input({ roleKey: 'admin', globalRoles: [] }))).toEqual(NONE);
    expect(deriveScope(input({ roleKey: 'admin', constraints: [ou(A)], globalRoles: ['bygger'] }))).toEqual(NONE);
  });

  it('only an unrecognised-type constraint fails closed: no row', () => {
    expect(deriveScope(input({ roleKey: 'admin', constraints: [kle] }))).toEqual(NONE);
    expect(deriveScope(input({ roleKey: 'admin', constraints: [future] }))).toEqual(NONE);
    expect(deriveScope(input({ roleKey: 'admin', hasUnrecognisedConstraints: true }))).toEqual(NONE);
  });

  it('a blank-valued unknown-type constraint is not a constraint', () => {
    const blank: ScopeConstraint = { constraintType: KLE, constraintValues: ['', '  '] };
    expect(deriveScope(input({ roleKey: 'admin', constraints: [blank] }))).toEqual(GLOBAL);
  });
});

describe('deriveScope: purity and coverage', () => {
  it('does not mutate its input', () => {
    const constraints = [ou(B, A)];
    const snapshot = JSON.stringify(constraints);
    deriveScope(input({ roleKey: 'admin', constraints }));
    expect(JSON.stringify(constraints)).toBe(snapshot);
  });

  it('covers every role key (a new role must be a conscious decision here)', () => {
    for (const role of ROLE_KEYS) {
      expect(['none', 'global']).toContain(deriveScope(input({ roleKey: role, constraints: [ou(A)] })).kind);
    }
  });
});
