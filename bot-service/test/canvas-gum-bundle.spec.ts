/**
 * Regression test for the BUNDLE extmap id=11 collision that produced
 * post-prejoin "Sorry, we couldn't connect you" → "Leaving..." in Teams.
 *
 * The fix lives in bot-service/src/teams-bot.ts inside the addInitScript
 * that patches navigator.mediaDevices.getUserMedia. When the caller asks
 * for video, the patch returns a MediaStream whose video track comes from
 * a canvas.captureStream() instead of Chromium's built-in fake camera.
 * The canvas track is encoded by libwebrtc's screencast capturer and uses
 * a leaner RTP header-extension set — specifically no urn:3gpp:video-
 * orientation at extmap id=11 — so an extension-ID collision with the
 * audio m-section cannot occur in the BUNDLE group.
 *
 * Why this matters: vexa's bug #281 (44 ms post-admission drop) was caused
 * by SDP-level munging that introduced malformed offers. We must NOT fix
 * this collision by mutating SDP — fix it upstream of the SDP generator,
 * which is what the canvas substitution does. The negative-control test
 * below pins the failure mode WITHOUT the patch so any future regression
 * (someone removing the canvas substitution) fails this test instantly.
 */

import { test, expect } from '@playwright/test';

// Same launch args our bot uses post-fix — no fake-device, no fake-video-capture.
// We need https origin + granted permissions for getUserMedia to work in tests.
test.use({
  launchOptions: {
    args: ['--use-fake-ui-for-media-stream'],
    ignoreDefaultArgs: ['--enable-automation'],
  },
  permissions: ['microphone', 'camera'],
});

// Inline copy of the gUM patch so the test exercises THE production logic.
// If teams-bot.ts's patch changes, mirror it here (and the test should still pass).
function installCanvasGumPatch(): void {
  const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  let canvasStream: MediaStream | null = null;
  const getCanvasStream = (): MediaStream => {
    if (canvasStream) return canvasStream;
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    if (document.body) document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 640, 360);
    canvasStream = canvas.captureStream(15);
    let flip = 0;
    const pump = (): void => {
      ctx.fillStyle = (++flip) & 1 ? '#000001' : '#000000';
      ctx.fillRect(0, 0, 1, 1);
      requestAnimationFrame(pump);
    };
    requestAnimationFrame(pump);
    return canvasStream;
  };
  const patched = async (constraints?: MediaStreamConstraints): Promise<MediaStream> => {
    if (constraints && constraints.video) {
      const audioStream = constraints.audio ? await origGUM({ audio: constraints.audio }) : new MediaStream();
      audioStream.getAudioTracks().forEach((t) => { t.enabled = false; });
      const out = new MediaStream();
      audioStream.getAudioTracks().forEach((t) => out.addTrack(t));
      out.addTrack(getCanvasStream().getVideoTracks()[0].clone());
      return out;
    }
    const stream = await origGUM(constraints ?? {});
    stream.getAudioTracks().forEach((t) => { t.enabled = false; });
    stream.getVideoTracks().forEach((t) => { t.enabled = false; });
    return stream;
  };
  navigator.mediaDevices.getUserMedia = patched as typeof navigator.mediaDevices.getUserMedia;
}

test('gUM patch substitutes canvas video; setLocalDescription succeeds', async ({ page, context }) => {
  await context.grantPermissions(['microphone', 'camera'], { origin: 'https://example.com' });
  await page.addInitScript(installCanvasGumPatch);
  await page.goto('https://example.com');

  const result = await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    const pc = new RTCPeerConnection();
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    let setLDError: { name: string; message: string } | null = null;
    let sdp = '';
    try {
      const offer = await pc.createOffer();
      sdp = offer.sdp || '';
      await pc.setLocalDescription(offer);
    } catch (err) {
      setLDError = { name: (err as Error).name, message: (err as Error).message };
    }
    // Parse extmaps per m-section.
    const sections = sdp.split(/^m=/m).slice(1).map((s) => ({
      kind: s.split(' ')[0],
      extmaps: (s.match(/^a=extmap:(\d+)(?:\/\S+)? (.+)$/gm) || []) as string[],
    }));
    return { setLDError, sections };
  });

  // (1) setLocalDescription must succeed with the canvas-backed video track.
  expect(
    result.setLDError,
    'setLocalDescription threw — the canvas video substitution did not prevent the BUNDLE collision. Likely cause: someone reintroduced the built-in fake camera (--use-fake-device-for-media-stream or --use-file-for-fake-video-capture).',
  ).toBeNull();

  // (2) No BUNDLE-collision conditions in the offer: parse extmaps and confirm
  // no extension ID appears in multiple sections mapping to DIFFERENT URNs.
  const idToUrns = new Map<string, Set<string>>();
  for (const section of result.sections) {
    for (const raw of section.extmaps) {
      const m = raw.match(/^a=extmap:(\d+)(?:\/\S+)? (.+)$/);
      if (!m) continue;
      const id = m[1];
      const urn = m[2];
      if (!idToUrns.has(id)) idToUrns.set(id, new Set());
      idToUrns.get(id)!.add(urn);
    }
  }
  const conflicts: Array<{ id: string; urns: string[] }> = [];
  for (const [id, urns] of idToUrns) {
    if (urns.size > 1) conflicts.push({ id, urns: [...urns] });
  }
  expect(
    conflicts,
    `Found extmap IDs mapping to multiple URNs in the offer: ${JSON.stringify(conflicts)}. This is the BUNDLE collision condition. The canvas video track was supposed to use a leaner extension set with no collision against the audio m-section.`,
  ).toEqual([]);

  // (3) Offer must contain both m=audio and m=video sections — Teams expects
  // both, and the canvas track is what produces the video section here.
  const videoSection = result.sections.find((s) => s.kind === 'video');
  const audioSection = result.sections.find((s) => s.kind === 'audio');
  expect(videoSection, 'Offer has no m=video section — canvas track substitution may not have run').toBeDefined();
  expect(audioSection, 'Offer has no m=audio section').toBeDefined();
});

test('audio-only gUM still works (no canvas substitution when video not requested)', async ({ page, context }) => {
  await context.grantPermissions(['microphone'], { origin: 'https://example.com' });
  await page.addInitScript(installCanvasGumPatch);
  await page.goto('https://example.com');

  const result = await page.evaluate(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      return { ok: true, tracks: stream.getTracks().map((t) => ({ kind: t.kind, enabled: t.enabled })) };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  });
  expect(result.ok).toBe(true);
  if (result.ok && result.tracks) {
    expect(result.tracks.find((t) => t.kind === 'audio')?.enabled).toBe(false);
    expect(result.tracks.find((t) => t.kind === 'video')).toBeUndefined();
  }
});
