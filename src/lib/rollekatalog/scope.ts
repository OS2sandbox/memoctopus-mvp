// Pure derivation of an assignment's org-unit scope from what Rollekatalog gives us.
// No I/O and no env: the caller (mapper.ts) passes the configuration in, so every
// case is table-testable. The rule that matters is FAIL CLOSED: Rollekatalog
// silently drops a constraint that resolves to empty, so "no scope" must never be
// read as "all units" for a role that is not explicitly allowed to be global.
import type { RoleKey } from '@/lib/authz/types';
import { isOrgUnitConstraintType, type DerivedScope, type ScopeInput } from './types';

const norm = (v: string): string => v.trim().toLowerCase();

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/** Org-unit uuids of the org-unit constraints only (KLE and other types are never a scope). */
function constraintUnits(input: ScopeInput): { all: string[]; known: string[]; unrecognised: boolean } {
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
  const known = unique(all.filter((u) => input.knownOrgUnitUuids.has(u)));
  return { all, known, unrecognised };
}

/**
 * - tt-bruger needs no scope: it yields one NULL-scope row (`global` here only
 *   means "no org unit"; the role grants nothing scoped).
 * - tt-administrator is never scoped (it needs a global assignment): constraints are ignored, and
 *   it is global only when listed in `globalRoles`.
 * - Other roles take their units from the org-unit constraint only. Unit uuids that
 *   are not in the mirror are ignored; when all of them are unknown the assignment
 *   has no scope.
 * - No scope: a role in `globalRoles` becomes global, every other role gets no row.
 *   One exception, stricter than a plain reading of "no scope": an assignment that
 *   DID name org units but none of them is known is not widened to global even for
 *   a global role. Its intended scope is a specific unit we cannot see (e.g. an
 *   inactive unit Rollekatalog does not export).
 * - The same holds for an assignment that carries a non-empty constraint of an
 *   UNRECOGNISED type (KLE, a future type) and yields no org-unit scope: it is
 *   restricted in a way we cannot read, so it is `none` even for a global role (and
 *   for tt-administrator unless an org-unit constraint is present). Only an assignment
 *   with no constraints at all can become global.
 */
export function deriveScope(input: ScopeInput): DerivedScope {
  const role: RoleKey = input.roleKey;
  if (role === 'tt-bruger') return { kind: 'global' };

  const globalAllowed = input.globalRoles.includes(role);
  const c = constraintUnits(input);
  if (role === 'tt-administrator') {
    if (c.unrecognised && c.all.length === 0) return { kind: 'none' };
    return globalAllowed ? { kind: 'global' } : { kind: 'none' };
  }

  const units = c.known;
  const namedUnknownUnitsOnly = units.length === 0 && c.all.length > 0;

  if (units.length > 0) return { kind: 'scoped', orgUnitUuids: units, includeDescendants: input.includeDescendants };
  if (namedUnknownUnitsOnly || c.unrecognised) return { kind: 'none' };
  return globalAllowed ? { kind: 'global' } : { kind: 'none' };
}
