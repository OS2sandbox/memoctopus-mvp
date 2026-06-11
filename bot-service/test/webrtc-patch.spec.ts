/**
 * Regression tests for the WebRTC patch injected by the Teams bot.
 *
 * The patch's responsibilities are:
 *   1. Listen for remote audio tracks → mirror to <audio data-bot-captured>
 *      elements and register the receiving PC in window.__botAudioPcs.
 *   2. Swallow DOM-Event-shaped Promise rejections (the {"isTrusted":true}
 *      pattern Teams produces) so they don't trigger Teams' own auto-leave.
 *
 * Explicitly NOT tested (because it's intentionally NOT done by the patch):
 *   - Video addTrack/addTransceiver redirect. That pattern produced
 *     InvalidAccessError every time Teams later invoked a method on the
 *     foreign-PC sender, surfacing as "Action failed → Leaving..." or
 *     unhandled-rejection cascades. The BUNDLE id=11 collision the redirect
 *     was preventing is now handled upstream by the
 *     `--use-file-for-fake-video-capture=/dev/null` Chromium launch flag.
 */

import { test, expect } from '@playwright/test';
import { installWebRTCPatch } from '../src/webrtc-patch';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installWebRTCPatch);
  await page.goto('data:text/html,<html><body></body></html>');
});

// ─── Video senders stay on the real PC (no foreign-sender bug) ───────────────

test('addTrack(video) creates a sender on the real PC — no foreign-PC redirect', async ({ page }) => {
  // The fix for the "Action failed → Leaving..." regression: video senders
  // must live on the same PC Teams is using, so subsequent Teams operations
  // (pc.removeTrack, pc.getSenders) do not throw InvalidAccessError.
  const senderOnRealPC = await page.evaluate(() => {
    const pc = new RTCPeerConnection();
    const canvas = document.createElement('canvas');
    const stream = canvas.captureStream(0);
    const [videoTrack] = stream.getVideoTracks();
    const sender = pc.addTrack(videoTrack, stream);
    return {
      senderInGetSenders: pc.getSenders().includes(sender),
      videoSenderCount: pc.getSenders().filter((s) => s.track?.kind === 'video').length,
    };
  });
  expect(senderOnRealPC.senderInGetSenders).toBe(true);
  expect(senderOnRealPC.videoSenderCount).toBe(1);
});

test('pc.removeTrack of an addTrack-returned video sender does NOT throw', async ({ page }) => {
  // Reproduces the exact post-admission failure mode Teams was hitting.
  const result = await page.evaluate(() => {
    const pc = new RTCPeerConnection();
    const canvas = document.createElement('canvas');
    const stream = canvas.captureStream(0);
    const [videoTrack] = stream.getVideoTracks();
    const sender = pc.addTrack(videoTrack, stream);
    try {
      pc.removeTrack(sender);
      return { threw: false };
    } catch (err) {
      return { threw: true, name: (err as Error).name, message: (err as Error).message };
    }
  });
  expect(result.threw, `pc.removeTrack(videoSender) threw — this is the InvalidAccessError that produced "Leaving..." indefinitely. Either the foreign-sender redirect crept back in, or the patch installation is broken.`).toBe(false);
});

test('static RTCPeerConnection methods (generateCertificate) are inherited by the patched constructor', async ({ page }) => {
  // Teams calls RTCPeerConnection.generateCertificate(...) early in its WebRTC
  // setup. If the patched constructor doesn't inherit statics from the original
  // (via Object.setPrototypeOf), the call lands on `undefined(...)` and throws
  // TypeError, which Teams catches and re-rejects as the {"isTrusted":true}
  // Event that triggers "Leaving..." indefinitely. This test asserts the static
  // factory is callable through the patched global so the regression cannot
  // come back silently.
  const result = await page.evaluate(async () => {
    try {
      const cert = await RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' } as AlgorithmIdentifier);
      return { ok: true, hasCert: !!cert };
    } catch (err) {
      return { ok: false, name: (err as Error).name, message: (err as Error).message };
    }
  });
  expect(result.ok, `RTCPeerConnection.generateCertificate threw — patched constructor is missing static inheritance. Add Object.setPrototypeOf(PatchedRTC, OrigRTC).`).toBe(true);
  expect(result.hasCert).toBe(true);
});

test('addTransceiver("video") creates a transceiver on the real PC', async ({ page }) => {
  const count = await page.evaluate(() => {
    const pc = new RTCPeerConnection();
    pc.addTransceiver('video');
    return pc.getTransceivers().filter((t) => t.receiver.track.kind === 'video').length;
  });
  expect(count).toBe(1);
});

// ─── Audio pass-through ─────────────────────────────────────────────────────

test('addTrack(audio) keeps audio sender on the real PC', async ({ page }) => {
  const count = await page.evaluate(() => {
    const pc = new RTCPeerConnection();
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    const [audioTrack] = dest.stream.getAudioTracks();
    pc.addTrack(audioTrack, dest.stream);
    return pc.getSenders().filter((s) => s.track?.kind === 'audio').length;
  });
  expect(count).toBe(1);
});

test('addTransceiver("audio") keeps audio transceiver on the real PC', async ({ page }) => {
  const count = await page.evaluate(() => {
    const pc = new RTCPeerConnection();
    pc.addTransceiver('audio');
    return pc.getTransceivers().filter((t) => t.receiver.track.kind === 'audio').length;
  });
  expect(count).toBe(1);
});

// ─── Remote audio loopback — the audio-capture pipeline ─────────────────────

test('remote audio loopback: captures audio element and registers PC', async ({ page }) => {
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

// ─── unhandledrejection swallower ───────────────────────────────────────────

test('Event-typed Promise rejections do NOT surface as unhandledrejection events', async ({ page }) => {
  // Simulates Teams' habit of converting a DOM Event into a Promise rejection.
  // The patch's preventDefault on Event-shaped rejections suppresses the
  // browser-level "unhandled" report and prevents Teams' own onunhandledrejection
  // handler from firing the leave-the-call cascade.
  const result = await page.evaluate(async () => {
    let sawUnhandled = false;
    const onUnhandled = (ev: PromiseRejectionEvent) => {
      // After the patch's listener calls preventDefault, defaultPrevented is true.
      sawUnhandled = !ev.defaultPrevented;
    };
    window.addEventListener('unhandledrejection', onUnhandled);

    const fakeEvent = new Event('error');
    Promise.reject(fakeEvent);
    // Give the microtask + task queue time to process.
    await new Promise((r) => setTimeout(r, 100));

    window.removeEventListener('unhandledrejection', onUnhandled);
    return { sawUnhandled };
  });
  expect(result.sawUnhandled).toBe(false);
});

test('Non-Event Promise rejections (real errors) are still reported as unhandled', async ({ page }) => {
  // Defensive: we must NOT silence real bugs. Only Event-shaped rejections
  // get swallowed; thrown Errors with stack traces still surface so they
  // can be debugged.
  const result = await page.evaluate(async () => {
    let sawUnhandled = false;
    const onUnhandled = (ev: PromiseRejectionEvent) => {
      sawUnhandled = !ev.defaultPrevented;
    };
    window.addEventListener('unhandledrejection', onUnhandled);

    Promise.reject(new Error('genuine error'));
    await new Promise((r) => setTimeout(r, 100));

    window.removeEventListener('unhandledrejection', onUnhandled);
    return { sawUnhandled };
  });
  expect(result.sawUnhandled).toBe(true);
});

// ─── BUNDLE extmap collision repair (setLocalDescription hook) ───────────────

test('setLocalDescription repairs a BUNDLE extmap id collision instead of throwing', async ({ page }) => {
  // Reproduces the exact failure: a real Chromium offer is munged so the audio
  // and video m-sections both claim extmap id=11 for DIFFERENT URNs. Without
  // the patch, setLocalDescription throws InvalidAccessError ("A BUNDLE group
  // contains a codec collision for header extension id=11"). With the patch's
  // setLocalDescription hook, the duplicate line is dropped and the offer
  // applies cleanly. This is the bot-doesn't-join → "Sorry, we couldn't
  // connect you" → "Leaving..." regression.
  const result = await page.evaluate(async () => {
    const pc = new RTCPeerConnection();
    pc.addTransceiver('audio', { direction: 'sendrecv' });
    pc.addTransceiver('video', { direction: 'sendrecv' });
    const offer = await pc.createOffer();
    let sdp = offer.sdp || '';

    // Force a collision: ensure the audio section has extmap:11 → audio-level,
    // and the video section has extmap:11 → a DIFFERENT urn. Chromium already
    // puts repaired-rtp-stream-id at 11 in video; we add an audio id=11 with a
    // different URN so the two sections collide.
    const audioIdx = sdp.indexOf('m=audio');
    const videoIdx = sdp.indexOf('m=video');
    const audioHead = sdp.slice(0, videoIdx);
    const videoTail = sdp.slice(videoIdx);
    // Inject an audio extmap:11 right after the m=audio line.
    const injected = audioHead.replace(
      /(m=audio[^\r\n]*\r?\n)/,
      `$1a=extmap:11 urn:ietf:params:rtp-hdrext:ssrc-audio-level\r\n`,
    );
    // Make sure video has an extmap:11 with a different URN.
    const videoWithDup = videoTail.includes('a=extmap:11 ')
      ? videoTail
      : videoTail.replace(
          /(m=video[^\r\n]*\r?\n)/,
          `$1a=extmap:11 urn:3gpp:video-orientation\r\n`,
        );
    sdp = injected + videoWithDup;
    void audioIdx;

    let threw: { name: string; message: string } | null = null;
    try {
      await pc.setLocalDescription({ type: 'offer', sdp });
    } catch (err) {
      threw = { name: (err as Error).name, message: (err as Error).message };
    }
    const applied = pc.localDescription?.sdp || '';
    // Count how many times extmap:11 appears with each URN in the applied SDP.
    const elevenLines = (applied.match(/^a=extmap:11(?:\/\S+)? \S+/gm) || []);
    const distinctUrns = new Set(elevenLines.map((l) => l.split(' ').pop()));
    return { threw, fixedFlag: (window as unknown as Record<string, unknown>).__botFixedSdpCollision === true, distinctUrnCount: distinctUrns.size };
  });

  expect(
    result.threw,
    `setLocalDescription threw — the BUNDLE collision repair hook did not run or did not remove the duplicate extmap. ${JSON.stringify(result.threw)}`,
  ).toBeNull();
  expect(result.fixedFlag, 'the patch did not flag that it repaired a collision').toBe(true);
  // After repair, id=11 maps to at most one URN across the bundle.
  expect(result.distinctUrnCount).toBeLessThanOrEqual(1);
});

test('setLocalDescription leaves a clean offer untouched', async ({ page }) => {
  const result = await page.evaluate(async () => {
    (window as unknown as Record<string, unknown>).__botFixedSdpCollision = false;
    const pc = new RTCPeerConnection();
    pc.addTransceiver('audio', { direction: 'sendrecv' });
    const offer = await pc.createOffer();
    let threw: string | null = null;
    try {
      await pc.setLocalDescription(offer);
    } catch (err) {
      threw = (err as Error).message;
    }
    return { threw, fixedFlag: (window as unknown as Record<string, unknown>).__botFixedSdpCollision === true };
  });
  expect(result.threw).toBeNull();
  // A clean audio-only offer has no collision, so the repair flag stays false.
  expect(result.fixedFlag).toBe(false);
});
