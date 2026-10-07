// Best-effort recorder for authorisation denials (authz.denied). Never throws or
// rejects: a denial that cannot be recorded must not turn into a 500 or change
// the response. Callers are mostly synchronous guards and do not await it; the
// write completes in the background.
//
// A person who keeps hitting the same guard (a script probing an endpoint, a stuck retry
// loop) would otherwise fill the log: per (person, guard, entity type) the first
// DENIAL_LIMIT_PER_MINUTE denials of a minute are stored one by one, the rest are counted
// into ONE `authz.denied` row (reason 'burst_summary', droppedCount) when the minute ends.
// In memory and per process, bounded like the login-failed throttle.
//
// Events carry ids and short codes ONLY (see ./events and ./record).
import { recordEvent, UUID_RE } from './record';
import { CODE_RE } from './events/types';
import { requestContext, type HeaderSource, type RequestContext } from './request-context';
import { createThrottle } from './throttle';

export interface AuthzDeniedEvent {
  actorUserId: string | null;
  /** Capability or guard that was required, e.g. 'access.manage'. */
  required: string;
  /** Short machine reason, e.g. 'missing_capability' | 'disabled' | 'out_of_scope' | 'wrong_source'. */
  reason: string;
  entityType?: string;
  entityId?: string;
  /** The request, when the caller has it: its ip and user agent are stored with the denial. */
  req?: HeaderSource | null;
}

const ENTITY_TYPE_RE = /^[a-z][a-z0-9_]{0,31}$/;

export const DENIAL_LIMIT_PER_MINUTE = 10;
const SEP = '\u0000';
const NO_ACTOR = '-';

function summaryEvent(key: string, dropped: number): void {
  const [actor, required, entityType] = key.split(SEP);
  void recordEvent({
    type: 'authz.denied',
    actorUserId: actor === NO_ACTOR ? null : actor,
    ...(entityType ? { entityType } : {}),
    details: { required, reason: 'burst_summary', droppedCount: dropped },
  }).catch(() => undefined);
}

const throttle = createThrottle({
  limit: DENIAL_LIMIT_PER_MINUTE,
  windowMs: 60_000,
  maxKeys: 5_000,
  onSummary: summaryEvent,
});

/** Test only. */
export function __resetAuthzDeniedThrottle(): void {
  throttle.reset();
}

function contextOf(req: HeaderSource | null | undefined): Partial<RequestContext> | undefined {
  if (!req) return undefined;
  try {
    return requestContext(req);
  } catch {
    return undefined;
  }
}

export function recordAuthzDenied(event: AuthzDeniedEvent): Promise<void> {
  // A denial must be recorded even when the resource reference is unusable: drop the entity, keep the denial.
  const hasEntity = !!event.entityType && !!event.entityId && ENTITY_TYPE_RE.test(event.entityType) && UUID_RE.test(event.entityId);
  const code = (v: string) => (CODE_RE.test(v) ? v : 'invalid');
  const required = code(event.required);
  const key = [event.actorUserId ?? NO_ACTOR, required, hasEntity ? event.entityType : ''].join(SEP);
  // Over the limit: counted, and reported once when the minute ends.
  if (!throttle.allow(key)) return Promise.resolve();
  const context = contextOf(event.req);
  const input = {
    type: 'authz.denied' as const,
    actorUserId: event.actorUserId,
    ...(hasEntity ? { entityType: event.entityType, entityId: event.entityId } : {}),
    details: { required, reason: code(event.reason) },
  };
  return (context ? recordEvent(input, { context }) : recordEvent(input)).then(
    () => undefined,
    () => undefined,
  );
}
