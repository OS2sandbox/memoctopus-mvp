import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getAccessToken = vi.fn();

vi.mock('@/lib/auth', () => ({
  auth: { api: { getAccessToken: (...args: unknown[]) => getAccessToken(...args) } },
}));

import {
  GRAPH_SCOPES,
  GraphError,
  graphOrigin,
  getGraphAccessToken,
  hasGraphScopes,
  graphFetch,
  graphJson,
  isRetryableStatus,
  parseRetryAfter,
} from './graph-client';

const ALL_SCOPES = GRAPH_SCOPES.join(' ');

function okToken(scope: string | string[] = ALL_SCOPES) {
  getAccessToken.mockResolvedValue({
    accessToken: 'tok-123',
    scopes: Array.isArray(scope) ? scope : scope.split(' '),
  });
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getAccessToken.mockReset();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  delete process.env.GRAPH_BASE_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GRAPH_BASE_URL;
});

describe('graphOrigin', () => {
  it('defaults to the v1.0 Graph endpoint', () => {
    expect(graphOrigin()).toBe('https://graph.microsoft.com/v1.0');
  });

  it('honours GRAPH_BASE_URL and trims a trailing slash', () => {
    process.env.GRAPH_BASE_URL = 'http://localhost:9999/v1.0/';
    expect(graphOrigin()).toBe('http://localhost:9999/v1.0');
  });

  it('treats an empty GRAPH_BASE_URL as unset (docker-compose passes ${VAR:-})', () => {
    process.env.GRAPH_BASE_URL = '   ';
    expect(graphOrigin()).toBe('https://graph.microsoft.com/v1.0');
  });
});

describe('getGraphAccessToken', () => {
  it('asks better-auth for the microsoft account token (which refreshes when expired)', async () => {
    okToken();
    await expect(getGraphAccessToken('user-123')).resolves.toBe('tok-123');
    expect(getAccessToken).toHaveBeenCalledWith({
      body: { providerId: 'microsoft', userId: 'user-123' },
    });
  });

  it('accepts a comma-joined scope string, as better-auth stores it', async () => {
    getAccessToken.mockResolvedValue({
      accessToken: 'tok-123',
      scopes: [GRAPH_SCOPES.join(',')],
    });
    await expect(getGraphAccessToken('u')).resolves.toBe('tok-123');
  });

  it('accepts fully qualified, differently cased scope URIs', async () => {
    okToken(
      GRAPH_SCOPES.map((s) =>
        s.includes('.') ? `https://graph.microsoft.com/${s.toLowerCase()}` : s,
      ),
    );
    await expect(getGraphAccessToken('u')).resolves.toBe('tok-123');
  });

  it('throws reauth_required when no microsoft account is linked', async () => {
    getAccessToken.mockRejectedValue(new Error('ACCOUNT_NOT_FOUND'));
    const err = await getGraphAccessToken('u').catch((e) => e);
    expect(err).toBeInstanceOf(GraphError);
    expect(err.code).toBe('reauth_required');
    expect(err.status).toBe(401);
  });

  it('throws reauth_required when the refresh yields no access token', async () => {
    getAccessToken.mockResolvedValue({ accessToken: null, scopes: [] });
    await expect(getGraphAccessToken('u')).rejects.toMatchObject({ code: 'reauth_required' });
  });

  it('throws consent_required listing the missing Graph scopes', async () => {
    okToken('openid profile email offline_access User.Read');
    const err = await getGraphAccessToken('u').catch((e) => e);
    expect(err.code).toBe('consent_required');
    expect(err.status).toBe(403);
    expect(err.missingScopes).toEqual([
      'OnlineMeetings.ReadWrite',
      'OnlineMeetingTranscript.Read.All',
      'OnlineMeetingRecording.Read.All',
    ]);
  });

  it('does not treat missing OIDC scopes as a consent gap', async () => {
    okToken(
      'OnlineMeetings.ReadWrite OnlineMeetingTranscript.Read.All OnlineMeetingRecording.Read.All User.Read',
    );
    await expect(getGraphAccessToken('u')).resolves.toBe('tok-123');
  });
});

describe('hasGraphScopes', () => {
  it('reports ok for a fully consented account', async () => {
    okToken();
    await expect(hasGraphScopes('u')).resolves.toEqual({ ok: true, missing: [] });
  });

  it('reports the gap for an account that predates the Graph scopes', async () => {
    okToken('openid profile email User.Read offline_access');
    await expect(hasGraphScopes('u')).resolves.toEqual({
      ok: false,
      missing: [
        'OnlineMeetings.ReadWrite',
        'OnlineMeetingTranscript.Read.All',
        'OnlineMeetingRecording.Read.All',
      ],
    });
  });
});

describe('graphFetch', () => {
  it('resolves relative paths against the Graph base and adds the bearer', async () => {
    okToken();
    fetchMock.mockResolvedValue(jsonResponse(200, { value: [] }));

    await graphFetch('u', '/me/onlineMeetings');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://graph.microsoft.com/v1.0/me/onlineMeetings');
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer tok-123');
  });

  it('keeps caller headers and method', async () => {
    okToken();
    fetchMock.mockResolvedValue(jsonResponse(200, {}));

    await graphFetch('u', 'me/onlineMeetings/1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('PATCH');
    expect((init.headers as Headers).get('Content-Type')).toBe('application/json');
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer tok-123');
  });

  it('adds the bearer to absolute Graph URLs (@odata.nextLink)', async () => {
    okToken();
    fetchMock.mockResolvedValue(jsonResponse(200, {}));

    await graphFetch('u', 'https://graph.microsoft.com/v1.0/me/events?$skiptoken=abc');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://graph.microsoft.com/v1.0/me/events?$skiptoken=abc');
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer tok-123');
  });

  it('never leaks the bearer to a non-Graph absolute URL', async () => {
    okToken();
    fetchMock.mockResolvedValue(new Response('binary', { status: 200 }));

    await graphFetch('u', 'https://evil.example.com/blob/recording.mp4');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://evil.example.com/blob/recording.mp4');
    expect((init.headers as Headers).get('Authorization')).toBeNull();
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('returns the raw Response on 2xx so callers can stream the body', async () => {
    okToken();
    const res = new Response('vtt-body', { status: 200 });
    fetchMock.mockResolvedValue(res);
    await expect(graphFetch('u', '/x')).resolves.toBe(res);
  });

  it('maps 401 to reauth_required', async () => {
    okToken();
    fetchMock.mockResolvedValue(jsonResponse(401, { error: { code: 'InvalidAuthenticationToken' } }));
    const err = await graphFetch('u', '/x').catch((e) => e);
    expect(err).toBeInstanceOf(GraphError);
    expect(err.code).toBe('reauth_required');
    expect(err.status).toBe(401);
  });

  it('maps 403 GraphAccessToTranscriptsDisabled to transcripts_disabled', async () => {
    okToken();
    fetchMock.mockResolvedValue(
      jsonResponse(403, {
        error: {
          code: 'Forbidden',
          message: 'Transcripts are disabled',
          innerError: { code: 'GraphAccessToTranscriptsDisabled' },
        },
      }),
    );
    const err = await graphFetch('u', '/x').catch((e) => e);
    expect(err.code).toBe('transcripts_disabled');
    expect(err.status).toBe(403);
  });

  it('maps other 403s to forbidden', async () => {
    okToken();
    fetchMock.mockResolvedValue(
      jsonResponse(403, { error: { code: 'AccessDenied', message: 'nope' } }),
    );
    const err = await graphFetch('u', '/x').catch((e) => e);
    expect(err.code).toBe('forbidden');
    expect(err.status).toBe(403);
  });

  it('maps 404 to not_found', async () => {
    okToken();
    fetchMock.mockResolvedValue(jsonResponse(404, { error: { code: 'ItemNotFound' } }));
    const err = await graphFetch('u', '/x').catch((e) => e);
    expect(err.code).toBe('not_found');
    expect(err.status).toBe(404);
  });

  it('maps anything else to http, keeping the status', async () => {
    okToken();
    fetchMock.mockResolvedValue(jsonResponse(429, { error: { message: 'slow down' } }));
    const err = await graphFetch('u', '/x').catch((e) => e);
    expect(err.code).toBe('http');
    expect(err.status).toBe(429);
    expect(err.message).toContain('429');
    // Graph throttles the transcript/recording collections routinely: this has
    // to read as "not yet", never as "this meeting failed".
    expect(err.retryable).toBe(true);
  });

  it('reads Retry-After off a throttled response', async () => {
    okToken();
    fetchMock.mockResolvedValue(
      new Response('{}', { status: 429, headers: { 'Retry-After': '30', 'content-type': 'application/json' } }),
    );
    const err = await graphFetch('u', '/x').catch((e) => e);
    expect(err.retryAfterMs).toBe(30_000);
  });

  it('marks a 403 as non-retryable', async () => {
    okToken();
    fetchMock.mockResolvedValue(jsonResponse(403, { error: { code: 'AccessDenied' } }));
    const err = await graphFetch('u', '/x').catch((e) => e);
    expect(err.retryable).toBe(false);
  });

  it('survives a non-JSON error body', async () => {
    okToken();
    fetchMock.mockResolvedValue(new Response('<html>gateway</html>', { status: 502 }));
    const err = await graphFetch('u', '/x').catch((e) => e);
    expect(err.code).toBe('http');
    expect(err.status).toBe(502);
  });

  it('propagates the consent gap before making a request', async () => {
    okToken('openid profile email offline_access');
    await expect(graphFetch('u', '/x')).rejects.toMatchObject({ code: 'consent_required' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('graphJson', () => {
  it('parses the body of a successful response', async () => {
    okToken();
    fetchMock.mockResolvedValue(jsonResponse(200, { value: [{ id: 'm1' }] }));
    await expect(graphJson<{ value: { id: string }[] }>('u', '/me/onlineMeetings')).resolves.toEqual(
      { value: [{ id: 'm1' }] },
    );
  });

  it('surfaces the typed error from graphFetch', async () => {
    okToken();
    fetchMock.mockResolvedValue(jsonResponse(404, { error: {} }));
    await expect(graphJson('u', '/x')).rejects.toBeInstanceOf(GraphError);
  });
});

describe('retry classification', () => {
  it('treats timeouts, throttling and 5xx as retryable', () => {
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
  });

  it('treats client errors and success as final', () => {
    for (const status of [200, 400, 401, 403, 404, 409]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });

  it('parses Retry-After as seconds or as an HTTP date', () => {
    const now = Date.parse('2026-09-08T12:00:00Z');
    expect(parseRetryAfter('120', now)).toBe(120_000);
    expect(parseRetryAfter('Tue, 08 Sep 2026 12:01:00 GMT', now)).toBe(60_000);
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter('  ', now)).toBeNull();
    expect(parseRetryAfter('nonsense', now)).toBeNull();
    // A date already in the past is not a negative wait.
    expect(parseRetryAfter('Tue, 08 Sep 2026 11:59:00 GMT', now)).toBe(0);
  });

  it('lets a caller override the classification explicitly', () => {
    expect(new GraphError('http', 'x', { status: 400, retryable: true }).retryable).toBe(true);
  });
});
