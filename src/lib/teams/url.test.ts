import { describe, it, expect } from 'vitest';
import { validateTeamsUrl, extractJoinContext } from './url';

const JOIN_URL =
  'https://teams.microsoft.com/l/meetup-join/19%3ameeting_NjY4ZTU%40thread.v2/0' +
  '?context=%7b%22Tid%22%3a%2272f988bf-1111-2222-3333-2d7cd011db47%22%2c%22Oid%22%3a%22a1b2c3d4-5566-7788-99aa-bbccddeeff00%22%7d';

describe('validateTeamsUrl', () => {
  it('accepts teams.microsoft.com URLs and returns the normalized href', () => {
    expect(validateTeamsUrl('https://teams.microsoft.com/l/meetup-join/abc')).toEqual({
      ok: true,
      url: 'https://teams.microsoft.com/l/meetup-join/abc',
    });
  });

  it('accepts teams.live.com URLs', () => {
    expect(validateTeamsUrl('https://teams.live.com/meet/12345')).toEqual({
      ok: true,
      url: 'https://teams.live.com/meet/12345',
    });
  });

  it('trims surrounding whitespace before parsing', () => {
    const result = validateTeamsUrl('  https://teams.microsoft.com/l/meetup-join/abc \n');
    expect(result).toEqual({ ok: true, url: 'https://teams.microsoft.com/l/meetup-join/abc' });
  });

  it('preserves the query string of a real join link', () => {
    const result = validateTeamsUrl(JOIN_URL);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url).toContain('context=');
  });

  it('rejects non-Teams hosts with wrong-host', () => {
    expect(validateTeamsUrl('https://zoom.us/j/12345')).toEqual({ ok: false, reason: 'wrong-host' });
  });

  it('rejects suffix spoofing (teams.microsoft.com.evil.com)', () => {
    expect(validateTeamsUrl('https://teams.microsoft.com.evil.com/foo')).toEqual({
      ok: false,
      reason: 'wrong-host',
    });
  });

  it('rejects subdomain spoofing (evil.teams.microsoft.com)', () => {
    expect(validateTeamsUrl('https://evil.teams.microsoft.com/foo')).toEqual({
      ok: false,
      reason: 'wrong-host',
    });
  });

  it('rejects non-https schemes', () => {
    expect(validateTeamsUrl('http://teams.microsoft.com/l/meetup-join/abc')).toEqual({
      ok: false,
      reason: 'invalid-url',
    });
    expect(validateTeamsUrl('javascript:alert(1)')).toEqual({ ok: false, reason: 'invalid-url' });
  });

  it('rejects malformed and empty input', () => {
    expect(validateTeamsUrl('not a url')).toEqual({ ok: false, reason: 'invalid-url' });
    expect(validateTeamsUrl('')).toEqual({ ok: false, reason: 'invalid-url' });
    expect(validateTeamsUrl('   ')).toEqual({ ok: false, reason: 'invalid-url' });
  });

  it('rejects non-string input defensively', () => {
    expect(validateTeamsUrl(null as unknown as string)).toEqual({ ok: false, reason: 'invalid-url' });
    expect(validateTeamsUrl(42 as unknown as string)).toEqual({ ok: false, reason: 'invalid-url' });
  });
});

describe('validateTeamsUrl — Defender Safe Links', () => {
  // A tenant with Safe Links on rewrites links in mail, so this is the form most
  // users can actually copy out of their own invite.
  const wrap = (inner: string, host = 'eur03.safelinks.protection.outlook.com', path = '/') =>
    `https://${host}${path}?url=${encodeURIComponent(inner)}&data=05%7C02%7C&sdata=xYz%3D&reserved=0`;

  it('unwraps a wrapped join link and returns the inner URL verbatim', () => {
    // Byte-identical matters: this string goes into Graph's exact-match
    // $filter=JoinWebUrl eq '...', so re-encoding it would break the lookup.
    expect(validateTeamsUrl(wrap(JOIN_URL))).toEqual({ ok: true, url: JOIN_URL });
  });

  it('unwraps the /ap/ variant Office apps produce', () => {
    expect(validateTeamsUrl(wrap(JOIN_URL, 'nam02.safelinks.protection.outlook.com', '/ap/t-59584e83/'))).toEqual({
      ok: true,
      url: JOIN_URL,
    });
  });

  it('unwraps the apex host as well as a regional one', () => {
    expect(validateTeamsUrl(wrap(JOIN_URL, 'safelinks.protection.outlook.com'))).toEqual({
      ok: true,
      url: JOIN_URL,
    });
  });

  it('unwraps a teams.live.com link', () => {
    expect(validateTeamsUrl(wrap('https://teams.live.com/meet/12345'))).toEqual({
      ok: true,
      url: 'https://teams.live.com/meet/12345',
    });
  });

  it('unwraps nesting up to the depth cap', () => {
    expect(validateTeamsUrl(wrap(wrap(JOIN_URL)))).toEqual({ ok: true, url: JOIN_URL });
  });

  it('gives up rather than unwrapping unboundedly', () => {
    const tooDeep = wrap(wrap(wrap(wrap(JOIN_URL))));
    expect(validateTeamsUrl(tooDeep)).toEqual({ ok: false, reason: 'wrong-host' });
  });

  // Unwrapping must widen only which inputs are accepted, never which
  // destinations — the inner URL faces the same checks as a pasted one.
  it('rejects a wrapper around a non-Teams host', () => {
    expect(validateTeamsUrl(wrap('https://evil.com/steal'))).toEqual({ ok: false, reason: 'wrong-host' });
  });

  it('rejects a wrapper around a spoofed Teams host', () => {
    expect(validateTeamsUrl(wrap('https://teams.microsoft.com.evil.com/l/meetup-join/abc'))).toEqual({
      ok: false,
      reason: 'wrong-host',
    });
    expect(validateTeamsUrl(wrap('https://evil.teams.microsoft.com/l/meetup-join/abc'))).toEqual({
      ok: false,
      reason: 'wrong-host',
    });
  });

  it('rejects a wrapper around a non-https inner link', () => {
    expect(validateTeamsUrl(wrap('http://teams.microsoft.com/l/meetup-join/abc'))).toEqual({
      ok: false,
      reason: 'invalid-url',
    });
  });

  it('rejects a wrapper with no url parameter', () => {
    expect(validateTeamsUrl('https://eur03.safelinks.protection.outlook.com/?data=05')).toEqual({
      ok: false,
      reason: 'invalid-url',
    });
  });

  it('rejects a wrapper whose url parameter is not a URL', () => {
    expect(validateTeamsUrl('https://eur03.safelinks.protection.outlook.com/?url=not%20a%20url')).toEqual({
      ok: false,
      reason: 'invalid-url',
    });
  });

  // Hosts that merely resemble the wrapper must not be treated as one.
  it('does not treat a lookalike wrapper host as Safe Links', () => {
    expect(validateTeamsUrl(wrap(JOIN_URL, 'evilsafelinks.protection.outlook.com'))).toEqual({
      ok: false,
      reason: 'wrong-host',
    });
    expect(validateTeamsUrl(wrap(JOIN_URL, 'safelinks.protection.outlook.com.evil.com'))).toEqual({
      ok: false,
      reason: 'wrong-host',
    });
  });
});

describe('extractJoinContext', () => {
  it('extracts thread id, tenant id and organizer oid from a full join link', () => {
    expect(extractJoinContext(JOIN_URL)).toEqual({
      threadId: '19:meeting_NjY4ZTU@thread.v2',
      tenantId: '72f988bf-1111-2222-3333-2d7cd011db47',
      organizerOid: 'a1b2c3d4-5566-7788-99aa-bbccddeeff00',
    });
  });

  it('handles an already-decoded thread segment', () => {
    const ctx = extractJoinContext(
      'https://teams.microsoft.com/l/meetup-join/19:meeting_ABC@thread.v2/0',
    );
    expect(ctx.threadId).toBe('19:meeting_ABC@thread.v2');
  });

  it('returns only what is present when the context param is missing', () => {
    expect(
      extractJoinContext('https://teams.microsoft.com/l/meetup-join/19%3ameeting_ABC%40thread.v2/0'),
    ).toEqual({ threadId: '19:meeting_ABC@thread.v2' });
  });

  it('accepts lowercase context keys', () => {
    const ctx = extractJoinContext(
      'https://teams.microsoft.com/l/meetup-join/19%3ameeting_ABC%40thread.v2/0?context=' +
        encodeURIComponent(JSON.stringify({ tid: 'tenant-1', oid: 'organizer-1' })),
    );
    expect(ctx).toEqual({
      threadId: '19:meeting_ABC@thread.v2',
      tenantId: 'tenant-1',
      organizerOid: 'organizer-1',
    });
  });

  it('returns an empty object for short links with no ids', () => {
    expect(extractJoinContext('https://teams.live.com/meet/12345')).toEqual({});
  });

  it('never throws on malformed input', () => {
    expect(extractJoinContext('not a url')).toEqual({});
    expect(extractJoinContext('')).toEqual({});
    expect(extractJoinContext(null as unknown as string)).toEqual({});
    expect(
      extractJoinContext('https://teams.microsoft.com/l/meetup-join/19%3ameeting_A%40thread.v2/0?context=%7bbroken'),
    ).toEqual({ threadId: '19:meeting_A@thread.v2' });
  });

  it('ignores a path segment that is not a thread id', () => {
    expect(extractJoinContext('https://teams.microsoft.com/l/meetup-join/abc')).toEqual({});
  });
});
