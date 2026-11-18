// Pure derivation of whether a Rollekatalog assignment becomes a role row. No role is
// tied to org units any more, so a row is always unscoped; what remains is the rule for
// the administrator role. No I/O and no env: the caller (mapper.ts) passes the
// configuration in, so every case is table-testable.
import { ROLE_DEFINITIONS } from '@/lib/authz/capabilities';
import { isOrgUnitConstraintType, type DerivedScope, type ScopeInput } from './types';

const norm = (v: string): string => v.trim().toLowerCase();

/** Org-unit uuids of the org-unit constraints only (KLE and other types are never a scope). */
function constraintUnits(input: ScopeInput): { all: string[]; unrecognised: boolean } {
  const all: string[] = [];
  // The schemas already drop other types and only leave the flag; also accept them here.
  let unrecognised = input.hasUnrecognisedConstraints === true;
  for (const c of input.constraints) {
    if (!isOrgUnitConstraintType(c.constraintType)) {
      if (c.constraintValues.some((v) => norm(v) !== '')) unrecognised = true;
      continue;
    }
    for (const v of c.constraintValues) {
      const n = norm(v);
      if (n) all.push(n);
    }
  }
  return { all, unrecognised };
}

/**
 * By the role's `scope` in the role matrix (capabilities.ts):
 * - 'none' (bruger, bygger) is not tied to org units: it yields one NULL-scope row
 *   whatever constraints the assignment carries.
 * - 'global-only' (admin) is never scoped: org-unit constraints are ignored, and it
 *   is granted only when listed in `globalRoles`. An assignment that carries a
 *   non-empty constraint of an UNRECOGNISED type (KLE, a future type) and no org-unit
 *   constraint is restricted in a way we cannot read, so it gets no row (fail closed).
 */
export function deriveScope(input: ScopeInput): DerivedScope {
  switch (ROLE_DEFINITIONS[input.roleKey].scope) {
    case 'none':
      return { kind: 'global' };
    case 'global-only': {
      const c = constraintUnits(input);
      if (c.unrecognised && c.all.length === 0) return { kind: 'none' };
      return input.globalRoles.includes(input.roleKey) ? { kind: 'global' } : { kind: 'none' };
    }
  }
}
