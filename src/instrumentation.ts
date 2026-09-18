/**
 * Next.js instrumentation hook (stable in Next 15, no config flag needed).
 * Runs once per server process — the place to start background work.
 */
export async function register() {
  // Only the Node.js server runtime; the edge runtime has no pg pool.
  // The import MUST sit inside the positive branch: `process.env.NEXT_RUNTIME`
  // is inlined at build time, so webpack drops the whole block (and with it the
  // `pg` dependency chain) when compiling this file for the edge runtime.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Logged unconditionally: this hook failing to run is invisible otherwise, and
    // the only symptom is that Teams meetings are never collected unless someone
    // has the waiting screen open. Diagnosing that from the outside took far
    // longer than this line costs.
    console.log('[instrumentation] register() running on the nodejs runtime');
    const { startPoller } = await import('@/lib/teams/poller');
    startPoller();
  }
}
