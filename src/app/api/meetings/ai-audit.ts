// Shared by the AI/export routes: emits their audit events without ever letting
// the audit write (or a bad id) affect the user's request. Metadata only: the
// helpers here never see transcript text, titles or error messages.
import type { AuditEventOf, EventType } from '@/lib/audit/events';
import { recordServerEvent } from '@/lib/audit/record';
import type { HeaderSource } from '@/lib/audit/request-context';
import { describeError } from '@/lib/audit/safe-log';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** recordServerEvent never throws by contract; the catch is a second line of defence. */
export async function emitAudit<T extends EventType>(req: HeaderSource, event: AuditEventOf<T>): Promise<void> {
  try {
    await recordServerEvent(req, event);
  } catch {
    console.warn(`[audit] event dropped type=${event.type} code=emit_failed`);
  }
}
