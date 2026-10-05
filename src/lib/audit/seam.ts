// Stable public seam for the Phase 1 call sites (admin writes, authz denials).
// It maps their small event shapes onto the audit catalogue and delegates to
// record.ts, so those callers did not change when the audit log was implemented.
// New code that needs more than these two (templates, AI calls, bot, ...) calls
// recordEvent / recordServerEvent from './record' directly.
//
// Events carry ids and short codes ONLY: never meeting titles, names, prompt
// text or other free text. The catalogue enforces it (see ./events and ./record).
import type { SqlQueryable } from '@/lib/authz/pg-runner';
import { recordEvent, AuditWriteError } from './record';
import type { AuditEventInput } from './events';
import { CODE_RE } from './events/types';

/** Opaque transaction handle (a pg client inside BEGIN/COMMIT in practice); typed loosely so callers need no DB import. */
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
  /** Short codes / ids only, e.g. { roleKey: 'tt-logleser' }. Checked against the event's strict schema. */
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_TYPE_RE = /^[a-z][a-z0-9_]{0,31}$/;

function isQueryable(tx: unknown): tx is SqlQueryable {
  return !!tx && typeof (tx as { query?: unknown }).query === 'function';
}

/**
 * Inserts the audit row ON the given transaction, so it commits or rolls back
 * together with the change. THROWS if the event is invalid or the insert fails:
 * an admin change must not succeed without its audit row.
 */
export async function recordAdminAction(tx: AuditTx, event: AdminActionEvent): Promise<void> {
  if (!isQueryable(tx)) throw new AuditWriteError('invalid_tx');
  await recordEvent(
    {
      type: event.type,
      actorUserId: event.actorUserId,
      entityType: event.entityType,
      entityId: event.entityId,
      ...(event.secondaryEntityId !== undefined
        ? { secondaryEntityType: event.secondaryEntityType, secondaryEntityId: event.secondaryEntityId }
        : {}),
      ...(event.details ? { details: event.details } : {}),
    } as AuditEventInput,
    { tx },
  );
}

/**
 * Best-effort: awaited by callers that can (the promise never rejects), and
 * never throws into the request. The Phase 1 call sites are synchronous and do
 * not await it, which is fine: the write completes in the background.
 */
export function recordAuthzDenied(event: AuthzDeniedEvent): Promise<void> {
  // A denial must be recorded even when the resource reference is unusable: drop the entity, keep the denial.
  const hasEntity = !!event.entityType && !!event.entityId && ENTITY_TYPE_RE.test(event.entityType) && UUID_RE.test(event.entityId);
  const code = (v: string) => (CODE_RE.test(v) ? v : 'invalid');
  return recordEvent({
    type: 'authz.denied',
    actorUserId: event.actorUserId,
    ...(hasEntity ? { entityType: event.entityType, entityId: event.entityId } : {}),
    details: { required: code(event.required), reason: code(event.reason) },
  } as AuditEventInput).then(
    () => undefined,
    () => undefined,
  );
}
