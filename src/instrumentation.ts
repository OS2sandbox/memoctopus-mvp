/**
 * Next.js instrumentation hook (stable in Next 15, no config flag needed).
 * Runs once per server process — the place to start background work and the one-off
 * start-up bookkeeping: records a change of the system configuration in the audit log
 * (lib/system/config-fingerprint.ts) and loads the `catalogue` of the auth config file into
 * public.external_roles (lib/authz/external-roles.ts).
 */
export async function register(): Promise<void> {
  // Only the Node.js server runtime; the edge runtime has no pg pool.
  // The imports MUST sit inside the positive branch: `process.env.NEXT_RUNTIME`
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
    // Bounds how long an uncollected transcript stays on disk; see pending-sweeper.ts.
    const { startPendingSweeper } = await import('@/lib/pending-sweeper');
    startPendingSweeper();

    // Fire-and-forget: neither step throws or delays startup.
    try {
      const { checkConfigOnce } = await import('@/lib/system/config-fingerprint');
      // checkConfigOnce skips `next build` (NEXT_PHASE): no database, not a start, so it records nothing.
      void checkConfigOnce();
      const { syncConfigCatalogueOnce } = await import('@/lib/authz/external-roles');
      void syncConfigCatalogueOnce();
    } catch {
      // Startup must never depend on the audit trail.
    }
  }
}
