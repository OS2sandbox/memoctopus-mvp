// Best-effort "at most once per window per key" gate, used so the per-utterance
// transcription path (one request every few seconds during a meeting) produces
// one audit event per actor+meeting+mode per hour instead of a flood.
//
// In-memory and per process: with several app instances each keeps its own map,
// so the true rate is at most one event per instance per window; a restart also
// resets it. That is acceptable for a volume guard (the event is a sample of
// activity, not a count). Memory is bounded two ways: expired keys are dropped on
// every call, and when the map is still full the oldest key is evicted.

export interface Coalescer {
  /** True when this key has not been seen within the window; claims the slot. */
  shouldEmit(key: string): boolean;
  size(): number;
  clear(): void;
}

export function createCoalescer(opts: { windowMs: number; maxEntries: number; now?: () => number }): Coalescer {
  const now = opts.now ?? Date.now;
  // key -> expiry. Keys are re-inserted (delete + set) on every claim and the window
  // is constant, so insertion order is expiry order and cleanup can stop at the first live entry.
  const seen = new Map<string, number>();

  const purge = (t: number) => {
    for (const [key, expires] of seen) {
      if (expires > t) break;
      seen.delete(key);
    }
  };

  return {
    shouldEmit(key) {
      const t = now();
      purge(t);
      if (seen.has(key)) return false;
      while (seen.size >= opts.maxEntries) {
        const oldest = seen.keys().next();
        if (oldest.done) break;
        seen.delete(oldest.value);
      }
      seen.set(key, t + opts.windowMs);
      return true;
    },
    size: () => seen.size,
    clear: () => seen.clear(),
  };
}

const HOUR_MS = 60 * 60 * 1000;

/** One live-transcription event per actor+meeting per hour, at most 10 000 tracked keys. */
export const liveTranscriptionCoalescer = createCoalescer({ windowMs: HOUR_MS, maxEntries: 10_000 });

/** Key parts are joined with a NUL so no actor/meeting pair can collide with another. */
export const liveTranscriptionKey = (actorUserId: string, meetingId: string): string =>
  `${actorUserId}\u0000${meetingId.slice(0, 64)}\u0000live`;
