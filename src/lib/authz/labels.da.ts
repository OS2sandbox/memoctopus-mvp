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
  'bygger': 'Kan oprette centrale skabeloner, gøre dem tilgængelige for enheder og ændre de skabeloner, personen selv har oprettet.',
  'admin': 'Har alle rettigheder: alle centrale skabeloner, styring af brugere, roller og synkronisering samt log og eksport.',
};

export const capabilityLabels: Record<Capability, string> = {
  'template.use': 'Bruge skabeloner',
  'template.manage': 'Administrere egne centrale skabeloner',
  'template.manage_all': 'Administrere alle centrale skabeloner',
  'audit.read': 'Læse loggen',
  'audit.export': 'Eksportere loggen',
  'access.manage': 'Administrere brugere og roller',
  'sync.run': 'Starte synkronisering',
};

/** Where a role assignment row comes from. */
export const sourceLabels: Record<AccessSource, string> = {
  local: 'Lokal',
  rollekatalog: 'Rollekatalog',
  claims: 'Identitetsudbyder',
};
