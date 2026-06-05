/**
 * Regression tests for the WebRTC patch injected by the Teams bot.
 *
 * The critical invariant: video addTrack/addTransceiver calls must be
 * redirected to a throw-away RTCPeerConnection so the real meeting PC stays
 * audio-only. Chrome's fake device assigns conflicting RTP header extension
 * id=11 to both audio and video m-sections in a BUNDLE group; if video is on
 * the real PC the SDP collision causes an immediate disconnect.
 *
 * These tests run in real Chromium (same browser the bot uses) and import the
 * production installWebRTCPatch function directly, so any code deletion or
 * behavioural change that breaks the redirect will cause a test failure here.
 */

import { test, expect } from '@playwright/test';
import { installWebRTCPatch } from '../src/webrtc-patch';

// Inject the patch and navigate to a blank page before each test.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(installWebRTCPatch);
  await page.goto('data:text/html,<html><body></body></html>');
});

// ---------------------------------------------------------------------------
// Video redirect — the core regression guard
// ---------------------------------------------------------------------------

test('addTrack(video) is redirected: no video sender on the real PC', async ({ page }) => {
  const videoSendersOnRealPC = await page.evaluate(() => {
    const pc = new RTCPeerConnection();
    const canvas = document.createElement('canvas');
    const stream = canvas.captureStream(0);
    const [videoTrack] = stream.getVideoTracks();
    pc.addTrack(videoTrack, stream);
    return pc.getSenders().filter((s) => s.track?.kind === 'video').length;
  });
  expect(videoSendersOnRealPC).toBe(0);
});

test('addTransceiver("video") is redirected: no video transceiver on the real PC', async ({ page }) => {
  const videoTransceiversOnRealPC = await page.evaluate(() => {
    const pc = new RTCPeerConnection();
    pc.addTransceiver('video');
    return pc.getTransceivers().filter((t) => t.receiver.track.kind === 'video').length;
  });
  expect(videoTransceiversOnRealPC).toBe(0);
});

test('addTransceiver(MediaStreamTrack of kind video) is redirected', async ({ page }) => {
  const videoTransceiversOnRealPC = await page.evaluate(() => {
    const pc = new RTCPeerConnection();
    const canvas = document.createElement('canvas');
    const stream = canvas.captureStream(0);
    const [videoTrack] = stream.getVideoTracks();
    pc.addTransceiver(videoTrack);
    return pc.getTransceivers().filter((t) => t.receiver.track.kind === 'video').length;
  });
  expect(videoTransceiversOnRealPC).toBe(0);
});

// ---------------------------------------------------------------------------
// Audio pass-through — ensure the redirect doesn't break audio
// ---------------------------------------------------------------------------

test('addTrack(audio) is NOT redirected: audio sender stays on the real PC', async ({ page }) => {
  const audioSendersOnRealPC = await page.evaluate(() => {
    const pc = new RTCPeerConnection();
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    const [audioTrack] = dest.stream.getAudioTracks();
    pc.addTrack(audioTrack, dest.stream);
    return pc.getSenders().filter((s) => s.track?.kind === 'audio').length;
  });
  expect(audioSendersOnRealPC).toBe(1);
});

test('addTransceiver("audio") is NOT redirected: audio transceiver stays on real PC', async ({ page }) => {
  const audioTransceiversOnRealPC = await page.evaluate(() => {
    const pc = new RTCPeerConnection();
    pc.addTransceiver('audio');
    return pc.getTransceivers().filter((t) => t.receiver.track.kind === 'audio').length;
  });
  expect(audioTransceiversOnRealPC).toBe(1);
});

// ---------------------------------------------------------------------------
// Audio capture — remote audio track creates a [data-bot-captured] element
// and registers the receiving PC in __botAudioPcs
// ---------------------------------------------------------------------------

test('remote audio loopback: captures audio element and registers PC', async ({ page }) => {
  // Establish a loopback between two PeerConnections in the same page.
  // pc1 sends audio → pc2 receives it and fires the 'track' event.
  await page.evaluate(async () => {
    const pc1 = new RTCPeerConnection();
    const pc2 = new RTCPeerConnection();
    pc1.onicecandidate = (e) => { if (e.candidate) pc2.addIceCandidate(e.candidate); };
    pc2.onicecandidate = (e) => { if (e.candidate) pc1.addIceCandidate(e.candidate); };
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    const [audioTrack] = dest.stream.getAudioTracks();
    pc1.addTrack(audioTrack, dest.stream);
    const offer = await pc1.createOffer();
    await pc1.setLocalDescription(offer);
    await pc2.setRemoteDescription(offer);
    const answer = await pc2.createAnswer();
    await pc2.setLocalDescription(answer);
    await pc1.setRemoteDescription(answer);
  });

  // Wait for the 'track' event to fire, the element to be appended, and the
  // PC to be registered — page.waitForFunction throws with a clear timeout
  // error if the condition isn't met, unlike a silent setTimeout bail-out.
  await page.waitForFunction(
    () => document.querySelector('audio[data-bot-captured]') !== null,
    { timeout: 5000 },
  );

  const [capturedCount, pcCount] = await page.evaluate(() => {
    const win = window as unknown as Record<string, unknown>;
    return [
      document.querySelectorAll('audio[data-bot-captured]').length,
      (win.__botAudioPcs as RTCPeerConnection[]).length,
    ];
  });

  expect(capturedCount).toBeGreaterThan(0);
  expect(pcCount).toBeGreaterThan(0);
});
