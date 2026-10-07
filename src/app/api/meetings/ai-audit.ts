// Shared by the minutes and export routes (the only AI/export routes that are audited):
// emits their audit events without ever letting the audit write (or a bad id) affect
// the user's request. Metadata only: the helpers here never see transcript text,
// titles or error messages.
import type { AuditEventOf, EventType } from '@/lib/audit/events';
import { recordServerEvent, UUID_RE } from '@/lib/audit/record';
import type { HeaderSource } from '@/lib/audit/request-context';
import { takeClientEventBudget } from '@/lib/audit/client-ingest';
import { describeError } from '@/lib/audit/safe-log';
import { noteDroppedEvents } from '@/lib/audit/dropped';

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
 * The minutes/export routes' name for recordServerEvent, which is best-effort and never throws.
 * Per-actor volume guard: the per-user fixed window of the client-event ingest (RATE_LIMIT_EVENTS,
 * 1000 events a minute, per process), in a bucket of its own so server-emitted events cannot use up
 * the browser's budget. Beyond it the event is dropped, never the request, and the drop is COUNTED
 * and reported as `audit.events_dropped` (reason actor_ceiling, see dropped.ts).
 */
export function emitAudit<T extends EventType>(req: HeaderSource, event: AuditEventOf<T>): ReturnType<typeof recordServerEvent> {
  if (event.actorUserId && takeClientEventBudget(`server-ai:${event.actorUserId}`, 1) !== null) {
    noteDroppedEvents(event.actorUserId, 'actor_ceiling', 1, req);
    return Promise.resolve({ status: 'dropped', code: 'actor_rate_limited' });
  }
  return recordServerEvent(req, event);
}

// ─── live audio ──────────────────────────────────────────────────────────────

/** One utterance is sent every few seconds while recording; the log gets one row per person and meeting per window. */
export const LIVE_AUDIO_WINDOW_MS = 5 * 60_000;
export const LIVE_AUDIO_MAX_ENTRIES = 5_000;
const liveAudioLast = new Map<string, number>();

/**
 * audio.upload for the live recording path (channel 'live'), at most once per (person, meeting,
 * outcome) per 5 minutes: a long recording sends hundreds of utterances and a row for each would
 * bury the log. The row carries the size of THAT utterance. By design this is coalescing, not a
 * loss, so the skipped ones are not reported as dropped. Bounded: the oldest entry is evicted.
 */
export function emitLiveAudioUpload(
  req: HeaderSource,
  event: { actorUserId: string; entityId: string | undefined; outcome: 'success' | 'error'; bytes: number; durationMs: number; outcomeCode?: string },
  now = Date.now(),
): void {
  const key = `${event.actorUserId}|${event.entityId ?? '-'}|${event.outcome}`;
  const last = liveAudioLast.get(key);
  if (last !== undefined && now - last < LIVE_AUDIO_WINDOW_MS) return;
  liveAudioLast.delete(key); // re-insert so Map order stays oldest-first
  liveAudioLast.set(key, now);
  if (liveAudioLast.size > LIVE_AUDIO_MAX_ENTRIES) {
    for (const [k, t] of liveAudioLast) if (now - t >= LIVE_AUDIO_WINDOW_MS) liveAudioLast.delete(k);
    for (const k of liveAudioLast.keys()) {
      if (liveAudioLast.size <= LIVE_AUDIO_MAX_ENTRIES) break;
      liveAudioLast.delete(k);
    }
  }
  void emitAudit(req, {
    type: 'audio.upload',
    actorUserId: event.actorUserId,
    outcome: event.outcome,
    entityId: event.entityId,
    details: {
      channel: 'live',
      bytes: event.bytes,
      durationMs: event.durationMs,
      ...(event.outcomeCode ? { outcomeCode: event.outcomeCode } : {}),
    },
  });
}

/** Test only. */
export function __resetLiveAudio(): void {
  liveAudioLast.clear();
}

/** Test only. */
export function __liveAudioSize(): number {
  return liveAudioLast.size;
}
