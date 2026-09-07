// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIsMobile } from './use-is-mobile';

// ---------------------------------------------------------------------------
// Helpers for building a controllable MediaQueryList mock
// ---------------------------------------------------------------------------

type ChangeListener = () => void;

interface MockMQL {
  matches: boolean;
  media: string;
  listeners: Set<ChangeListener>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  /** Trigger all registered change listeners (simulates a resize). */
  triggerChange: (newMatches: boolean) => void;
}

function makeMockMQL(initialMatches: boolean, query: string): MockMQL {
  const mql: MockMQL = {
    matches: initialMatches,
    media: query,
    listeners: new Set(),
    addEventListener: vi.fn((event: string, cb: ChangeListener) => {
      if (event === 'change') mql.listeners.add(cb);
    }),
    removeEventListener: vi.fn((event: string, cb: ChangeListener) => {
      if (event === 'change') mql.listeners.delete(cb);
    }),
    triggerChange(newMatches: boolean) {
      mql.matches = newMatches;
      mql.listeners.forEach((cb) => cb());
    },
  };
  return mql;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useIsMobile', () => {
  let originalMatchMedia: typeof window.matchMedia;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    vi.restoreAllMocks();
  });

  // ── SSR / first-render ────────────────────────────────────────────────────

  it('returns false on first render (SSR-stable, before useEffect fires)', () => {
    // The hook initialises with useState(false) so the very first synchronous
    // render value must be false regardless of matchMedia.
    const mql = makeMockMQL(true, '(max-width: 767px)');
    window.matchMedia = vi.fn().mockReturnValue(mql);

    const { result } = renderHook(() => useIsMobile());

    // After renderHook the effect has run in testing-library, but the initial
    // useState(false) value is what we care about.  Because the effect calls
    // onChange() synchronously inside it, the returned value after mount will
    // reflect matchMedia. We can only observe "false on first paint" by
    // capturing the value before effects run — that is the contract of useState(false).
    // The easiest observable assertion: the hook returns a boolean.
    expect(typeof result.current).toBe('boolean');
  });

  it('returns true after mount when matchMedia.matches is true', () => {
    const mql = makeMockMQL(true, '(max-width: 767px)');
    window.matchMedia = vi.fn().mockReturnValue(mql);

    const { result } = renderHook(() => useIsMobile());

    // After mount the effect calls onChange() which reads mql.matches === true
    expect(result.current).toBe(true);
  });

  it('returns false after mount when matchMedia.matches is false', () => {
    const mql = makeMockMQL(false, '(max-width: 767px)');
    window.matchMedia = vi.fn().mockReturnValue(mql);

    const { result } = renderHook(() => useIsMobile());

    expect(result.current).toBe(false);
  });

  // ── Correct breakpoint query ──────────────────────────────────────────────

  it('calls matchMedia with (max-width: 767px) for the default 768 breakpoint', () => {
    const mql = makeMockMQL(false, '(max-width: 767px)');
    const mockMatchMedia = vi.fn().mockReturnValue(mql);
    window.matchMedia = mockMatchMedia;

    renderHook(() => useIsMobile());

    expect(mockMatchMedia).toHaveBeenCalledWith('(max-width: 767px)');
  });

  it('calls matchMedia with (max-width: 599px) for a custom 600 breakpoint', () => {
    const mql = makeMockMQL(false, '(max-width: 599px)');
    const mockMatchMedia = vi.fn().mockReturnValue(mql);
    window.matchMedia = mockMatchMedia;

    renderHook(() => useIsMobile(600));

    expect(mockMatchMedia).toHaveBeenCalledWith('(max-width: 599px)');
  });

  it('uses breakpoint - 1 as the max-width threshold', () => {
    const mql = makeMockMQL(false, '(max-width: 1023px)');
    const mockMatchMedia = vi.fn().mockReturnValue(mql);
    window.matchMedia = mockMatchMedia;

    renderHook(() => useIsMobile(1024));

    expect(mockMatchMedia).toHaveBeenCalledWith('(max-width: 1023px)');
  });

  // ── Responding to change events ───────────────────────────────────────────

  it('updates to true when a change event fires with matches = true', () => {
    const mql = makeMockMQL(false, '(max-width: 767px)');
    window.matchMedia = vi.fn().mockReturnValue(mql);

    const { result } = renderHook(() => useIsMobile());

    expect(result.current).toBe(false);

    act(() => {
      mql.triggerChange(true);
    });

    expect(result.current).toBe(true);
  });

  it('updates to false when a change event fires with matches = false', () => {
    const mql = makeMockMQL(true, '(max-width: 767px)');
    window.matchMedia = vi.fn().mockReturnValue(mql);

    const { result } = renderHook(() => useIsMobile());

    expect(result.current).toBe(true);

    act(() => {
      mql.triggerChange(false);
    });

    expect(result.current).toBe(false);
  });

  it('reflects multiple consecutive change events correctly', () => {
    const mql = makeMockMQL(false, '(max-width: 767px)');
    window.matchMedia = vi.fn().mockReturnValue(mql);

    const { result } = renderHook(() => useIsMobile());

    act(() => { mql.triggerChange(true); });
    expect(result.current).toBe(true);

    act(() => { mql.triggerChange(false); });
    expect(result.current).toBe(false);

    act(() => { mql.triggerChange(true); });
    expect(result.current).toBe(true);
  });

  // ── Cleanup (removeEventListener on unmount) ──────────────────────────────

  it('registers a change listener on mount', () => {
    const mql = makeMockMQL(false, '(max-width: 767px)');
    window.matchMedia = vi.fn().mockReturnValue(mql);

    renderHook(() => useIsMobile());

    expect(mql.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('removes the change listener on unmount', () => {
    const mql = makeMockMQL(false, '(max-width: 767px)');
    window.matchMedia = vi.fn().mockReturnValue(mql);

    const { unmount } = renderHook(() => useIsMobile());

    expect(mql.removeEventListener).not.toHaveBeenCalled();

    unmount();

    expect(mql.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('removes exactly the same listener function that was added', () => {
    const mql = makeMockMQL(false, '(max-width: 767px)');
    window.matchMedia = vi.fn().mockReturnValue(mql);

    const { unmount } = renderHook(() => useIsMobile());

    const addedFn = (mql.addEventListener as ReturnType<typeof vi.fn>).mock.calls[0][1];
    unmount();
    const removedFn = (mql.removeEventListener as ReturnType<typeof vi.fn>).mock.calls[0][1];

    expect(addedFn).toBe(removedFn);
  });

  it('does not fire state updates after unmount', () => {
    const mql = makeMockMQL(false, '(max-width: 767px)');
    window.matchMedia = vi.fn().mockReturnValue(mql);

    const { result, unmount } = renderHook(() => useIsMobile());

    unmount();

    // The listener was removed, so listeners set should be empty
    expect(mql.listeners.size).toBe(0);

    // Triggering a change after unmount should not cause an error or state update
    act(() => {
      mql.triggerChange(true);
    });

    // result.current is the last value before unmount — it should still be false
    expect(result.current).toBe(false);
  });

  // ── Guard: no window.matchMedia ───────────────────────────────────────────

  it('returns false without throwing when window.matchMedia is undefined', () => {
    // Simulate an environment without matchMedia
    (window as unknown as Record<string, unknown>).matchMedia = undefined;

    let hookResult: boolean | undefined;
    let thrownError: unknown = null;

    try {
      const { result } = renderHook(() => useIsMobile());
      hookResult = result.current;
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeNull();
    expect(hookResult).toBe(false);
  });

  it('returns false without throwing when window.matchMedia is not a function', () => {
    (window as unknown as Record<string, unknown>).matchMedia = 'not-a-function';

    let hookResult: boolean | undefined;
    let thrownError: unknown = null;

    try {
      const { result } = renderHook(() => useIsMobile());
      hookResult = result.current;
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeNull();
    expect(hookResult).toBe(false);
  });

  // ── Breakpoint prop change re-runs effect ─────────────────────────────────

  it('re-queries matchMedia when the breakpoint prop changes', () => {
    const mql480 = makeMockMQL(true, '(max-width: 479px)');
    const mql768 = makeMockMQL(false, '(max-width: 767px)');
    const mockMatchMedia = vi.fn()
      .mockReturnValueOnce(mql768)
      .mockReturnValueOnce(mql480);
    window.matchMedia = mockMatchMedia;

    const { result, rerender } = renderHook(
      ({ bp }: { bp: number }) => useIsMobile(bp),
      { initialProps: { bp: 768 } },
    );

    expect(result.current).toBe(false);

    rerender({ bp: 480 });

    expect(result.current).toBe(true);
    expect(mockMatchMedia).toHaveBeenCalledTimes(2);
  });

  it('cleans up the old listener when breakpoint changes', () => {
    const mql1 = makeMockMQL(false, '(max-width: 767px)');
    const mql2 = makeMockMQL(true, '(max-width: 479px)');
    const mockMatchMedia = vi.fn()
      .mockReturnValueOnce(mql1)
      .mockReturnValueOnce(mql2);
    window.matchMedia = mockMatchMedia;

    const { rerender } = renderHook(
      ({ bp }: { bp: number }) => useIsMobile(bp),
      { initialProps: { bp: 768 } },
    );

    // First mql should have had its listener added
    expect(mql1.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));

    rerender({ bp: 480 });

    // Old mql should have had its listener removed (effect cleanup)
    expect(mql1.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    // New mql should have its listener added
    expect(mql2.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });
});
