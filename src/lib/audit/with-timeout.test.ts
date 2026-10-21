import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTimeout } from './with-timeout';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('withTimeout', () => {
  it('false when the work finishes in time, true when the time runs out first', async () => {
    await expect(withTimeout(Promise.resolve(1), 1000)).resolves.toBe(false);
    let done: boolean | undefined;
    void withTimeout(new Promise(() => {}), 1000).then((v) => (done = v));
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2);
    expect(done).toBe(true);
  });

  it('rejects when the work rejects in time, and leaves no timer behind', async () => {
    await expect(withTimeout(Promise.reject(new Error('x')), 1000)).rejects.toThrow('x');
    expect(vi.getTimerCount()).toBe(0);
  });
});
