import { describe, it, expect } from 'vitest';
import { JoinRaceResult, isAdmitted, joinFailureMessage, hangForever } from '../../src/lib/join-race';

/**
 * The join race in _joinMeeting must NEVER resolve to undefined — the original
 * regression (b78eac3) was an async arm returning early and feeding `undefined`
 * into the result handler. These tests lock the discriminated union shape and
 * the hangForever helper that prevents accidental early returns.
 */

describe('JoinRaceResult discriminated union', () => {
  it('isAdmitted narrows correctly for every possible value', () => {
    const all: JoinRaceResult[] = ['admitted', 'spurious', 'denied', 'timeout'];
    expect(all.filter(isAdmitted)).toEqual(['admitted']);
    expect(all.filter((r) => !isAdmitted(r))).toEqual(['spurious', 'denied', 'timeout']);
  });

  it('joinFailureMessage returns the spurious message for the spurious case', () => {
    expect(joinFailureMessage('spurious')).toMatch(/Hangup button appeared then disappeared/);
  });

  it('joinFailureMessage returns the entry message for denied/timeout', () => {
    expect(joinFailureMessage('denied')).toMatch(/Entry denied/);
    expect(joinFailureMessage('timeout')).toMatch(/Entry timeout/);
  });
});

describe('hangForever', () => {
  it('returns a Promise that never resolves and never rejects', async () => {
    const promise = hangForever();
    // Race it against a settled timeout — the settled side must win.
    const tag = await Promise.race<string>([
      promise.then(() => 'hang-resolved'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout-won'), 25)),
    ]);
    expect(tag).toBe('timeout-won');
  });

  it('is assignable to Promise<never> — caller-site type guard', () => {
    // Compile-time check: any narrower type would let the bug class (resolving
    // with `undefined`) sneak back. If this annotation ever breaks, the
    // hangForever signature has loosened in a way that re-enables the bug.
    const p: Promise<never> = hangForever();
    // Use p to keep the linter quiet.
    expect(typeof p.then).toBe('function');
  });
});
