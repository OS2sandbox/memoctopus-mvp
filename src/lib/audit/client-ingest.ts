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
const TYPE_SET: ReadonlySet<string> = new Set(TYPES);

/**
 * True when the body looks like a batch that only fails because one event has a type this
 * server does not know (a newer client reaching an older instance in a rolling deploy). The
 * route answers that with 400 + code 'unknown_event_type', which the browser treats as
 * "try again later" instead of throwing the event away.
 */
export function hasUnknownEventType(json: unknown): boolean {
  const events = (json as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) return false;
  return events.some((e) => {
    const type = (e as { type?: unknown } | null)?.type;
    return typeof type === 'string' && !TYPE_SET.has(type);
  });
}

/** Response body for a batch with an unknown event type; the browser keys on `code`. */
export const UNKNOWN_EVENT_TYPE_BODY = { error: 'Invalid request', code: 'unknown_event_type' } as const;

export const CLIENT_OUTCOMES = ['success', 'error'] as const;
export type ClientOutcome = (typeof CLIENT_OUTCOMES)[number];

// STRICT: any other key (an `actor`, `ip`, `userId`, `source` ...) fails parsing.
// `details` is only shape-checked here; the per-type strict schema runs in
// validateEvent / recordEvent.
export const clientEventsBody = z
  .object({
    // The browser's own count of events it lost before delivering them (outbox full, expired
    // after 7 days, refused for good). Recorded as one audit.events_dropped row (reason
    // client_outbox). The id makes a redelivery idempotent.
    droppedLocally: z
      .object({ count: z.number().int().min(1).max(1_000_000), clientEventId: z.string().uuid() })
      .strict()
      .optional(),
    // May be empty only when droppedLocally is present (the route refuses a batch with neither).
    events: z
      .array(
        z
          .object({
            clientEventId: z.string().uuid(),
            occurredAt: z.string().datetime({ offset: true }),
            type: z.enum(TYPES),
            entityId: z.string().uuid(),
            details: z.record(z.unknown()).default({}),
            // How the action ended, as the browser saw it. Only these two: a local action cannot be
            // 'denied', and any other value fails the strict parse (refused for good, counted by the
            // browser). Absent = success. Self-reported like everything else here.
            outcome: z.enum(CLIENT_OUTCOMES).optional(),
          })
          .strict(),
      )
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
// client; it is not an accounting mechanism. Generous on purpose: the log is a
// documentation requirement, so the limit is for runaway clients, not for normal use
// (a refused batch stays in the browser's outbox and is retried, see client.ts).
export const RATE_LIMIT_EVENTS = 1000;
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

/** Test only. */
export function __resetClientEventBudgets(): void {
  windows.clear();
}
