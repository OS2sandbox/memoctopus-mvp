// Pure predicates over an already-resolved Principal. No DB, no env, no async.
// Everything fails closed, and a disabled principal is denied regardless of
// what its capability list says. Scope-aware checks live in scope.ts.
import { capabilityLabels, roleLabels } from './labels.da';
import { ROLE_DEFINITIONS } from './capabilities';
import { ROLE_KEYS, type Capability, type Principal } from './types';

export function hasCapability(p: Principal, cap: Capability): boolean {
  return !p.disabled && p.capabilities.includes(cap);
}

export function hasAnyCapability(p: Principal, caps: readonly Capability[]): boolean {
  return caps.some((c) => hasCapability(p, c));
}

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
