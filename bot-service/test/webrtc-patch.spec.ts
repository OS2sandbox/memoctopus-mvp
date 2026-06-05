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
// ---------------------------------------------------------------------------

test('remote audio track creates a hidden audio element', async ({ page }) => {
  // Establish a loopback between two PeerConnections in the same page.
  // pc1 sends audio → pc2 receives it and fires the 'track' event.
  // The patched PatchedRTC listener should create an <audio data-bot-captured> element.
  const capturedCount = await page.evaluate(async () => {
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

    // Wait for the track event to fire and the element to be appended.
    await new Promise<void>((resolve) => {
      const check = () => {
        if (document.querySelector('audio[data-bot-captured]')) { resolve(); return; }
        setTimeout(check, 50);
      };
      setTimeout(check, 50);
      // Bail out after 5 s so the test fails cleanly rather than timing out.
      setTimeout(resolve, 5000);
    });

    return document.querySelectorAll('audio[data-bot-captured]').length;
  });

  expect(capturedCount).toBeGreaterThan(0);
});

test('remote audio PC is added to __botAudioPcs', async ({ page }) => {
  const pcCount = await page.evaluate(async () => {
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

    await new Promise<void>((resolve) => {
      const pcs = (window as unknown as Record<string, unknown>).__botAudioPcs as RTCPeerConnection[];
      const check = () => {
        if (pcs.length > 0) { resolve(); return; }
        setTimeout(check, 50);
      };
      setTimeout(check, 50);
      setTimeout(resolve, 5000);
    });

    return ((window as unknown as Record<string, unknown>).__botAudioPcs as RTCPeerConnection[]).length;
  });

  expect(pcCount).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Patch installation guard — detects if addInitScript call is removed
// ---------------------------------------------------------------------------

test('RTCPeerConnection is replaced by the patched version', async ({ page }) => {
  // The patch replaces window.RTCPeerConnection with PatchedRTC.
  // PatchedRTC.prototype === OrigRTC.prototype, so instanceof still works.
  // But the constructor itself is a different function object — we can detect
  // this by checking that addTrack/addTransceiver behave as patched.
  const videoBypassed = await page.evaluate(() => {
    const pc = new RTCPeerConnection();
    const canvas = document.createElement('canvas');
    const stream = canvas.captureStream(0);
    const [videoTrack] = stream.getVideoTracks();
    pc.addTrack(videoTrack, stream);
    // If patch is installed, no video sender on real PC.
    // If patch is absent, there would be exactly 1 video sender.
    return pc.getSenders().filter((s) => s.track?.kind === 'video').length === 0;
  });
  expect(videoBypassed).toBe(true);
});
