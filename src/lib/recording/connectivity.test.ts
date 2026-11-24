// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The state is module-level, so each test loads a fresh copy.
let connectivity: typeof import('./connectivity').connectivity;
beforeEach(async () => {
  vi.resetModules();
  ({ connectivity } = await import('./connectivity'));
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('connectivity', () => {
  it('goes offline after two consecutive network failures, not after one', () => {
    connectivity.reportNetworkFailure();
    expect(connectivity.isOnline()).toBe(true);
    connectivity.reportNetworkFailure();
    expect(connectivity.isOnline()).toBe(false);
  });

  it('comes back online after any successful request', () => {
    connectivity.reportNetworkFailure();
    connectivity.reportNetworkFailure();
    connectivity.reportSuccess();
    expect(connectivity.isOnline()).toBe(true);
  });

  it('a success between two failures resets the count', () => {
    connectivity.reportNetworkFailure();
    connectivity.reportSuccess();
    connectivity.reportNetworkFailure();
    expect(connectivity.isOnline()).toBe(true);
  });

  it('follows the browser: offline while navigator.onLine is false, online again on the online event', () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    window.dispatchEvent(new Event('offline'));
    expect(connectivity.isOnline()).toBe(false);

    connectivity.reportNetworkFailure();
    connectivity.reportNetworkFailure();
    onLine.mockReturnValue(true);
    window.dispatchEvent(new Event('online'));
    expect(connectivity.isOnline()).toBe(true);
  });

  it('notifies subscribers on a change and on every online event', () => {
    const listener = vi.fn();
    const unsubscribe = connectivity.subscribe(listener);

    connectivity.reportNetworkFailure();
    expect(listener).not.toHaveBeenCalled();
    connectivity.reportNetworkFailure();
    expect(listener).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('online'));
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    connectivity.reportNetworkFailure();
    connectivity.reportNetworkFailure();
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
