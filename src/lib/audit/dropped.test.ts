import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {}, pool: { query: vi.fn(), connect: vi.fn() } }));
const recordEvent = vi.fn();
vi.mock('./record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./record')>()),
  recordEvent: (...a: unknown[]) => recordEvent(...a),
}));

import { __droppedSize, __resetDroppedEvents, DROPPED_WINDOW_MS, noteDroppedEvents } from './dropped';
import { validateEvent } from './record';

const T0 = 1_000_000;
const events = () => recordEvent.mock.calls.map((c) => c[0] as { actorUserId: string; details: { reason: string; count: number } });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  recordEvent.mockReset().mockResolvedValue({ status: 'stored' });
  __resetDroppedEvents();
});
afterEach(() => vi.useRealTimers());

describe('noteDroppedEvents', () => {
  it('reports the first drop of a person and reason at once, as a valid system event with a count', () => {
    noteDroppedEvents('u1', 'daily_cap', 5, undefined, T0);
    expect(recordEvent).toHaveBeenCalledTimes(1);
    expect(recordEvent.mock.calls[0][0]).toMatchObject({
      type: 'audit.events_dropped',
      source: 'system',
      actorUserId: 'u1',
      details: { reason: 'daily_cap', count: 5 },
    });
    expect(validateEvent(recordEvent.mock.calls[0][0])).toMatchObject({ ok: true });
  });

  it('adds further drops inside the window up and reports them ONCE when the window ends', async () => {
    noteDroppedEvents('u1', 'throttle', 1, undefined, T0);
    noteDroppedEvents('u1', 'throttle', 2, undefined, T0 + 1_000);
    noteDroppedEvents('u1', 'throttle', 4, undefined, T0 + 2_000);
    expect(recordEvent).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DROPPED_WINDOW_MS);
    expect(events().map((e) => e.details)).toEqual([
      { reason: 'throttle', count: 1 },
      { reason: 'throttle', count: 6 },
    ]);
  });

  it('a drop after the window has passed is reported at once with the count since', () => {
    noteDroppedEvents('u1', 'rate_limit', 1, undefined, T0);
    noteDroppedEvents('u1', 'rate_limit', 3, undefined, T0 + DROPPED_WINDOW_MS + 1);
    expect(events().map((e) => e.details.count)).toEqual([1, 3]);
  });

  it('keeps people and reasons apart', () => {
    noteDroppedEvents('u1', 'daily_cap', 1, undefined, T0);
    noteDroppedEvents('u2', 'daily_cap', 1, undefined, T0);
    noteDroppedEvents('u1', 'actor_ceiling', 1, undefined, T0);
    expect(recordEvent).toHaveBeenCalledTimes(3);
  });

  it('is bounded: the oldest entry is reported and evicted when too many people are tracked', () => {
    for (let i = 0; i < 2_100; i++) noteDroppedEvents(`u${i}`, 'daily_cap', 1, undefined, T0 + i);
    expect(__droppedSize()).toBeLessThanOrEqual(2_000);
  });

  it('never throws, ignores nothing-to-report, and survives a failing write', async () => {
    recordEvent.mockRejectedValue(new Error('db down'));
    expect(() => noteDroppedEvents('u1', 'daily_cap', 1, undefined, T0)).not.toThrow();
    expect(() => noteDroppedEvents('u1', 'daily_cap', 0, undefined, T0)).not.toThrow();
    expect(() => noteDroppedEvents('', 'daily_cap', 1, undefined, T0)).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(recordEvent).toHaveBeenCalledTimes(1);
  });

  it('gives the report the request ip and user agent when it has a request', () => {
    const req = { headers: new Headers({ 'x-forwarded-for': '203.0.113.7', 'user-agent': 'TestBrowser/1' }) };
    noteDroppedEvents('u1', 'daily_cap', 1, req, T0);
    expect(recordEvent.mock.calls[0][1]).toMatchObject({ context: { ip: '203.0.113.7', userAgent: 'TestBrowser/1' } });
  });
});
