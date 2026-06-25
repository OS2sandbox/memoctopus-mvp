/**
 * Admission-wait result type.
 *
 * `_waitForAdmission` polls the Teams page every 2 s after "Join now" is
 * clicked, evaluating ALL signals each tick (denial text, connection-error
 * page, Leave-button presence, lobby indicators) until one of these
 * outcomes is reached:
 *
 *   - 'admitted' — an enabled in-meeting Leave button was seen on two
 *     consecutive ticks (or the lobby disappeared without any rejection,
 *     the assume-admitted fallback).
 *   - 'denied'   — rejection text was found, or the connection-error page
 *     persisted through all rejoin retries.
 *   - 'timeout'  — neither happened within the admission window.
 *
 * History: this used to be a `Promise.race` of waitForSelector/waitForFunction
 * arms. That design produced a string of regressions — an arm resolving
 * `undefined` (commit b78eac3), false 'spurious' classifications when Teams
 * hid the Leave button during slow lobby→meeting transitions, and a
 * `hangForever()` helper that existed solely to stop arms from mis-settling.
 * A polling loop re-evaluates every signal each tick, so a transient state
 * can never permanently mis-settle the outcome. The 'spurious' result is
 * gone: when the lobby disappears and no denial is present we assume
 * admitted and let the in-meeting leave-detector backstop a false positive.
 */

export type JoinRaceResult =
  | 'admitted'
  | 'denied'
  | 'timeout';

export function isAdmitted(result: JoinRaceResult): result is 'admitted' {
  return result === 'admitted';
}

export function joinFailureMessage(result: Exclude<JoinRaceResult, 'admitted'>): string {
  return `Entry ${result} — host denied or meeting unreachable`;
}
