// Bounded in-memory fixed-window throttle with a counted summary, shared by the audit
// writers that must not be floodable (login_failed, authz.denied, live audio.upload) without
// ever dropping silently.
/**
 * Fixed-window counter per key with a hard cap on tracked keys, so an attacker
 * rotating source addresses cannot grow memory. In-memory and per process:
 * with several app instances the effective limit is per instance.
 *
 * Nothing is dropped SILENTLY: events over the limit are counted, and when the window
 * ends `onSummary(key, droppedCount)` is called once (from a timer, or earlier when the
 * key is evicted or its next window starts). A crash inside the window loses that count.
 *
 * `summaryAt` (e.g. [100, 1000, 10000]) reports a burst while it is still going: when the
 * dropped count of a window reaches one of those values, `onSummary` is called with the
 * number dropped since the previous report, so a flood that outlives a crash is on record,
 * and the reports of one window add up to its total.
 */
export function createThrottle(opts: {
  limit: number;
  windowMs: number;
  maxKeys: number;
  now?: () => number;
  summaryAt?: readonly number[];
  onSummary?: (key: string, dropped: number) => void;
}) {
  const now = opts.now ?? Date.now;
  interface Win {
    start: number;
    count: number;
    dropped: number;
    /** How much of `dropped` has already been reported. */
    reported: number;
    timer?: ReturnType<typeof setTimeout>;
  }
  const windows = new Map<string, Win>();

  const report = (key: string, w: Win) => {
    const unreported = w.dropped - w.reported;
    if (unreported <= 0) return;
    w.reported = w.dropped;
    try {
      opts.onSummary?.(key, unreported);
    } catch {
      // A summary that cannot be written must not break the login that triggered it.
    }
  };

  const close = (key: string, w: Win) => {
    if (w.timer) clearTimeout(w.timer);
    windows.delete(key);
    report(key, w);
  };

  return {
    /** True when this event may be recorded; false once the key is over its limit for the window (it is then counted). */
    allow(key: string): boolean {
      const t = now();
      const w = windows.get(key);
      if (w && t - w.start < opts.windowMs) {
        w.count += 1;
        if (w.count <= opts.limit) return true;
        w.dropped += 1;
        if (opts.summaryAt?.includes(w.dropped)) report(key, w);
        if (opts.onSummary && !w.timer) {
          // Report the burst when its window ends even if no further failure arrives.
          w.timer = setTimeout(() => {
            if (windows.get(key) === w) close(key, w);
          }, Math.max(0, w.start + opts.windowMs - t));
          w.timer.unref?.();
        }
        return false;
      }
      if (w) close(key, w);
      if (windows.size >= opts.maxKeys) {
        for (const [k, v] of windows) if (t - v.start >= opts.windowMs) close(k, v);
        // Still full of live windows: evict the oldest (Map keeps insertion order).
        while (windows.size >= opts.maxKeys) {
          const oldest = windows.entries().next();
          if (oldest.done) break;
          close(oldest.value[0], oldest.value[1]);
        }
      }
      windows.set(key, { start: t, count: 1, dropped: 0, reported: 0 });
      return true;
    },
    size: () => windows.size,
    /** Test only: forget every window (and its pending summary). */
    reset(): void {
      for (const w of windows.values()) if (w.timer) clearTimeout(w.timer);
      windows.clear();
    },
  };
}
