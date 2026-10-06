// Server side of the client-reported audit events: the request envelope, the
// time clamp and the per-user rate limit used by POST /api/audit/client-events.
// Kept out of route.ts because a Next route file may only export handlers.
import { z } from 'zod';
import { defaultRunner, type SqlQueryable } from '@/lib/authz/pg-runner';
import { auditClientEventsDailyCap } from './config';
import type { EventType } from './events';
import { meetingEvents } from './events/meeting';

const MAX_CLIENT_EVENTS_PER_REQUEST = 50;
/** About 32 KB: 50 catalogue events are a few KB, so this is generous. */
export const MAX_CLIENT_BODY_BYTES = 32 * 1024;
const MAX_PAST_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_MS = 5 * 60 * 1000;

// Only the meeting.* types: a browser may not report anything else through here.
const TYPES = Object.keys(meetingEvents) as [EventType, ...EventType[]];

// STRICT: any other key (an `actor`, `ip`, `userId`, `source` ...) fails parsing.
// `details` is only shape-checked here; the per-type strict schema runs in
// validateEvent / recordEvent.
export const clientEventsBody = z
  .object({
    events: z
      .array(
        z
          .object({
            clientEventId: z.string().uuid(),
            occurredAt: z.string().datetime({ offset: true }),
            type: z.enum(TYPES),
            entityId: z.string().uuid(),
            details: z.record(z.unknown()).default({}),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_CLIENT_EVENTS_PER_REQUEST),
  })
  .strict();

/**
 * The client's clock is not trusted: a time more than 7 days back or 5 minutes
 * ahead (or unparseable) is replaced by the server's time. The result is stored
 * next to, never instead of, the server's own occurred_at.
 */
export function clampClientTime(claimed: string, now: Date = new Date()): Date {
  const t = Date.parse(claimed);
  if (Number.isNaN(t)) return now;
  if (t < now.getTime() - MAX_PAST_MS || t > now.getTime() + MAX_FUTURE_MS) return now;
  return new Date(t);
}

// Per-user fixed window, in memory: counts are per server instance, so with several
// instances the effective limit is N times higher. Good enough to stop a runaway
// client; it is not an accounting mechanism.
export const RATE_LIMIT_EVENTS = 300;
export const RATE_LIMIT_WINDOW_MS = 60_000;
const windows = new Map<string, { start: number; count: number }>();

/** Takes `n` events from the user's budget. Returns seconds to wait when it is exhausted, else null. */
export function takeClientEventBudget(userId: string, n: number, now = Date.now()): number | null {
  if (windows.size > 5000) {
    for (const [k, w] of windows) if (now - w.start >= RATE_LIMIT_WINDOW_MS) windows.delete(k);
  }
  let w = windows.get(userId);
  if (!w || now - w.start >= RATE_LIMIT_WINDOW_MS) {
    w = { start: now, count: 0 };
    windows.set(userId, w);
  }
  if (w.count + n > RATE_LIMIT_EVENTS) return Math.max(1, Math.ceil((w.start + RATE_LIMIT_WINDOW_MS - now) / 1000));
  w.count += n;
  return null;
}

/**
 * How many source='client' events this user already has in the last 24 h, counted up to
 * `limit` (the query stops scanning at `limit` rows, so a flooded actor stays cheap).
 * Uses audit_events_actor_idx (actor_user_id, id). THROWS on a database failure: the
 * route answers 503 and stores nothing (self-reported telemetry is not worth a guess).
 */
export async function countRecentClientEvents(
  userId: string,
  limit: number,
  runner: SqlQueryable = defaultRunner(),
): Promise<number> {
  const { rows } = await runner.query<{ n: number | string }>(
    `SELECT count(*) AS n FROM (
       SELECT 1 FROM public.audit_events
        WHERE actor_user_id = $1 AND source = 'client' AND occurred_at > now() - interval '24 hours'
        LIMIT $2
     ) recent`,
    [userId, limit],
  );
  const n = Number(rows[0]?.n);
  if (!Number.isFinite(n)) throw new Error('client_event_count_failed');
  return n;
}

/**
 * Room left in the user's daily cap: `cap - used`, never negative. Throws like
 * countRecentClientEvents.
 */
export async function remainingClientEventsToday(userId: string, runner?: SqlQueryable): Promise<number> {
  const cap = auditClientEventsDailyCap();
  const used = await countRecentClientEvents(userId, cap, runner);
  return Math.max(0, cap - used);
}

// Per-(user, meeting, type) throttle for chatty types: one stored row per minute says
// all the log needs to say. Empty today (create, delete, redact and audio delete are
// one-off lifecycle moments); the mechanism stays so a chatty type can be added by
// listing it here (the browser-side counterpart is COALESCED). In memory and best
// effort like the budget above (per instance, lost on restart).
export const THROTTLED_TYPES: Set<string> = new Set();
export const THROTTLE_WINDOW_MS = 60_000;
export const THROTTLE_MAX_ENTRIES = 5000;
const lastStored = new Map<string, number>();

const throttleKey = (userId: string, entityId: string, type: string) => `${userId}\u0000${entityId}\u0000${type}`;

/** True when an event of this type for this meeting was stored by this user less than 60 s ago. */
export function isClientEventThrottled(userId: string, entityId: string, type: string, now = Date.now()): boolean {
  if (!THROTTLED_TYPES.has(type)) return false;
  const t = lastStored.get(throttleKey(userId, entityId, type));
  return t !== undefined && now - t < THROTTLE_WINDOW_MS;
}

/** Remember that an event was stored now (call after a successful store only). Bounded: expired entries go first, then the oldest. */
export function markClientEventStored(userId: string, entityId: string, type: string, now = Date.now()): void {
  if (!THROTTLED_TYPES.has(type)) return;
  const key = throttleKey(userId, entityId, type);
  lastStored.delete(key); // re-insert so Map order stays oldest-first
  lastStored.set(key, now);
  if (lastStored.size > THROTTLE_MAX_ENTRIES) {
    for (const [k, t] of lastStored) {
      if (now - t >= THROTTLE_WINDOW_MS) lastStored.delete(k);
    }
    // Still over: every entry is live, drop the oldest until back at the bound.
    for (const k of lastStored.keys()) {
      if (lastStored.size <= THROTTLE_MAX_ENTRIES) break;
      lastStored.delete(k);
    }
  }
}

/** Test only. */
export function __resetClientEventBudgets(): void {
  windows.clear();
  lastStored.clear();
}

/** Test only. */
export function __throttleSize(): number {
  return lastStored.size;
}
