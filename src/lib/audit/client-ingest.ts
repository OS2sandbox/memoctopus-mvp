// Server side of the client-reported audit events: the request envelope, the
// time clamp and the per-user rate limit used by POST /api/audit/client-events.
// Kept out of route.ts because a Next route file may only export handlers.
import { z } from 'zod';
import { CLIENT_EVENT_TYPES, type EventType } from './events';

export const MAX_CLIENT_EVENTS_PER_REQUEST = 50;
/** About 32 KB: 50 catalogue events are a few KB, so this is generous. */
export const MAX_CLIENT_BODY_BYTES = 32 * 1024;
const MAX_PAST_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_MS = 5 * 60 * 1000;

// Only the meeting.* types: a browser may not report anything else through here
// (auth.login_failed also has source 'client' but belongs to another endpoint).
const TYPES = CLIENT_EVENT_TYPES.filter((t) => t.startsWith('meeting.')) as [EventType, ...EventType[]];

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

export type ClientEventsBody = z.infer<typeof clientEventsBody>;

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

/** Test only. */
export function __resetClientEventBudgets(): void {
  windows.clear();
}
