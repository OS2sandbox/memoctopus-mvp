import { describe, it, expect } from 'vitest';
import {
  newLeaveDetectorState,
  leaveDetectorTick,
  ELAPSED_GATE_S,
  CONSECUTIVE_POLLS_REQUIRED,
} from '../../src/lib/leave-detector';

/**
 * The leave-detector counts consecutive "leave button is gone" polls, gated by
 * an elapsed-seconds threshold so the lobby→meeting toolbar transition doesn't
 * trip a false positive. Every regression in this area has come from someone
 * changing the threshold or the counter reset rule; these tests lock both.
 */

describe('leaveDetectorTick', () => {
  const baseInput = {
    leaveButtonVisible: false,
    elapsedSeconds: 60,
    isActivelyRecording: true,
  };

  it('does not trigger stop while inside the elapsed grace window', () => {
    let state = newLeaveDetectorState();
    for (let elapsed = 0; elapsed <= ELAPSED_GATE_S; elapsed += 2) {
      const decision = leaveDetectorTick(state, { ...baseInput, elapsedSeconds: elapsed });
      expect(decision.shouldStop).toBe(false);
      state = decision.state;
    }
    // Counter never advanced during the grace period.
    expect(state.consecutiveGonePolls).toBe(0);
  });

  it('triggers stop only after CONSECUTIVE_POLLS_REQUIRED past the grace window', () => {
    let state = newLeaveDetectorState();
    for (let i = 1; i < CONSECUTIVE_POLLS_REQUIRED; i++) {
      const decision = leaveDetectorTick(state, baseInput);
      expect(decision.shouldStop).toBe(false);
      expect(decision.state.consecutiveGonePolls).toBe(i);
      state = decision.state;
    }
    const final = leaveDetectorTick(state, baseInput);
    expect(final.shouldStop).toBe(true);
    expect(final.state.consecutiveGonePolls).toBe(CONSECUTIVE_POLLS_REQUIRED);
    expect(final.logLine).toMatch(/kicked or meeting ended/);
  });

  it('resets the counter when the leave button reappears mid-streak', () => {
    let state = newLeaveDetectorState();
    // Build up to one less than required.
    for (let i = 1; i < CONSECUTIVE_POLLS_REQUIRED; i++) {
      state = leaveDetectorTick(state, baseInput).state;
    }
    expect(state.consecutiveGonePolls).toBe(CONSECUTIVE_POLLS_REQUIRED - 1);

    // Button reappears for one poll.
    const back = leaveDetectorTick(state, { ...baseInput, leaveButtonVisible: true });
    expect(back.shouldStop).toBe(false);
    expect(back.state.consecutiveGonePolls).toBe(0);

    // Counter restarts from 0 — we need the full streak again.
    let next = back.state;
    for (let i = 1; i < CONSECUTIVE_POLLS_REQUIRED; i++) {
      const decision = leaveDetectorTick(next, baseInput);
      expect(decision.shouldStop).toBe(false);
      next = decision.state;
    }
    expect(leaveDetectorTick(next, baseInput).shouldStop).toBe(true);
  });

  it('does not trigger stop while not actively recording (joining/paused/ended)', () => {
    let state = newLeaveDetectorState();
    for (let i = 0; i < CONSECUTIVE_POLLS_REQUIRED * 2; i++) {
      const decision = leaveDetectorTick(state, { ...baseInput, isActivelyRecording: false });
      expect(decision.shouldStop).toBe(false);
      expect(decision.state.consecutiveGonePolls).toBe(0);
      state = decision.state;
    }
  });

  it('logs a structured "waiting to confirm" line for intermediate polls', () => {
    const decision = leaveDetectorTick(newLeaveDetectorState(), baseInput);
    expect(decision.logLine).toMatch(/Leave button gone \(poll 1\/5\)/);
  });

  it('returns no log line when button visible (steady state should be silent)', () => {
    const decision = leaveDetectorTick(newLeaveDetectorState(), { ...baseInput, leaveButtonVisible: true });
    expect(decision.logLine).toBeNull();
  });
});
