import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Static invariants for the Teams join flow in teams-bot.ts. These lock the
 * load-bearing behaviours that the vexa comparison (June 2026) identified as
 * required for reliable joining — each one regressed silently at least once.
 */

const SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../../src/teams-bot.ts'),
  'utf8',
);

describe('join flow invariants', () => {
  it('selects "Computer audio" on the prejoin screen', () => {
    // Without this, Teams can default to "Don't use audio" — no audio
    // transceivers are negotiated, remote audio never arrives, and the
    // recording stays empty. vexa does this explicitly (join.ts Step 5).
    expect(SOURCE, 'teams-bot.ts no longer selects the Computer audio radio on the prejoin screen — recordings will be silent when Teams defaults to "Don\'t use audio"').toContain('Computer audio');
  });

  it('uses a polling readiness loop, not a one-shot modal check', () => {
    expect(SOURCE).toContain('_waitForPreJoinReadiness');
    // The readiness loop must handle the late-appearing no-media modal.
    expect(SOURCE, 'the "Continue without audio or video" modal handling is gone — it appears late and blocks Join now when missed').toContain('Continue without audio or video');
  });

  it('uses a polling admission loop, not a Promise.race', () => {
    expect(SOURCE).toContain('_waitForAdmission');
    // The race pattern caused the b78eac3 undefined-arm regression and two
    // false-'spurious' bugs. It must not come back.
    expect(SOURCE.includes('Promise.race<JoinRaceResult>'), 'the admission Promise.race is back — see lib/join-race.ts header for why the polling loop replaced it').toBe(false);
  });

  it('checks aria-disabled before accepting the Leave button as admission proof', () => {
    // Teams renders a visible-but-disabled hangup button during the
    // connecting state; accepting it declares admission before media is up.
    expect(SOURCE).toContain("aria-disabled");
  });
});
