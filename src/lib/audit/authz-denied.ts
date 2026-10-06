// Best-effort recorder for authorisation denials (authz.denied). Never throws or
// rejects: a denial that cannot be recorded must not turn into a 500 or change
// the response. Callers are mostly synchronous guards and do not await it; the
// write completes in the background.
//
// Events carry ids and short codes ONLY (see ./events and ./record).
import { recordEvent, UUID_RE } from './record';
import { CODE_RE } from './events/types';

export interface AuthzDeniedEvent {
  actorUserId: string | null;
  /** Capability or guard that was required, e.g. 'access.manage'. */
  required: string;
  /** Short machine reason, e.g. 'missing_capability' | 'disabled' | 'out_of_scope' | 'wrong_source'. */
  reason: string;
  entityType?: string;
  entityId?: string;
}

const ENTITY_TYPE_RE = /^[a-z][a-z0-9_]{0,31}$/;

export function recordAuthzDenied(event: AuthzDeniedEvent): Promise<void> {
  // A denial must be recorded even when the resource reference is unusable: drop the entity, keep the denial.
  const hasEntity = !!event.entityType && !!event.entityId && ENTITY_TYPE_RE.test(event.entityType) && UUID_RE.test(event.entityId);
  const code = (v: string) => (CODE_RE.test(v) ? v : 'invalid');
  return recordEvent({
    type: 'authz.denied',
    actorUserId: event.actorUserId,
    ...(hasEntity ? { entityType: event.entityType, entityId: event.entityId } : {}),
    details: { required: code(event.required), reason: code(event.reason) },
  }).then(
    () => undefined,
    () => undefined,
  );
}
