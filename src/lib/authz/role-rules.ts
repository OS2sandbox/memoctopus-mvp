// What a role may do with a scope, derived from the one role matrix so the
// grant form cannot drift from capabilities.ts. Mirrors the server rule in
// access-admin.ts (validateGrantShape), which stays the authority and uses this function.
import { ROLE_DEFINITIONS, type RoleScope } from './capabilities';
import type { RoleKey } from './types';

type ScopeRule = 'forbidden' | 'required' | 'optional';

const SCOPE_RULES: Record<RoleScope, ScopeRule> = {
  'none': 'forbidden',
  'optional': 'optional',
  'global-only': 'forbidden',
};

export function roleScopeRule(role: RoleKey): ScopeRule {
  return SCOPE_RULES[ROLE_DEFINITIONS[role].scope];
}
