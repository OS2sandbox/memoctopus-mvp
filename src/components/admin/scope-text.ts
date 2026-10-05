import { scopeKind, scopeLabels } from '@/lib/authz/labels.da';
import type { CapabilityScope } from '@/lib/authz/types';

/** Wording for one role assignment, e.g. "Børn – Denne enhed og alle underenheder". */
export function describeAssignmentScope(a: {
  scopeOrgUnitUuid: string | null;
  scopeOrgUnitName: string | null;
  includeDescendants: boolean;
}): string {
  const kind = scopeKind(a);
  if (kind === 'global') return scopeLabels.global;
  return `${a.scopeOrgUnitName ?? 'Ukendt enhed'} – ${scopeLabels[kind]}`;
}

/**
 * Wording for the scope of one capability from /api/me. `names` maps org unit
 * ids to names when the viewer may read them; ids are never shown instead.
 */
export function describeCapabilityScope(scope: CapabilityScope | undefined, names: ReadonlyMap<string, string>): string {
  if (!scope) return 'Ingen enheder';
  if (scope.global) return scopeLabels.global;
  if (scope.roots.length === 0) return 'Ingen enheder';
  return scope.roots
    .map((r) => {
      const name = names.get(r.orgUnitUuid) ?? 'Ukendt enhed';
      return `${name} (${r.includeDescendants ? 'inkl. underenheder' : 'kun enheden'})`;
    })
    .join('; ');
}
