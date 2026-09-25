import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/pending-artifacts', () => ({ sweepExpired: vi.fn().mockResolvedValue(undefined) }));

import { sweepExpired } from '@/lib/pending-artifacts';
import { startPendingSweeper, SWEEP_INTERVAL_MS } from './pending-sweeper';

const mockSweep = vi.mocked(sweepExpired);

/** The sweeper is off under Vitest, like the poller; these tests act as production. */
function asProduction() {
  vi.stubEnv('VITEST', '');
  vi.stubEnv('NODE_ENV', 'production');
}

const stops: Array<() => void> = [];
function start() {
  const stop = startPendingSweeper();
  stops.push(stop);
  return stop;
}

beforeEach(() => {
  mockSweep.mockClear().mockResolvedValue(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  while (stops.length) stops.pop()!();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('startPendingSweeper', () => {
  it('does nothing in the test environment', () => {
    const spy = vi.spyOn(global, 'setInterval');
    start();
    expect(spy).not.toHaveBeenCalled();
    expect(mockSweep).not.toHaveBeenCalled();
  });

  // The whole point: an uncollected transcript must go even when no other meeting
  // is ever processed, so nothing here is triggered by a run.
  it('removes an expired entry with no new run: it sweeps on a timer', async () => {
    vi.useFakeTimers();
    asProduction();
    start();
    mockSweep.mockClear(); // the sweep at start-up is checked separately

    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS * 3);

    expect(mockSweep).toHaveBeenCalledTimes(3);
  });

  it('also sweeps once at start-up, so a restart does not leave old entries waiting a full interval', async () => {
    vi.useFakeTimers();
    asProduction();
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockSweep).toHaveBeenCalledTimes(1);
  });

  it('starts once: a second call neither adds a second timer nor a second sweep loop', async () => {
    vi.useFakeTimers();
    asProduction();
    const spy = vi.spyOn(global, 'setInterval');
    start();
    start();
    expect(spy).toHaveBeenCalledTimes(1);

    mockSweep.mockClear();
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    expect(mockSweep).toHaveBeenCalledTimes(1);
  });

  it('stops when told to, and can then be started again', async () => {
    vi.useFakeTimers();
    asProduction();
    const stop = start();
    stop();
    mockSweep.mockClear();
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS * 2);
    expect(mockSweep).not.toHaveBeenCalled();

    const spy = vi.spyOn(global, 'setInterval');
    start();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not hold the process open', () => {
    asProduction();
    const timer = { unref: vi.fn() };
    vi.spyOn(global, 'setInterval').mockReturnValue(timer as never);
    vi.spyOn(global, 'clearInterval').mockImplementation(() => {});
    start();
    expect(timer.unref).toHaveBeenCalled();
  });

  it('survives a sweep that fails and keeps ticking', async () => {
    vi.useFakeTimers();
    asProduction();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    start();
    mockSweep.mockClear().mockRejectedValueOnce(new Error('disk gone'));

    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS * 2);

    expect(mockSweep).toHaveBeenCalledTimes(2);
  });

  it('does not overlap a slow sweep with the next tick', async () => {
    vi.useFakeTimers();
    asProduction();
    start();
    await vi.advanceTimersByTimeAsync(0);
    mockSweep.mockClear();
    let release!: () => void;
    mockSweep.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));

    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS * 2);
    expect(mockSweep).toHaveBeenCalledTimes(1);
    release();
  });
});
