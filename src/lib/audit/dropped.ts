// Makes the server's own limits visible. When the daily cap, the per-minute rate limit, the
// per-actor ceiling on server-emitted events or the view throttle makes the log skip
// events, the skipped events are COUNTED here and reported as `audit.events_dropped`
// rows (source 'system', a reason and a count, never what was skipped): the first drop of a
// (person, reason) is reported at once, further drops inside the next WINDOW_MS are added
// up and reported once when the window ends (from an unref'd timer). Dropping is then a
// documented, counted event, not a silent loss. The event itself is exempt from every cap
// (it is written directly, not through emitAudit or the client-event budget).
//
// In memory and per process, bounded: when MAX_KEYS entries are tracked the oldest is
// reported and evicted. A crash inside a window loses that window's pending count.
import type { DropReason } from './events/audit';
import { recordEvent } from './record';
import { safeRequestContext, type HeaderSource, type RequestContext } from './request-context';

/** The reasons the server itself reports; `client_outbox` is self-reported by the browser. */
export type ServerDropReason = Exclude<DropReason, 'client_outbox'>;

export const DROPPED_WINDOW_MS = 10 * 60_000;
const MAX_KEYS = 2_000;
const SEP = '\u0000';

interface Entry {
  actor: string;
  reason: ServerDropReason;
  pending: number;
  lastEmit: number;
  context?: Partial<RequestContext>;
  timer?: ReturnType<typeof setTimeout>;
}

const entries = new Map<string, Entry>();

function emit(e: Entry, now: number): void {
  if (e.timer) clearTimeout(e.timer);
  e.timer = undefined;
  const count = e.pending;
  e.pending = 0;
  e.lastEmit = now;
  if (count <= 0) return;
  void recordEvent(
    { type: 'audit.events_dropped', source: 'system', actorUserId: e.actor, details: { reason: e.reason, count } },
    e.context ? { context: e.context } : {},
  ).catch(() => undefined);
}

/**
 * Count `count` events of `actorUserId` that were skipped for `reason`. Never throws.
 * `req` (optional) only gives the report an ip and user agent.
 */
export function noteDroppedEvents(
  actorUserId: string,
  reason: ServerDropReason,
  count = 1,
  req?: HeaderSource | null,
  now = Date.now(),
): void {
  try {
    if (!actorUserId || count <= 0) return;
    const key = `${actorUserId}${SEP}${reason}`;
    let e = entries.get(key);
    if (!e) {
      if (entries.size >= MAX_KEYS) {
        const oldest = entries.entries().next();
        if (!oldest.done) {
          emit(oldest.value[1], now);
          entries.delete(oldest.value[0]);
        }
      }
      e = { actor: actorUserId, reason, pending: 0, lastEmit: -Infinity };
      entries.set(key, e);
    }
    e.pending += count;
    // No request metadata is better than no report.
    if (req) e.context = safeRequestContext(req) ?? e.context;
    if (now - e.lastEmit >= DROPPED_WINDOW_MS) {
      emit(e, now);
      // Keep Map order oldest-first for eviction.
      entries.delete(key);
      entries.set(key, e);
      return;
    }
    if (!e.timer) {
      const entry = e;
      e.timer = setTimeout(() => emit(entry, Date.now()), Math.max(0, e.lastEmit + DROPPED_WINDOW_MS - now));
      e.timer.unref?.();
    }
  } catch {
    // Reporting a drop must never break the request that dropped.
  }
}

/** Test only. */
export function __resetDroppedEvents(): void {
  for (const e of entries.values()) if (e.timer) clearTimeout(e.timer);
  entries.clear();
}

/** Test only. */
export function __droppedSize(): number {
  return entries.size;
}
