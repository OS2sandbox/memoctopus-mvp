import { scopeKind, scopeLabels } from '@/lib/authz/labels.da';

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
