// The coalescer itself is shared (src/lib/audit/coalesce.ts) with the other
// high-frequency audit paths; this file only holds the live-transcription policy.
import { createCoalescer } from '@/lib/audit/coalesce';

// Re-exported so existing imports (and the tests) keep working.
export { createCoalescer, type Coalescer } from '@/lib/audit/coalesce';

const HOUR_MS = 60 * 60 * 1000;

/** One live-transcription event per actor+meeting per hour, at most 10 000 tracked keys. */
export const liveTranscriptionCoalescer = createCoalescer({ windowMs: HOUR_MS, maxEntries: 10_000 });

/**
 * Key parts are joined with a NUL so no actor/meeting pair can collide with another. Outcomes are
 * keyed apart so a first success does not hide a later failure. The meeting id is lower-cased so
 * case variants cannot dodge the coalescing; without a (valid) meeting id the key is the actor alone.
 */
export const liveTranscriptionKey = (actorUserId: string, meetingId: string | undefined, outcome: 'success' | 'error'): string =>
  `${actorUserId}\u0000${(meetingId ?? '').toLowerCase().slice(0, 64)}\u0000live\u0000${outcome}`;
