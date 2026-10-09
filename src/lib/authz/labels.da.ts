// All Danish wording for roles, capabilities and sources lives here (no i18n
// system exists). Exhaustive Records: adding a role/capability/source without a
// label is a compile error.
import type { AccessSource } from './config';
import type { Capability, RoleKey } from './types';

export const roleLabels: Record<RoleKey, string> = {
  'bruger': 'Bruger',
  'bygger': 'Bygger',
  'admin': 'Admin',
};

export const roleDescriptions: Record<RoleKey, string> = {
  'bruger': 'Kan bruge løsningen og de skabeloner, der er stillet til rådighed.',
  'bygger':
    'Superbruger: kan oprette og udbrede centrale skabeloner og se organisationen for de enheder, rollen er tildelt. Uden enhed (fx fra login) gælder den hele organisationen.',
  'admin': 'Har alle rettigheder: administration, styring af brugere, roller og synkronisering samt log og eksport.',
};

export const capabilityLabels: Record<Capability, string> = {
  'template.use': 'Bruge skabeloner',
  'template.manage': 'Administrere skabeloner',
  'audit.read': 'Læse loggen',
  'audit.export': 'Eksportere loggen',
  'directory.read': 'Se organisationen',
  'access.manage': 'Administrere brugere og roller',
  'sync.run': 'Starte synkronisering',
};

type ScopeKind = 'global' | 'subtree' | 'unit';

export const scopeLabels: Record<ScopeKind, string> = {
  global: 'Hele organisationen',
  subtree: 'Denne enhed og alle underenheder',
  unit: 'Kun denne enhed',
};

export function scopeKind(scope: {
  scopeOrgUnitUuid: string | null;
  includeDescendants: boolean;
}): ScopeKind {
  if (scope.scopeOrgUnitUuid === null) return 'global';
  return scope.includeDescendants ? 'subtree' : 'unit';
}

/** Where a role assignment row comes from. */
export const sourceLabels: Record<AccessSource, string> = {
  local: 'Lokal',
  rollekatalog: 'Rollekatalog',
  claims: 'Identitetsudbyder',
};
