import { describe, it, expect } from 'vitest';
import { dedupeExtmapCollisions } from '../../src/lib/sdp-dedupe';

/**
 * Locks the fix for the BUNDLE "codec collision for header extension id=11"
 * error that drops Teams calls to "Sorry, we couldn't connect you".
 */

function extmapLines(sdp: string): string[] {
  return sdp.split(/\r?\n/).filter((l) => l.startsWith('a=extmap:'));
}

describe('dedupeExtmapCollisions', () => {
  it('drops the colliding extmap line (same id, different URN across sections)', () => {
    const sdp = [
      'v=0',
      'a=group:BUNDLE 0 1',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=mid:0',
      'a=extmap:11 urn:ietf:params:rtp-hdrext:ssrc-audio-level',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=mid:1',
      'a=extmap:11 urn:3gpp:video-orientation',
      '',
    ].join('\r\n');

    const out = dedupeExtmapCollisions(sdp);
    const lines = extmapLines(out);
    // Audio keeps id=11 (first-wins); video's conflicting id=11 is gone.
    expect(lines).toContain('a=extmap:11 urn:ietf:params:rtp-hdrext:ssrc-audio-level');
    expect(lines).not.toContain('a=extmap:11 urn:3gpp:video-orientation');
    // Only the one colliding line was removed.
    expect(lines).toHaveLength(1);
  });

  it('is a no-op when the same id maps to the same URN in both sections (valid BUNDLE)', () => {
    const sdp = [
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=extmap:3 urn:ietf:params:rtp-hdrext:sdes:mid',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=extmap:3 urn:ietf:params:rtp-hdrext:sdes:mid',
      '',
    ].join('\r\n');
    expect(dedupeExtmapCollisions(sdp)).toBe(sdp);
  });

  it('is a no-op when there are no extmap collisions at all', () => {
    const sdp = [
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=extmap:2 urn:3gpp:video-orientation',
      'a=extmap:11 urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id',
      '',
    ].join('\r\n');
    expect(dedupeExtmapCollisions(sdp)).toBe(sdp);
  });

  it('handles extmap lines with a direction attribute (a=extmap:11/sendonly ...)', () => {
    const sdp = [
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=extmap:11 urn:a',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=extmap:11/sendonly urn:b',
      '',
    ].join('\r\n');
    const out = dedupeExtmapCollisions(sdp);
    expect(extmapLines(out)).toEqual(['a=extmap:11 urn:a']);
  });

  it('removes the conflicting id from every later section, not just the second', () => {
    const sdp = [
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=extmap:11 urn:audio-level',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=extmap:11 urn:vo',
      'm=video 9 UDP/TLS/RTP/SAVPF 97',
      'a=extmap:11 urn:vo2',
      '',
    ].join('\r\n');
    const out = dedupeExtmapCollisions(sdp);
    expect(extmapLines(out)).toEqual(['a=extmap:11 urn:audio-level']);
  });

  it('preserves \\n-only line endings', () => {
    const sdp = 'm=audio 9 x\na=extmap:11 urn:a\nm=video 9 y\na=extmap:11 urn:b\n';
    const out = dedupeExtmapCollisions(sdp);
    expect(out).not.toContain('\r\n');
    expect(extmapLines(out)).toEqual(['a=extmap:11 urn:a']);
  });
});
