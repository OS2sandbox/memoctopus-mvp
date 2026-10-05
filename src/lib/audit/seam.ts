// Audit seam. Phase 1 call sites (admin writes, authz denials) call these so
// that Phase 2 only has to implement the bodies, not touch every caller.
//
// TODO(phase2): persist to the append-only audit table. `recordAdminAction`
// must insert on the SAME transaction handle it is given, so the audit row
// commits or rolls back together with the change. `recordAuthzDenied` is
// best-effort and must never throw into the request.
//
// Events carry ids and short codes ONLY: never meeting titles, names, prompt
// text or other free text.

/** Opaque transaction handle (a Drizzle tx in practice); typed loosely so this module has no DB import. */
export type AuditTx = unknown;

export type AdminActionType =
  | 'access.role_assign'
  | 'access.role_revoke'
  | 'access.org_unit_create'
  | 'access.org_unit_update'
  | 'access.org_unit_delete'
  | 'access.member_add'
  | 'access.member_remove'
  | 'access.user_create'
  | 'access.user_update'
  | 'access.user_delete'
  | 'access.user_link';

export interface AdminActionEvent {
  type: AdminActionType;
  actorUserId: string;
  entityType: 'role_assignment' | 'org_unit' | 'org_unit_member' | 'directory_user';
  entityId: string;
  secondaryEntityType?: 'directory_user' | 'org_unit';
  secondaryEntityId?: string;
  /** Short codes / ids only, e.g. { roleKey: 'tt-logleser' }. */
  details?: Record<string, string | number | boolean | null>;
}

export interface AuthzDeniedEvent {
  actorUserId: string | null;
  /** Capability or guard that was required, e.g. 'access.manage'. */
  required: string;
  /** Short machine reason, e.g. 'missing_capability' | 'disabled' | 'out_of_scope' | 'wrong_source'. */
  reason: string;
  entityType?: string;
  entityId?: string;
}

export async function recordAdminAction(_tx: AuditTx, _event: AdminActionEvent): Promise<void> {
  // no-op until Phase 2
}

export function recordAuthzDenied(_event: AuthzDeniedEvent): void {
  // no-op until Phase 2
}
