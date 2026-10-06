// Shared by the AI/export routes: emits their audit events without ever letting
// the audit write (or a bad id) affect the user's request. Metadata only: the
// helpers here never see transcript text, titles or error messages.
import type { AuditEventOf, EventType } from '@/lib/audit/events';
import { recordServerEvent, UUID_RE } from '@/lib/audit/record';
import type { HeaderSource } from '@/lib/audit/request-context';
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

/**
 * A short code describing why an AI/STT call failed. Built only from the error's
 * code, HTTP status or class name (describeError), never its message, because
 * those messages can echo prompt or transcript text.
 */
export function outcomeCodeOf(err: unknown): string {
  const { name, status, code } = describeError(err);
  if (code) return code;
  if (status !== undefined) return `http_${status}`;
  const fromName = name.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 64);
  return fromName || 'error';
}

/** The AI/export routes' name for recordServerEvent, which is best-effort and never throws. */
export function emitAudit<T extends EventType>(req: HeaderSource, event: AuditEventOf<T>): ReturnType<typeof recordServerEvent> {
  return recordServerEvent(req, event);
}
