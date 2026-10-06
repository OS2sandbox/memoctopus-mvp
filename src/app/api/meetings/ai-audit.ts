// Shared by the AI/export routes: emits their audit events without ever letting
// the audit write (or a bad id) affect the user's request. Metadata only: the
// helpers here never see transcript text, titles or error messages.
import type { AuditEventOf, EventType } from '@/lib/audit/events';
import { recordServerEvent, UUID_RE } from '@/lib/audit/record';
import type { HeaderSource } from '@/lib/audit/request-context';
import { takeClientEventBudget } from '@/lib/audit/client-ingest';
import { describeError } from '@/lib/audit/safe-log';

/**
 * Route params and form fields are client-supplied and never verified against a
 * meeting, so an id only becomes an audit entity when it is a well-formed UUID;
 * anything else yields undefined (the event is then logged without an entity).
 */
export function asEntityUuid(value: unknown): string | undefined {
  return typeof value === 'string' && UUID_RE.test(value) ? value : undefined;
}

export const elapsedMs = (t0: number): number => Math.max(0, Date.now() - t0);

const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ABORT_ERR', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET',
]);

/**
 * A short code describing why an AI/STT call failed, from a CLOSED set: `http_<status>`
 * (numeric 100-599), `timeout`, `network` or `unknown`. It is derived from the error's
 * numeric status, code and class name only, and never forwards a string the upstream
 * error carries (an upstream server or a proxy can choose `code` and the message, and
 * those can echo prompt or transcript text).
 */
export function outcomeCodeOf(err: unknown): 'timeout' | 'network' | 'unknown' | `http_${number}` {
  const { name, status, code } = describeError(err);
  if (status !== undefined) return `http_${status}`;
  if ((code && TIMEOUT_CODES.has(code)) || /Timeout|^AbortError$/.test(name)) return 'timeout';
  if ((code && NETWORK_CODES.has(code)) || /^APIConnectionError$|^FetchError$/.test(name)) return 'network';
  return 'unknown';
}

/**
 * The AI/export routes' name for recordServerEvent, which is best-effort and never throws.
 * Per-actor volume guard on top of the routes' own coalescers: the per-user fixed window of
 * the client-event ingest (300 events a minute, per process), in a bucket of its own so
 * server-emitted events cannot use up the browser's budget. Beyond it the event is dropped,
 * never the request. Needed because a coalescer keys on the meeting id, which the client chooses.
 */
export function emitAudit<T extends EventType>(req: HeaderSource, event: AuditEventOf<T>): ReturnType<typeof recordServerEvent> {
  if (event.actorUserId && takeClientEventBudget(`server-ai:${event.actorUserId}`, 1) !== null) {
    return Promise.resolve({ status: 'dropped', code: 'actor_rate_limited' });
  }
  return recordServerEvent(req, event);
}
