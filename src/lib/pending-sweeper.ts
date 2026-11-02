import { sweepExpired } from '@/lib/pending-artifacts';

/**
 * Keeps the pending hand-off files (see pending-artifacts.ts) from outliving their
 * TTL. It runs on its own timer, not when another meeting happens to be processed:
 * otherwise a transcript nobody collected would sit on disk for as long as the
 * server stays quiet, and be deleted at some arbitrary later moment when it did
 * not. With the timer an entry lives at most the TTL plus one interval.
 *
 * Personal data on disk is the reason this is not optional, so it is not gated on
 * TEAMS_GRAPH_ENABLED: files left by an earlier run must go even if the operator
 * has since switched the integration off.
 */
export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

let stopCurrent: (() => void) | null = null;

function sweeperDisabled(): boolean {
  if (process.env.NODE_ENV === 'test') return true;
  return Boolean(process.env.VITEST);
}

/**
 * Starts the sweep (once at start-up, then every interval). Returns a stop
 * function. Calling it while already running returns the running instance's stop
 * function instead of adding a second timer. Wired from `src/instrumentation.ts`
 * on the nodejs runtime only.
 */
export function startPendingSweeper(): () => void {
  if (sweeperDisabled()) return () => {};
  if (stopCurrent) return stopCurrent;

  let running = false;
  const tick = async () => {
    if (running) return; // a slow sweep must not overlap with the next tick
    running = true;
    try {
      await sweepExpired();
    } catch (err) {
      console.error('[pending-sweeper] sweep failed:', err);
    } finally {
      running = false;
    }
  };

  console.log(`[pending-sweeper] started, sweeping every ${SWEEP_INTERVAL_MS} ms`);
  void tick();
  const timer = setInterval(() => { void tick(); }, SWEEP_INTERVAL_MS);

  // Do not hold the process open for the sake of the timer.
  (timer as unknown as { unref?: () => void }).unref?.();

  stopCurrent = () => {
    clearInterval(timer);
    stopCurrent = null;
  };
  return stopCurrent;
}
