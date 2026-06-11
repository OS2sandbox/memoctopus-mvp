/**
 * Leave-button-gone detector.
 *
 * Each poll (every 2s) reports whether the Teams in-call hangup button is
 * visible. When it disappears we don't react immediately because Teams hides
 * it transiently during toolbar animations, network blips, and error-screen
 * transitions. Instead we count consecutive "gone" polls and only trigger a
 * stop after both:
 *   - the bot has been in the meeting longer than ELAPSED_GATE_S (so the
 *     hide-then-show during lobby→meeting transition doesn't count); and
 *   - we've seen the button missing for CONSECUTIVE_POLLS in a row.
 *
 * This file holds the pure counter logic only — it has no Playwright/DOM
 * dependencies and can be tested with a sequence of synthetic poll results.
 */

export interface LeaveDetectorState {
  consecutiveGonePolls: number;
}

export const ELAPSED_GATE_S = 30;
export const CONSECUTIVE_POLLS_REQUIRED = 5;

export function newLeaveDetectorState(): LeaveDetectorState {
  return { consecutiveGonePolls: 0 };
}

export interface LeaveDetectorInput {
  leaveButtonVisible: boolean;
  elapsedSeconds: number;
  isActivelyRecording: boolean;
}

export interface LeaveDetectorDecision {
  state: LeaveDetectorState;
  shouldStop: boolean;
  logLine: string | null;
}

/**
 * Pure state transition. Returns the next state and whether the caller should
 * trigger `bot.stop()`. The caller is responsible for the side effect; this
 * function only decides.
 *
 * `logLine` is the structured one-line log to emit for this poll (null = no
 * log this tick). Keeping it here makes the test assertions readable.
 */
export function leaveDetectorTick(
  state: LeaveDetectorState,
  input: LeaveDetectorInput,
): LeaveDetectorDecision {
  const { leaveButtonVisible, elapsedSeconds, isActivelyRecording } = input;

  // Either the button is back, or we're inside the grace window, or we're
  // not in a state where stopping is appropriate. Reset and move on.
  if (leaveButtonVisible || elapsedSeconds <= ELAPSED_GATE_S || !isActivelyRecording) {
    return {
      state: { consecutiveGonePolls: 0 },
      shouldStop: false,
      logLine: null,
    };
  }

  const next = state.consecutiveGonePolls + 1;
  if (next >= CONSECUTIVE_POLLS_REQUIRED) {
    return {
      state: { consecutiveGonePolls: next },
      shouldStop: true,
      logLine: `Leave button gone for ${next} consecutive polls — kicked or meeting ended`,
    };
  }
  return {
    state: { consecutiveGonePolls: next },
    shouldStop: false,
    logLine: `Leave button gone (poll ${next}/${CONSECUTIVE_POLLS_REQUIRED}) — waiting to confirm`,
  };
}
