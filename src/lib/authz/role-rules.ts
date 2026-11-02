// What a role may do with a scope, derived from the one role matrix so the
// grant form cannot drift from capabilities.ts. Mirrors the server rule in
// access-admin.ts (validateGrantShape), which stays the authority and uses this function.
import { ROLE_DEFINITIONS, SCOPED_CAPABILITIES, roleRequiresGlobalScope } from './capabilities';
import type { RoleKey } from './types';

type ScopeRule = 'forbidden' | 'required' | 'optional';

export function roleScopeRule(role: RoleKey): ScopeRule {
  if (roleRequiresGlobalScope(role)) return 'forbidden';
  const def = ROLE_DEFINITIONS[role];
  const hasScopedCapability = def.capabilities.some((c) => SCOPED_CAPABILITIES.has(c));
  if (!hasScopedCapability) return 'forbidden';
  return def.globalScopeAllowed ? 'optional' : 'required';
}
