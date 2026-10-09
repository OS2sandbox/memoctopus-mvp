// Shared contract for central access control. Three user types, matching the OS2ai
// roles: bruger (uses templates), bygger (the superuser who builds and distributes
// central templates) and admin (administration, users/roles and the log).

export const ROLE_KEYS = ['bruger', 'bygger', 'admin'] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

export const CAPABILITIES = [
  'template.use',
  'template.manage',
  'audit.read',
  'audit.export',
  'directory.read',
  'access.manage',
  'sync.run',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface CapabilityScope {
  /** True only when a role that allows global scope was assigned with a NULL org unit. */
  global: boolean;
  roots: Array<{ orgUnitUuid: string; includeDescendants: boolean }>;
}

export type PrincipalSource = 'local' | 'rollekatalog' | 'claims' | 'baseline';

export interface Principal {
  userId: string;
  directoryUserUuid: string | null;
  roles: RoleKey[];
  capabilities: Capability[];
  scopes: Partial<Record<Capability, CapabilityScope>>;
  disabled: boolean;
  source: PrincipalSource;
}

/** One role grant as the pure resolver sees it (DB row, minus ids). */
export interface RoleAssignmentRow {
  /** Deliberately a string: rows from the DB may hold keys we no longer know. */
  roleKey: string;
  scopeOrgUnitUuid: string | null;
  includeDescendants: boolean;
  startDate?: Date | null;
  stopDate?: Date | null;
}
