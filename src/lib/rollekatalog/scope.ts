// Pure derivation of an assignment's org-unit scope from what Rollekatalog gives us.
// No I/O and no env: the caller (mapper.ts) passes the configuration in, so every
// strategy is table-testable. The rule that matters is FAIL CLOSED: Rollekatalog
// silently drops a constraint that resolves to empty, so "no scope" must never be
// read as "all units" for a role that is not explicitly allowed to be global.
import type { RoleKey } from '@/lib/authz/types';
import { isOrgUnitConstraintType, type DerivedScope, type ScopeInput } from './types';

const norm = (v: string): string => v.trim().toLowerCase();

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/** Org-unit uuids of the org-unit constraints only (KLE and other types are never a scope). */
function constraintUnits(input: ScopeInput): { all: string[]; known: string[] } {
  const all: string[] = [];
  for (const c of input.constraints) {
    if (!isOrgUnitConstraintType(c.constraintType)) continue;
    for (const v of c.constraintValues) {
      const n = norm(v);
      if (n) all.push(n);
    }
  }
  const known = unique(all.filter((u) => input.knownOrgUnitUuids.has(u)));
  return { all, known };
}

function managedUnits(input: ScopeInput): string[] {
  return unique(input.managedOrgUnitUuids.map(norm).filter((u) => input.knownOrgUnitUuids.has(u)));
}

/**
 * - tt-bruger needs no scope: it yields one NULL-scope row (`global` here only
 *   means "no org unit"; the role grants nothing scoped).
 * - tt-administrator is never scoped (Phase 1 rule): constraints and managed units
 *   are ignored, and it is global only when listed in `globalRoles`.
 * - Other roles take their units from the strategy. Unit uuids that are not in the
 *   mirror are ignored; when all of them are unknown the assignment has no scope.
 * - No scope: a role in `globalRoles` becomes global, every other role gets no row.
 *   One exception, stricter than a plain reading of "no scope": an assignment that
 *   DID name org units (constraint strategies) but none of them is known is not
 *   widened to global even for a global role. Its intended scope is a specific
 *   unit we cannot see (e.g. an inactive unit Rollekatalog does not export).
 */
export function deriveScope(input: ScopeInput): DerivedScope {
  const role: RoleKey = input.roleKey;
  if (role === 'tt-bruger') return { kind: 'global' };

  const globalAllowed = input.globalRoles.includes(role);
  if (role === 'tt-administrator') return globalAllowed ? { kind: 'global' } : { kind: 'none' };

  let units: string[] = [];
  let namedUnknownUnitsOnly = false;

  if (input.strategy === 'manager') {
    units = managedUnits(input);
  } else {
    const c = constraintUnits(input);
    units = c.known;
    if (units.length === 0 && c.all.length > 0) namedUnknownUnitsOnly = true;
    // The manager fallback is for assignments WITHOUT a constraint. One that named units we
    // cannot see must not be turned into a scope Rollekatalog never assigned.
    if (units.length === 0 && c.all.length === 0 && input.strategy === 'constraint-or-manager') {
      units = managedUnits(input);
    }
  }

  if (units.length > 0) return { kind: 'scoped', orgUnitUuids: units, includeDescendants: input.includeDescendants };
  if (namedUnknownUnitsOnly) return { kind: 'none' };
  return globalAllowed ? { kind: 'global' } : { kind: 'none' };
}
