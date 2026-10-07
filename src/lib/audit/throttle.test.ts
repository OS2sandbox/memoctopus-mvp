import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createThrottle } from './throttle';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createThrottle (audit copy)', () => {
  it('lets `limit` events through per window, counts the rest and reports them once when the window ends', async () => {
    const onSummary = vi.fn();
    const t = createThrottle({ limit: 2, windowMs: 60_000, maxKeys: 10, onSummary });
    expect([t.allow('k'), t.allow('k'), t.allow('k'), t.allow('k')]).toEqual([true, true, false, false]);
    expect(onSummary).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onSummary).toHaveBeenCalledExactlyOnceWith('k', 2);
  });

  it('is bounded in keys and reset() forgets everything', () => {
    const t = createThrottle({ limit: 1, windowMs: 60_000, maxKeys: 3 });
    for (let i = 0; i < 10; i++) t.allow(`k${i}`);
    expect(t.size()).toBeLessThanOrEqual(3);
    t.reset();
    expect(t.size()).toBe(0);
  });
});
