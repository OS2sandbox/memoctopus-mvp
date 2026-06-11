import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Regression lock for the "Action failed → Leaving..." class of bug.
 *
 * Background: every time the bot clicks a Teams toolbar button in the first
 * ~5 s after admission (mic toggle, participants panel, raise hand, etc.),
 * one of two things happens:
 *   (a) the button has mounted but Teams' React handlers aren't bound yet,
 *       so the click dispatches an unhandled rejection → "Action failed";
 *   (b) Teams' click handler iterates RTCRtpSenders and hits the foreign
 *       sender returned by webrtc-patch.ts → InvalidAccessError → "Action
 *       failed".
 *
 * Either way, Teams responds with an auto-leave. The fix was to remove all
 * post-admission UI clicks. This test prevents anyone from accidentally
 * re-introducing one by scanning the post-admission region of _joinMeeting
 * for `.click(` calls.
 *
 * If you genuinely need a click in this region, see the comment block at the
 * top of the region in teams-bot.ts and gate the click behind:
 *   1) a wait for `pc.connectionState === 'connected'`, AND
 *   2) two consecutive isVisible+isEnabled+isStable polls of the locator.
 * Then update the markers below to extend the no-click region.
 */

const TEAMS_BOT_PATH = path.resolve(__dirname, '../../src/teams-bot.ts');

const START_MARKER = 'await this._startAudioCapture();';
// The post-admission region ends at the closing brace of `_joinMeeting` —
// the first brace at exactly 2-space indentation after the start marker
// (inner blocks are indented deeper). Methods AFTER _joinMeeting (e.g. the
// prejoin-readiness and admission polling helpers) legitimately click
// prejoin/lobby buttons and must not be included in this region.
const END_MARKER = /^ {2}\}$/m;

describe('post-admission flow has no toolbar clicks', () => {
  it('contains no .click( calls between _startAudioCapture and the end of _joinMeeting', () => {
    const source = fs.readFileSync(TEAMS_BOT_PATH, 'utf8');
    const startIdx = source.indexOf(START_MARKER);
    expect(startIdx).toBeGreaterThan(0);

    const endMatch = END_MARKER.exec(source.slice(startIdx));
    expect(endMatch).not.toBeNull();
    const endIdx = startIdx + (endMatch?.index ?? 0);

    const region = source.slice(startIdx, endIdx);
    const clickCalls = region.match(/\.click\(/g) ?? [];

    expect(clickCalls, `Found ${clickCalls.length} .click( call(s) in the post-admission region of _joinMeeting. This is the regression class that produces "Action failed → Leaving...". Read the test comment for the safe-click protocol if you genuinely need one.`).toHaveLength(0);
  });

  it('contains no toolbar-button locator() calls in the post-admission region (defense in depth)', () => {
    const source = fs.readFileSync(TEAMS_BOT_PATH, 'utf8');
    const startIdx = source.indexOf(START_MARKER);
    const endMatch = END_MARKER.exec(source.slice(startIdx));
    const endIdx = startIdx + (endMatch?.index ?? 0);
    const region = source.slice(startIdx, endIdx);

    // Locators for known-fragile post-admission buttons. Adding any of these
    // here is the strongest predictor of the "Action failed" regression.
    const forbidden = [
      'microphone-button',
      'toggle-mute',
      'participants-button',
      'raise-hand',
      'hand-raise',
      'reactions',
    ];
    for (const needle of forbidden) {
      expect(region.includes(needle), `Found "${needle}" in the post-admission region of _joinMeeting — this is one of the historically fragile Teams toolbar buttons. Interacting with it post-admission triggers "Action failed".`).toBe(false);
    }
  });
});
