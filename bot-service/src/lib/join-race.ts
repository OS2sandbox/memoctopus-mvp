/**
 * Join-race result type.
 *
 * `_joinMeeting` waits in a `Promise.race` between several arms:
 *   - admission detection (LEAVE_BTN visible after lobby)
 *   - connection-error fast path ("Sorry, we couldn't connect you")
 *   - denial text detection ("you weren't let in", etc.)
 *   - outer timeout fallback
 *
 * The recurring bug (commit b78eac3) was that a race arm could resolve with
 * `undefined`, which then satisfied `if (joinResult !== 'admitted')` and
 * threw a misleading "Entry undefined" error. The fix is to make the race
 * return a discriminated union so the type system guarantees every arm
 * resolves with a known tag.
 *
 * This file owns the type and the `isAdmitted` guard. Tests assert that
 * arms never resolve with `undefined` and that the `hangPromise` helper
 * works as expected.
 */

export type JoinRaceResult =
  | 'admitted'
  | 'spurious'
  | 'denied'
  | 'timeout';

export function isAdmitted(result: JoinRaceResult): result is 'admitted' {
  return result === 'admitted';
}

export function joinFailureMessage(result: Exclude<JoinRaceResult, 'admitted'>): string {
  if (result === 'spurious') {
    return 'Hangup button appeared then disappeared — page still navigating or join failed';
  }
  // denied / timeout
  return `Entry ${result} — host denied or meeting unreachable`;
}

/**
 * Returns a Promise that never resolves. Use this in race arms that have
 * completed their work but must NOT settle the outer race, so other arms
 * (admission, denial) can win.
 *
 * Past bug: arms used `await new Promise<never>(() => {})` inline; one
 * accidental `return` exited early and resolved the arm with `undefined`,
 * winning the race and breaking the type contract. Wrapping it as a named
 * helper makes the intent obvious at the call site.
 */
export function hangForever(): Promise<never> {
  return new Promise<never>(() => {});
}
