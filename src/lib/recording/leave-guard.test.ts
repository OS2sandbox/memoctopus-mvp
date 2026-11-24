// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { setLeaveGuard, isLeaveGuarded, useLeaveGuard } from './leave-guard';

function leave(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

afterEach(() => {
  setLeaveGuard(false);
});

describe('leave guard', () => {
  it('asks before unloading only while guarded', () => {
    expect(leave()).toBe(false);

    setLeaveGuard(true);
    expect(isLeaveGuarded()).toBe(true);
    expect(leave()).toBe(true);

    setLeaveGuard(false);
    expect(isLeaveGuarded()).toBe(false);
    expect(leave()).toBe(false);
  });

  it('re-renders readers when the guard changes', () => {
    const { result } = renderHook(() => useLeaveGuard());
    expect(result.current).toBe(false);
    act(() => setLeaveGuard(true));
    expect(result.current).toBe(true);
  });

  it('one release lifts a guard that was set twice', () => {
    setLeaveGuard(true);
    setLeaveGuard(true);
    setLeaveGuard(false);
    expect(leave()).toBe(false);
  });
});
