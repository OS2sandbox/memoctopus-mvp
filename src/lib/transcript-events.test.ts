import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We test two distinct environments:
//   1. Browser-like: window is defined (we stub it with vi.stubGlobal).
//   2. SSR: window is undefined (the natural node test environment state, or we
//      temporarily delete the stub).
//
// Because the module is imported at the top level and the functions check
// `typeof window === 'undefined'` at *call time* (not at import time), we can
// toggle the global between tests without re-importing the module.

import { notifyTranscriptUpdated, onTranscriptUpdated } from './transcript-events';

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal EventTarget-backed window stub. */
function makeWindowStub() {
  const target = new EventTarget();
  return {
    dispatchEvent: target.dispatchEvent.bind(target),
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  };
}

// ─── notifyTranscriptUpdated ──────────────────────────────────────────────────

describe('notifyTranscriptUpdated', () => {
  let windowStub: ReturnType<typeof makeWindowStub>;

  beforeEach(() => {
    windowStub = makeWindowStub();
    vi.stubGlobal('window', windowStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('dispatches a CustomEvent on window', () => {
    const received: Event[] = [];
    windowStub.addEventListener('referat:transcript-updated', (e) => received.push(e));

    notifyTranscriptUpdated('meeting-abc');

    expect(received).toHaveLength(1);
  });

  it('dispatches an event with the correct meetingId in detail', () => {
    let detail: unknown;
    windowStub.addEventListener('referat:transcript-updated', (e) => {
      detail = (e as CustomEvent).detail;
    });

    notifyTranscriptUpdated('meeting-xyz');

    expect(detail).toEqual({ meetingId: 'meeting-xyz' });
  });

  it('dispatches the event with the exact meeting-id string provided', () => {
    const ids: string[] = [];
    windowStub.addEventListener('referat:transcript-updated', (e) => {
      ids.push((e as CustomEvent<{ meetingId: string }>).detail.meetingId);
    });

    notifyTranscriptUpdated('alpha');
    notifyTranscriptUpdated('beta');

    expect(ids).toEqual(['alpha', 'beta']);
  });

  it('uses the event name "referat:transcript-updated"', () => {
    const eventNames: string[] = [];
    const spy = vi.fn((e: Event) => eventNames.push(e.type));
    windowStub.addEventListener('referat:transcript-updated', spy);

    notifyTranscriptUpdated('m1');

    expect(spy).toHaveBeenCalledOnce();
    expect(eventNames[0]).toBe('referat:transcript-updated');
  });
});

// ─── notifyTranscriptUpdated — SSR (window undefined) ────────────────────────

describe('notifyTranscriptUpdated (SSR — window undefined)', () => {
  beforeEach(() => {
    // Ensure window is not defined in this suite.
    vi.stubGlobal('window', undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not throw when window is undefined', () => {
    expect(() => notifyTranscriptUpdated('meeting-ssr')).not.toThrow();
  });
});

// ─── onTranscriptUpdated ──────────────────────────────────────────────────────

describe('onTranscriptUpdated', () => {
  let windowStub: ReturnType<typeof makeWindowStub>;

  beforeEach(() => {
    windowStub = makeWindowStub();
    vi.stubGlobal('window', windowStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fires the callback when the matching meetingId is dispatched', () => {
    const cb = vi.fn();
    onTranscriptUpdated('meeting-1', cb);

    notifyTranscriptUpdated('meeting-1');

    expect(cb).toHaveBeenCalledOnce();
  });

  it('does NOT fire the callback when a different meetingId is dispatched', () => {
    const cb = vi.fn();
    onTranscriptUpdated('meeting-1', cb);

    notifyTranscriptUpdated('meeting-2');

    expect(cb).not.toHaveBeenCalled();
  });

  it('fires the callback multiple times for multiple matching dispatches', () => {
    const cb = vi.fn();
    onTranscriptUpdated('meeting-A', cb);

    notifyTranscriptUpdated('meeting-A');
    notifyTranscriptUpdated('meeting-A');
    notifyTranscriptUpdated('meeting-A');

    expect(cb).toHaveBeenCalledTimes(3);
  });

  it('allows multiple subscriptions on the same meetingId to each fire independently', () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    onTranscriptUpdated('meeting-multi', cb1);
    onTranscriptUpdated('meeting-multi', cb2);

    notifyTranscriptUpdated('meeting-multi');

    expect(cb1).toHaveBeenCalledOnce();
    expect(cb2).toHaveBeenCalledOnce();
  });

  it('does not cross-fire between different meetingId subscribers', () => {
    const cbA = vi.fn();
    const cbB = vi.fn();
    onTranscriptUpdated('meeting-A', cbA);
    onTranscriptUpdated('meeting-B', cbB);

    notifyTranscriptUpdated('meeting-A');

    expect(cbA).toHaveBeenCalledOnce();
    expect(cbB).not.toHaveBeenCalled();
  });

  it('returns a function (unsubscribe)', () => {
    const cb = vi.fn();
    const unsub = onTranscriptUpdated('meeting-1', cb);

    expect(typeof unsub).toBe('function');
  });

  it('unsubscribe prevents the callback from firing after removal', () => {
    const cb = vi.fn();
    const unsub = onTranscriptUpdated('meeting-unsub', cb);

    unsub();
    notifyTranscriptUpdated('meeting-unsub');

    expect(cb).not.toHaveBeenCalled();
  });

  it('unsubscribe only removes its own listener, leaving other subscribers intact', () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const unsub1 = onTranscriptUpdated('meeting-X', cb1);
    onTranscriptUpdated('meeting-X', cb2);

    unsub1();
    notifyTranscriptUpdated('meeting-X');

    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledOnce();
  });

  it('calling unsubscribe multiple times does not throw', () => {
    const cb = vi.fn();
    const unsub = onTranscriptUpdated('meeting-double-unsub', cb);

    expect(() => {
      unsub();
      unsub();
    }).not.toThrow();
  });
});

// ─── onTranscriptUpdated — SSR (window undefined) ────────────────────────────

describe('onTranscriptUpdated (SSR — window undefined)', () => {
  beforeEach(() => {
    vi.stubGlobal('window', undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not throw when window is undefined', () => {
    expect(() => onTranscriptUpdated('meeting-ssr', vi.fn())).not.toThrow();
  });

  it('returns a no-op function when window is undefined', () => {
    const unsub = onTranscriptUpdated('meeting-ssr', vi.fn());

    expect(typeof unsub).toBe('function');
    expect(() => unsub()).not.toThrow();
  });
});
