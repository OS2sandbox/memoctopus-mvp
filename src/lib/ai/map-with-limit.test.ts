import { describe, it, expect } from 'vitest';
import { mapWithLimit } from './map-with-limit';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('mapWithLimit', () => {
  it('returns results in input order', async () => {
    const out = await mapWithLimit([3, 1, 2], 2, async (n) => {
      await sleep(n * 3);
      return n * 10;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  it('never runs more than `limit` tasks at once, and does run them in parallel', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithLimit(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(5);
      inFlight--;
    });
    expect(peak).toBe(3);
  });

  it('handles an empty list', async () => {
    expect(await mapWithLimit([], 3, async (x) => x)).toEqual([]);
  });

  it('rejects with the first error and starts no new tasks afterwards', async () => {
    const started: number[] = [];
    await expect(
      mapWithLimit([0, 1, 2, 3, 4, 5], 1, async (n) => {
        started.push(n);
        if (n === 1) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
    await sleep(10);
    expect(started).toEqual([0, 1]);
  });
});
