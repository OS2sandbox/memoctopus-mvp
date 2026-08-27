import { describe, it, expect } from 'vitest';
import { validateTeamsUrl } from '../../src/lib/url-validator';

describe('validateTeamsUrl', () => {
  it('accepts teams.microsoft.com URLs', () => {
    const result = validateTeamsUrl('https://teams.microsoft.com/l/meetup-join/abc');
    expect(result.ok).toBe(true);
  });

  it('accepts teams.live.com URLs', () => {
    const result = validateTeamsUrl('https://teams.live.com/meet/12345');
    expect(result.ok).toBe(true);
  });

  it('rejects non-Teams hosts with wrong-host reason', () => {
    const result = validateTeamsUrl('https://zoom.us/j/12345');
    expect(result).toEqual({ ok: false, reason: 'wrong-host' });
  });

  it('rejects subdomain spoofing (teams.microsoft.com.evil.com)', () => {
    const result = validateTeamsUrl('https://teams.microsoft.com.evil.com/foo');
    expect(result).toEqual({ ok: false, reason: 'wrong-host' });
  });

  it('rejects pre-host spoofing (evil.teams.microsoft.com)', () => {
    const result = validateTeamsUrl('https://evil.teams.microsoft.com/foo');
    expect(result).toEqual({ ok: false, reason: 'wrong-host' });
  });

  it('rejects malformed URLs with invalid-url reason', () => {
    expect(validateTeamsUrl('not a url')).toEqual({ ok: false, reason: 'invalid-url' });
    expect(validateTeamsUrl('')).toEqual({ ok: false, reason: 'invalid-url' });
  });

  it('rejects non-string inputs', () => {
    expect(validateTeamsUrl(null)).toEqual({ ok: false, reason: 'invalid-url' });
    expect(validateTeamsUrl(undefined)).toEqual({ ok: false, reason: 'invalid-url' });
    expect(validateTeamsUrl(42)).toEqual({ ok: false, reason: 'invalid-url' });
    expect(validateTeamsUrl({})).toEqual({ ok: false, reason: 'invalid-url' });
  });
});
