import { describe, it, expect } from 'vitest';
import { createCoalescer, liveTranscriptionKey } from './coalesce';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe('createCoalescer', () => {
  it('lets the first call through and blocks repeats inside the window', () => {
    const c = clock();
    const co = createCoalescer({ windowMs: 3_600_000, maxEntries: 100, now: c.now });
    expect(co.shouldEmit('a')).toBe(true);
    expect(co.shouldEmit('a')).toBe(false);
    c.advance(3_599_999);
    expect(co.shouldEmit('a')).toBe(false);
  });

  it('lets the key through again once the window has passed', () => {
    const c = clock();
    const co = createCoalescer({ windowMs: 3_600_000, maxEntries: 100, now: c.now });
    expect(co.shouldEmit('a')).toBe(true);
    c.advance(3_600_000);
    expect(co.shouldEmit('a')).toBe(true);
    expect(co.shouldEmit('a')).toBe(false);
  });

  it('tracks keys independently', () => {
    const co = createCoalescer({ windowMs: 1_000, maxEntries: 100, now: clock().now });
    expect(co.shouldEmit('a')).toBe(true);
    expect(co.shouldEmit('b')).toBe(true);
    expect(co.shouldEmit('a')).toBe(false);
  });

  it('drops expired keys so the map cannot grow without bound over time', () => {
    const c = clock();
    const co = createCoalescer({ windowMs: 1_000, maxEntries: 1_000, now: c.now });
    for (let i = 0; i < 50; i++) co.shouldEmit(`k${i}`);
    expect(co.size()).toBe(50);
    c.advance(1_000);
    co.shouldEmit('fresh');
    expect(co.size()).toBe(1);
  });

  it('stays within maxEntries by evicting the oldest key when still full', () => {
    const co = createCoalescer({ windowMs: 3_600_000, maxEntries: 3, now: clock().now });
    for (const k of ['a', 'b', 'c', 'd', 'e']) co.shouldEmit(k);
    expect(co.size()).toBe(3);
    // a and b were evicted, so they are claimable again; c..e are not.
    expect(co.shouldEmit('e')).toBe(false);
    expect(co.shouldEmit('a')).toBe(true);
    expect(co.size()).toBe(3);
  });

  it('clear() forgets everything', () => {
    const co = createCoalescer({ windowMs: 3_600_000, maxEntries: 3, now: clock().now });
    co.shouldEmit('a');
    co.clear();
    expect(co.size()).toBe(0);
    expect(co.shouldEmit('a')).toBe(true);
  });
});

describe('liveTranscriptionKey', () => {
  it('separates actor and meeting so different pairs never collide', () => {
    expect(liveTranscriptionKey('a:b', 'c', 'success')).not.toBe(liveTranscriptionKey('a', 'b:c', 'success'));
    expect(liveTranscriptionKey('u', 'm1', 'success')).not.toBe(liveTranscriptionKey('u', 'm2', 'success'));
  });

  it('keys success and error apart', () => {
    expect(liveTranscriptionKey('u', 'm1', 'success')).not.toBe(liveTranscriptionKey('u', 'm1', 'error'));
  });

  it('bounds the key length for an attacker-sized meeting id', () => {
    expect(liveTranscriptionKey('u', 'x'.repeat(10_000), 'success').length).toBeLessThan(100);
  });
});
