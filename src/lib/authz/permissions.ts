// Pure predicates over an already-resolved Principal. No DB, no env, no async:
// scope-aware checks take the covered org unit uuids, which the caller computes
// (scope.ts) once per request. Everything fails closed, and a disabled
// principal is denied regardless of what its capability list says.
import { capabilityLabels, roleLabels } from './labels.da';
import { ROLE_DEFINITIONS } from './capabilities';
import { ROLE_KEYS, type Capability, type Principal } from './types';

export type CoveredUnits = ReadonlySet<string> | readonly string[];

function contains(units: CoveredUnits, uuid: string): boolean {
  return Array.isArray(units) ? units.includes(uuid) : (units as ReadonlySet<string>).has(uuid);
}

export function hasCapability(p: Principal, cap: Capability): boolean {
  return !p.disabled && p.capabilities.includes(cap);
}

export function hasAnyCapability(p: Principal, caps: readonly Capability[]): boolean {
  return caps.some((c) => hasCapability(p, c));
}

export const canUseTemplates = (p: Principal) => hasCapability(p, 'template.use');
export const canManageAccess = (p: Principal) => hasCapability(p, 'access.manage');
export const canReadDirectory = (p: Principal) => hasCapability(p, 'directory.read');
export const canRunSync = (p: Principal) => hasCapability(p, 'sync.run');
export const canExportAudit = (p: Principal) => hasCapability(p, 'audit.export');

/** Does the principal hold `cap` with global scope (not just for some units)? */
export function hasGlobalScope(p: Principal, cap: Capability): boolean {
  return hasCapability(p, cap) && p.scopes[cap]?.global === true;
}

/**
 * Scoped check for one unit. `unitUuid` null means "not owned by any unit"
 * (e.g. an organisation-wide item), which only a global scope can reach.
 */
export function capabilityCoversUnit(
  p: Principal,
  cap: Capability,
  unitUuid: string | null,
  coveredUnits: CoveredUnits,
): boolean {
  if (!hasCapability(p, cap)) return false;
  if (p.scopes[cap]?.global === true) return true;
  if (unitUuid === null) return false;
  return contains(coveredUnits, unitUuid);
}

export const canManageTemplateInUnits = (
  p: Principal,
  ownerUnitUuid: string | null,
  coveredUnits: CoveredUnits,
) => capabilityCoversUnit(p, 'template.manage', ownerUnitUuid, coveredUnits);

export const canReadAuditForUnit = (
  p: Principal,
  actorUnitUuid: string | null,
  coveredUnits: CoveredUnits,
) => capabilityCoversUnit(p, 'audit.read', actorUnitUuid, coveredUnits);

export const canReadDirectoryUnit = (
  p: Principal,
  unitUuid: string | null,
  coveredUnits: CoveredUnits,
) => capabilityCoversUnit(p, 'directory.read', unitUuid, coveredUnits);

function grantingRoles(cap: Capability): string[] {
  return ROLE_KEYS.filter((r) => ROLE_DEFINITIONS[r].capabilities.includes(cap)).map(
    (r) => roleLabels[r],
  );
}

/**
 * Short Danish reason why `cap` is denied, or null when it is granted. Meant
 * for UI/API responses, so it names the right and the roles that give it but
 * nothing about other users or data.
 */
export function explainDenial(p: Principal, cap: Capability): string | null {
  if (p.disabled) return 'Kontoen er deaktiveret';
  if (hasCapability(p, cap)) return null;
  const roles = grantingRoles(cap);
  const hint = roles.length > 0 ? ` Rettigheden gives af: ${roles.join(', ')}.` : '';
  return `Du har ikke rettigheden »${capabilityLabels[cap]}«.${hint}`;
}

/** Reason for a scoped denial: the right exists, but not for this unit. */
export function explainScopeDenial(p: Principal, cap: Capability): string | null {
  const base = explainDenial(p, cap);
  if (base !== null) return base;
  return `Din rettighed »${capabilityLabels[cap]}« gælder ikke for denne enhed.`;
}
