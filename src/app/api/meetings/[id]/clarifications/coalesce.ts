import { createCoalescer } from '@/lib/audit/coalesce';

// The recording screen polls clarifications every 25 s, so one meeting would write
// ~144 events an hour. Same best-effort, per-process volume guard as the live
// transcription path; success and error are keyed apart so a first success does
// not hide a later failure.
export const clarificationCoalescer = createCoalescer({ windowMs: 60 * 60 * 1000, maxEntries: 10_000 });

/** The meeting id is lower-cased; without a (valid) one the key is the actor alone, so garbage ids cannot mint fresh keys. */
export const clarificationKey = (actorUserId: string, meetingId: string | undefined, outcome: 'success' | 'error'): string =>
  `${actorUserId}\u0000${(meetingId ?? '').toLowerCase().slice(0, 64)}\u0000${outcome}`;
