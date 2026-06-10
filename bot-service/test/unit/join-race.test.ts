import { describe, it, expect } from 'vitest';
import { JoinRaceResult, isAdmitted, joinFailureMessage } from '../../src/lib/join-race';

/**
 * The admission wait must resolve to a known tag — never undefined. The
 * original regression (b78eac3) was a Promise.race arm returning early and
 * feeding `undefined` into the result handler; the race has since been
 * replaced by a polling loop (_waitForAdmission), and 'spurious' was removed
 * in favour of the assume-admitted fallback. These tests lock the
 * discriminated union shape.
 */

describe('JoinRaceResult discriminated union', () => {
  it('isAdmitted narrows correctly for every possible value', () => {
    const all: JoinRaceResult[] = ['admitted', 'denied', 'timeout'];
    expect(all.filter(isAdmitted)).toEqual(['admitted']);
    expect(all.filter((r) => !isAdmitted(r))).toEqual(['denied', 'timeout']);
  });

  it('joinFailureMessage returns the entry message for denied/timeout', () => {
    expect(joinFailureMessage('denied')).toMatch(/Entry denied/);
    expect(joinFailureMessage('timeout')).toMatch(/Entry timeout/);
  });
});
