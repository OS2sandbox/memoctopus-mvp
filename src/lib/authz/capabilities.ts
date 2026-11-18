import {
  CAPABILITIES,
  ROLE_KEYS,
  type Capability,
  type Principal,
  type RoleAssignmentRow,
  type RoleKey,
} from './types';

/**
 * The one rule for how an assignment of a role relates to org units. No role is tied to org units:
 *  - 'none': the role takes no unit; a NULL scope is its normal grant.
 *  - 'global-only': administrative power that is never given for one unit (an assignment that names
 *    one, from an older version, grants none of the GLOBAL_ONLY capabilities).
 */
export type RoleScope = 'none' | 'global-only';

interface RoleDefinition {
  capabilities: Capability[];
  scope: RoleScope;
}

// The one place the role matrix lives. Exhaustive Record: adding a RoleKey
// without an entry here is a compile error.
export const ROLE_DEFINITIONS: Record<RoleKey, RoleDefinition> = {
  'bruger': {
    capabilities: ['template.use'],
    scope: 'none',
  },
  // Creates central templates, shares them with any unit (or role/group) and manages the
  // ones they created themselves (src/lib/skabeloner/central.ts). Not tied to org units.
  'bygger': {
    capabilities: ['template.use', 'template.manage'],
    scope: 'none',
  },
  'admin': {
    capabilities: [...CAPABILITIES],
    scope: 'global-only',
  },
};

// Capabilities that cannot be narrowed to an org unit. They only take effect
// from a GLOBAL assignment: a role granted for one unit must not quietly hand
// out whole-system power (a "unit administrator" could otherwise promote
// themselves to a global one; a unit-scoped grant could read or export the whole log).
export const GLOBAL_ONLY_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  'template.manage_all',
  'audit.read',
  'audit.export',
  'access.manage',
  'sync.run',
]);

export function isRoleKey(value: string): value is RoleKey {
  return (ROLE_KEYS as readonly string[]).includes(value);
}

interface BuildPrincipalInput {
  userId: string;
  directoryUserUuid: string | null;
  disabled: boolean;
  assignments: RoleAssignmentRow[];
  now: Date;
  requireRoleToLogin: boolean;
  /** Where the assignments came from; defaults to 'baseline' when there are none. */
  source?: 'local' | 'rollekatalog' | 'claims';
}

function isActive(a: RoleAssignmentRow, now: Date): boolean {
  // [startDate, stopDate): a grant that stops "now" is already over.
  if (a.startDate && a.startDate.getTime() > now.getTime()) return false;
  if (a.stopDate && a.stopDate.getTime() <= now.getTime()) return false;
  return true;
}

/**
 * Pure resolver: assignment rows in, Principal out. No DB, no clock, no env,
 * so the whole authorisation matrix is unit-testable.
 */
export function buildPrincipalFromAssignments(input: BuildPrincipalInput): Principal {
  const { userId, directoryUserUuid, disabled, assignments, now, requireRoleToLogin } = input;

  if (disabled) {
    return {
      userId,
      directoryUserUuid,
      roles: [],
      capabilities: [],
      disabled: true,
      source: input.source ?? 'baseline',
    };
  }

  const active = assignments.filter(
    (a): a is RoleAssignmentRow & { roleKey: RoleKey } => isRoleKey(a.roleKey) && isActive(a, now),
  );

  const roles = new Set<RoleKey>(active.map((a) => a.roleKey));
  if (!requireRoleToLogin) roles.add('bruger');

  const capabilities = new Set<Capability>();
  // The implicit baseline is global by nature; an assignment is global when NULL-scoped
  // (a unit-scoped one never hands out a GLOBAL_ONLY capability).
  const grants = active.map((a) => ({
    role: a.roleKey,
    global: a.scopeOrgUnitUuid === null,
  }));
  if (!requireRoleToLogin) grants.push({ role: 'bruger', global: true });
  for (const { role, global } of grants) {
    for (const cap of ROLE_DEFINITIONS[role].capabilities) {
      if (GLOBAL_ONLY_CAPABILITIES.has(cap) && !global) continue;
      capabilities.add(cap);
    }
  }

  return {
    userId,
    directoryUserUuid,
    roles: ROLE_KEYS.filter((r) => roles.has(r)),
    capabilities: CAPABILITIES.filter((c) => capabilities.has(c)),
    disabled: false,
    source: active.length > 0 ? (input.source ?? 'local') : 'baseline',
  };
}
