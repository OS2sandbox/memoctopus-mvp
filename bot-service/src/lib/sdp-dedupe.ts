/**
 * SDP header-extension collision repair.
 *
 * Teams generates a WebRTC offer where the audio and video m-sections are
 * BUNDLEd (a=group:BUNDLE). RFC 8843 requires that within a bundle group the
 * same RTP header-extension id maps to the same extension URN across every
 * m-section. Chromium's offer for an audio+video PeerConnection sometimes
 * assigns id=11 to `urn:ietf:params:rtp-hdrext:ssrc-audio-level` in the audio
 * section and to a different URN (e.g. `urn:3gpp:video-orientation`) in the
 * video section. setLocalDescription then throws:
 *
 *   InvalidAccessError: Failed to set local offer sdp: A BUNDLE group contains
 *   a codec collision for header extension id=11.
 *
 * Teams catches the throw, the call drops to "Sorry, we couldn't connect you",
 * and the bot leaves.
 *
 * This function makes the id→URN mapping consistent with a first-wins rule
 * (the first m-section to claim an id keeps it; later sections that map the
 * same id to a DIFFERENT URN have that one extmap line dropped). Header
 * extensions are optional to negotiate, so dropping the duplicate line is
 * safe — far safer than removing the whole m-section (which breaks rtcp-mux
 * and was the cause of vexa's #281 regression).
 *
 * Lines that map an id to the SAME URN it already has are left untouched —
 * that is exactly what BUNDLE wants.
 *
 * Kept as a pure, exported, unit-tested function. installWebRTCPatch() in
 * webrtc-patch.ts contains an inline copy (it must be self-contained for
 * addInitScript); keep the two in sync — the Playwright e2e test guards the
 * inline version's real behaviour.
 */
export function dedupeExtmapCollisions(sdp: string): string {
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(/\r?\n/);
  const idToUrn = new Map<string, string>();
  const out: string[] = [];
  let dropped = 0;

  for (const line of lines) {
    // a=extmap:<id>[/<direction>] <urn> [extensionattributes]
    const m = line.match(/^a=extmap:(\d+)(?:\/[^ ]+)? (\S+)/);
    if (m) {
      const id = m[1];
      const urn = m[2];
      const existing = idToUrn.get(id);
      if (existing !== undefined && existing !== urn) {
        // Collision: this id already maps to a different URN. Drop this line.
        dropped++;
        continue;
      }
      if (existing === undefined) idToUrn.set(id, urn);
    }
    out.push(line);
  }

  if (dropped === 0) return sdp;
  return out.join(eol);
}
