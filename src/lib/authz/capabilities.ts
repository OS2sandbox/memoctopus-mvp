import {
  CAPABILITIES,
  ROLE_KEYS,
  type Capability,
  type CapabilityScope,
  type Principal,
  type RoleAssignmentRow,
  type RoleKey,
} from './types';

interface RoleDefinition {
  capabilities: Capability[];
  /** May a NULL scope on an assignment of this role mean "everywhere"? */
  globalScopeAllowed: boolean;
}

// The one place the role matrix lives. Exhaustive Record: adding a RoleKey
// without an entry here is a compile error.
export const ROLE_DEFINITIONS: Record<RoleKey, RoleDefinition> = {
  'bruger': {
    capabilities: ['template.use'],
    globalScopeAllowed: false,
  },
  // Global (NULL scope) is the "superuser" who manages every shared prompt, which is
  // what an IdP claim can grant (a claim carries no org unit). Scoped grants (local /
  // Rollekatalog) still work; a NULL scope from a source that cannot be global stays
  // the caller's problem, see dropStaleAssignments and the grant validation.
  'bygger': {
    capabilities: ['template.use', 'template.manage', 'directory.read'],
    globalScopeAllowed: true,
  },
  'admin': {
    capabilities: [...CAPABILITIES],
    globalScopeAllowed: true,
  },
};

export const SCOPED_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  'template.manage',
  'audit.read',
  'directory.read',
]);

// Capabilities that cannot be narrowed to an org unit. They only take effect
// from a GLOBAL assignment: a role granted for one unit must not quietly hand
// out whole-system power (a "unit administrator" could otherwise promote
// themselves to a global one; a unit-scoped grant could export the whole log).
export const GLOBAL_ONLY_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  'audit.export',
  'access.manage',
  'sync.run',
]);

/** Roles whose power is administrative and therefore cannot be given for one unit only. */
export function roleRequiresGlobalScope(role: RoleKey): boolean {
  const caps = ROLE_DEFINITIONS[role].capabilities;
  return caps.includes('access.manage') || caps.includes('sync.run');
}

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
      scopes: {},
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
  // The implicit baseline is global by nature; assignments are global only
  // when NULL-scoped on a role that may be global (fail closed otherwise).
  const grants = active.map((a) => ({
    role: a.roleKey,
    global: a.scopeOrgUnitUuid === null && ROLE_DEFINITIONS[a.roleKey].globalScopeAllowed,
  }));
  if (!requireRoleToLogin) grants.push({ role: 'bruger', global: true });
  for (const { role, global } of grants) {
    for (const cap of ROLE_DEFINITIONS[role].capabilities) {
      if (GLOBAL_ONLY_CAPABILITIES.has(cap) && !global) continue;
      capabilities.add(cap);
    }
  }

  const scopes: Partial<Record<Capability, CapabilityScope>> = {};
  const seenRoots = new Map<Capability, Map<string, boolean>>();

  for (const a of active) {
    const def = ROLE_DEFINITIONS[a.roleKey];
    for (const cap of def.capabilities) {
      if (!SCOPED_CAPABILITIES.has(cap)) continue;
      const scope = (scopes[cap] ??= { global: false, roots: [] });
      if (a.scopeOrgUnitUuid === null) {
        // Fail closed: a NULL scope on a role that is not allowed to be global contributes nothing.
        if (def.globalScopeAllowed) scope.global = true;
        continue;
      }
      let roots = seenRoots.get(cap);
      if (!roots) seenRoots.set(cap, (roots = new Map()));
      // Same unit granted twice: the wider (descendants) grant wins.
      roots.set(a.scopeOrgUnitUuid, (roots.get(a.scopeOrgUnitUuid) ?? false) || a.includeDescendants);
    }
  }
  for (const [cap, roots] of seenRoots) {
    const scope = scopes[cap]!;
    scope.roots = [...roots].map(([orgUnitUuid, includeDescendants]) => ({
      orgUnitUuid,
      includeDescendants,
    }));
  }
  // A capability granted by a role but with no scope contribution keeps an
  // empty scope object, which covers nothing.

  return {
    userId,
    directoryUserUuid,
    roles: ROLE_KEYS.filter((r) => roles.has(r)),
    capabilities: CAPABILITIES.filter((c) => capabilities.has(c)),
    scopes,
    disabled: false,
    source: active.length > 0 ? (input.source ?? 'local') : 'baseline',
  };
}
