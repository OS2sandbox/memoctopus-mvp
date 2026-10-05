// All Danish wording for roles, capabilities and sources lives here (no i18n
// system exists). Exhaustive Records: adding a role/capability/source without a
// label is a compile error.
import type { AccessSource } from './config';
import type { Capability, PrincipalSource, RoleKey } from './types';

export const roleLabels: Record<RoleKey, string> = {
  'tt-bruger': 'Bruger',
  'tt-skabelonansvarlig': 'Skabelonansvarlig',
  'tt-logleser': 'Logleser',
  'tt-administrator': 'Administrator',
};

export const roleDescriptions: Record<RoleKey, string> = {
  'tt-bruger': 'Kan bruge løsningen og de skabeloner, der er stillet til rådighed.',
  'tt-skabelonansvarlig':
    'Kan administrere skabeloner og se organisationen for de enheder, rollen er tildelt.',
  'tt-logleser': 'Kan læse og eksportere loggen samt se organisationen.',
  'tt-administrator': 'Har alle rettigheder, herunder styring af brugere, roller og synkronisering.',
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

export const capabilityDescriptions: Record<Capability, string> = {
  'template.use': 'Vælge og bruge skabeloner til referater.',
  'template.manage': 'Oprette og redigere centrale skabeloner for de enheder, rollen gælder for.',
  'audit.read': 'Se hændelser i loggen for de enheder, rollen gælder for.',
  'audit.export': 'Hente loggen som fil.',
  'directory.read': 'Se organisationsenheder, medlemmer og brugere.',
  'access.manage': 'Oprette brugere og organisationsenheder og tildele roller.',
  'sync.run': 'Hente organisation og roller fra Rollekatalog.',
};

export type ScopeKind = 'global' | 'subtree' | 'unit';

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
};

/** Where a resolved principal's rights come from; 'baseline' = implicit Bruger. */
export const principalSourceLabels: Record<PrincipalSource, string> = {
  ...sourceLabels,
  baseline: 'Standardrettighed',
};
