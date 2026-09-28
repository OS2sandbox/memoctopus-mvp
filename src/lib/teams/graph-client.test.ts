import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getAccessToken = vi.fn();
const refreshToken = vi.fn();

vi.mock('@/lib/auth', () => ({
  auth: {
    api: {
      getAccessToken: (...args: unknown[]) => getAccessToken(...args),
      refreshToken: (...args: unknown[]) => refreshToken(...args),
    },
  },
}));

import {
  GRAPH_DOWNLOAD_TIMEOUT_MS,
  GRAPH_SCOPES,
  GRAPH_TIMEOUT_MS,
  GraphError,
  classifyGraphError,
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

/** The shape better-auth's APIError has: it carries a `body.code` and nothing about the cause. */
function apiError(code: string) {
  return Object.assign(new Error('Failed to get a valid access token'), {
    name: 'APIError',
    status: 'BAD_REQUEST',
    statusCode: 400,
    body: { code, message: 'Failed to get a valid access token' },
  });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  getAccessToken.mockReset();
  refreshToken.mockReset();
  process.env.TEAMS_GRAPH_ENABLED = 'true';
  delete process.env.TEAMS_ARTIFACT_MODE;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  delete process.env.GRAPH_BASE_URL;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.GRAPH_BASE_URL;
  delete process.env.TEAMS_GRAPH_ENABLED;
  delete process.env.TEAMS_ARTIFACT_MODE;
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
    getAccessToken.mockRejectedValue(apiError('ACCOUNT_NOT_FOUND'));
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

describe('getGraphAccessToken — integration disabled', () => {
  // With TEAMS_GRAPH_ENABLED off the scopes were never requested, so a token
  // without them is expected. It must not read as a consent gap: that would tell
  // users to sign in again for scopes we never asked for.
  it('throws disabled, not consent_required, and never asks for a token', async () => {
    delete process.env.TEAMS_GRAPH_ENABLED;
    okToken('openid profile email User.Read offline_access');
    const err = await getGraphAccessToken('u').catch((e) => e);
    expect(err).toBeInstanceOf(GraphError);
    expect(err.code).toBe('disabled');
    expect(err.missingScopes).toBeUndefined();
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('does not call Graph', async () => {
    delete process.env.TEAMS_GRAPH_ENABLED;
    okToken();
    await expect(graphFetch('u', '/me')).rejects.toMatchObject({ code: 'disabled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('getGraphAccessToken — transcript-only', () => {
  const NO_RECORDING = 'OnlineMeetings.ReadWrite OnlineMeetingTranscript.Read.All User.Read';

  it('does not require the recording scope, which is never requested', async () => {
    process.env.TEAMS_ARTIFACT_MODE = 'transcript-only';
    okToken(NO_RECORDING);
    await expect(getGraphAccessToken('u')).resolves.toBe('tok-123');
  });

  it('still reports the other missing scopes', async () => {
    process.env.TEAMS_ARTIFACT_MODE = 'transcript-only';
    okToken('openid profile email User.Read offline_access');
    const err = await getGraphAccessToken('u').catch((e) => e);
    expect(err.missingScopes).toEqual([
      'OnlineMeetings.ReadWrite',
      'OnlineMeetingTranscript.Read.All',
    ]);
  });

  it('requires the recording scope again in the default mode', async () => {
    okToken(NO_RECORDING);
    await expect(getGraphAccessToken('u')).rejects.toMatchObject({
      code: 'consent_required',
      missingScopes: ['OnlineMeetingRecording.Read.All'],
    });
  });
});

describe('hasGraphScopes', () => {
  it('throws disabled while the integration is off', async () => {
    delete process.env.TEAMS_GRAPH_ENABLED;
    okToken();
    await expect(hasGraphScopes('u')).rejects.toMatchObject({ code: 'disabled' });
    expect(getAccessToken).not.toHaveBeenCalled();
  });

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

  it('maps a throttle to unavailable, keeping the status', async () => {
    okToken();
    fetchMock.mockResolvedValue(jsonResponse(429, { error: { message: 'slow down' } }));
    const err = await graphFetch('u', '/x').catch((e) => e);
    expect(err.code).toBe('unavailable');
    expect(err.status).toBe(429);
    expect(err.message).toContain('429');
    // Graph throttles the transcript/recording collections routinely: this has
    // to read as "not yet", never as "this meeting failed".
    expect(err.retryable).toBe(true);
  });

  it('reads Retry-After off a throttled response', async () => {
    okToken();
    // 45 s is beyond the wait budget, so this is raised at once instead of waited out.
    fetchMock.mockResolvedValue(
      new Response('{}', { status: 429, headers: { 'Retry-After': '45', 'content-type': 'application/json' } }),
    );
    const err = await graphFetch('u', '/x').catch((e) => e);
    expect(err.retryAfterMs).toBe(45_000);
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
    expect(err.code).toBe('unavailable');
    expect(err.status).toBe(502);
  });

  it('maps a non-retryable status nothing else claims to http', async () => {
    okToken();
    fetchMock.mockResolvedValue(jsonResponse(409, { error: { message: 'conflict' } }));
    const err = await graphFetch('u', '/x').catch((e) => e);
    expect(err.code).toBe('http');
    expect(err.status).toBe(409);
    expect(err.retryable).toBe(false);
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

describe('classifyGraphError', () => {
  it('names reauth_required and transcripts_disabled by their code, ahead of retryable', () => {
    expect(classifyGraphError(new GraphError('reauth_required', 'x', { status: 401 }))).toBe(
      'reauth_required',
    );
    expect(classifyGraphError(new GraphError('transcripts_disabled', 'x', { status: 403 }))).toBe(
      'transcripts_disabled',
    );
    // Even if a caller marked it retryable, the specific code still wins.
    expect(
      classifyGraphError(new GraphError('transcripts_disabled', 'x', { status: 403, retryable: true })),
    ).toBe('transcripts_disabled');
  });

  it('names a retryable GraphError of any other code as retryable', () => {
    expect(classifyGraphError(new GraphError('unavailable', 'x', { status: 503 }))).toBe('retryable');
    expect(classifyGraphError(new GraphError('http', 'x', { status: 429 }))).toBe('retryable');
  });

  it('names a non-retryable GraphError as graph_error', () => {
    expect(classifyGraphError(new GraphError('forbidden', 'x', { status: 403 }))).toBe('graph_error');
    expect(classifyGraphError(new GraphError('not_found', 'x', { status: 404 }))).toBe('graph_error');
  });

  it('names anything that is not a GraphError as unknown', () => {
    expect(classifyGraphError(new Error('socket hang up'))).toBe('unknown');
    expect(classifyGraphError('nope')).toBe('unknown');
    expect(classifyGraphError(null)).toBe('unknown');
  });
});

describe('token single-flight', () => {
  it('shares one refresh among concurrent callers of the same user', async () => {
    const d = deferred<{ accessToken: string; scopes: string[] }>();
    getAccessToken.mockReturnValue(d.promise);

    const calls = [getGraphAccessToken('u'), getGraphAccessToken('u'), hasGraphScopes('u')];
    d.resolve({ accessToken: 'tok-123', scopes: GRAPH_SCOPES.slice() });
    const [a, b, c] = await Promise.all(calls);

    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(a).toBe('tok-123');
    expect(b).toBe('tok-123');
    expect(c).toEqual({ ok: true, missing: [] });
  });

  it('is shared by the parallel graphFetch calls of one request', async () => {
    okToken();
    fetchMock.mockImplementation(async () => jsonResponse(200, {}));
    await Promise.all([graphFetch('u', '/a'), graphFetch('u', '/b'), graphFetch('u', '/c')]);
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not share across users', async () => {
    okToken();
    await Promise.all([getGraphAccessToken('u1'), getGraphAccessToken('u2')]);
    expect(getAccessToken).toHaveBeenCalledTimes(2);
  });

  it('forgets the flight once it settles, so the next call asks again', async () => {
    okToken();
    await getGraphAccessToken('u');
    await getGraphAccessToken('u');
    expect(getAccessToken).toHaveBeenCalledTimes(2);
  });

  it('hands one failure to every waiting caller, and never caches it', async () => {
    const d = deferred<never>();
    getAccessToken.mockReturnValueOnce(d.promise);
    const waiting = [getGraphAccessToken('u'), getGraphAccessToken('u')].map((p) => p.catch((e) => e));
    d.reject(apiError('FAILED_TO_GET_ACCESS_TOKEN'));
    const errs = await Promise.all(waiting);
    expect(errs.map((e) => e.code)).toEqual(['reauth_required', 'reauth_required']);
    expect(getAccessToken).toHaveBeenCalledTimes(1);

    okToken();
    await expect(getGraphAccessToken('u')).resolves.toBe('tok-123');
    expect(getAccessToken).toHaveBeenCalledTimes(2);
  });
});

describe('token failures', () => {
  // better-auth's getAccessToken wraps the refresh in a try/catch that discards the
  // cause: an Entra invalid_grant, a 503, a 429 and a network error all leave as the
  // same APIError { body.code: 'FAILED_TO_GET_ACCESS_TOKEN' }. They cannot be told
  // apart here, so that code keeps meaning "sign in again" (a revoked refresh token
  // is by far the likelier cause and is the only one a retry cannot fix).
  it.each(['FAILED_TO_GET_ACCESS_TOKEN', 'ACCOUNT_NOT_FOUND', 'REFRESH_TOKEN_NOT_FOUND'])(
    'reads better-auth %s as reauth_required',
    async (code) => {
      getAccessToken.mockRejectedValue(apiError(code));
      await expect(getGraphAccessToken('u')).rejects.toMatchObject({
        code: 'reauth_required',
        status: 401,
      });
    },
  );

  it('reads an error that did not come from better-auth (database, network) as transient', async () => {
    getAccessToken.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:5432'));
    const err = await getGraphAccessToken('u').catch((e) => e);
    expect(err).toBeInstanceOf(GraphError);
    expect(err.code).toBe('unavailable');
    expect(err.retryable).toBe(true);
  });

  it('gives up on a token request that never settles, and frees the flight', async () => {
    vi.useFakeTimers();
    getAccessToken.mockReturnValueOnce(new Promise(() => {}));
    const first = getGraphAccessToken('u').catch((e) => e);
    await vi.advanceTimersByTimeAsync(GRAPH_TIMEOUT_MS);
    expect(await first).toMatchObject({ code: 'unavailable', retryable: true });

    okToken();
    await expect(getGraphAccessToken('u')).resolves.toBe('tok-123');
  });
});

describe('graphFetch — a Graph 401', () => {
  function tokens(...values: string[]) {
    const queue = [...values];
    getAccessToken.mockImplementation(async () => ({
      accessToken: queue.length > 1 ? queue.shift() : queue[0],
      scopes: GRAPH_SCOPES.slice(),
    }));
  }
  const bearer = (call: number) => (fetchMock.mock.calls[call][1].headers as Headers).get('Authorization');

  it('forces a refresh and repeats the call once', async () => {
    tokens('stale');
    refreshToken.mockResolvedValue({ accessToken: 'fresh' });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'InvalidAuthenticationToken' } }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const res = await graphFetch('u', '/x');

    expect(res.status).toBe(200);
    expect(refreshToken).toHaveBeenCalledWith({ body: { providerId: 'microsoft', userId: 'u' } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bearer(0)).toBe('Bearer stale');
    expect(bearer(1)).toBe('Bearer fresh');
  });

  it('skips the forced refresh when someone else already replaced the token', async () => {
    tokens('stale', 'newer');
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, {}))
      .mockResolvedValueOnce(jsonResponse(200, {}));

    await graphFetch('u', '/x');

    expect(refreshToken).not.toHaveBeenCalled();
    expect(bearer(1)).toBe('Bearer newer');
  });

  it('retries only once: a second 401 is reauth_required', async () => {
    tokens('stale');
    refreshToken.mockResolvedValue({ accessToken: 'fresh' });
    fetchMock.mockImplementation(async () => jsonResponse(401, {}));

    await expect(graphFetch('u', '/x')).rejects.toMatchObject({ code: 'reauth_required', status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });

  it('is reauth_required, without a second call, when the refresh token is gone', async () => {
    tokens('stale');
    refreshToken.mockRejectedValue(apiError('REFRESH_TOKEN_NOT_FOUND'));
    fetchMock.mockImplementation(async () => jsonResponse(401, {}));

    await expect(graphFetch('u', '/x')).rejects.toMatchObject({ code: 'reauth_required' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('is transient when the forced refresh fails for a reason that is not better-auth', async () => {
    tokens('stale');
    refreshToken.mockRejectedValue(new Error('connect ECONNREFUSED'));
    fetchMock.mockImplementation(async () => jsonResponse(401, {}));

    await expect(graphFetch('u', '/x')).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('shares one forced refresh between calls that were rejected together', async () => {
    tokens('stale');
    const d = deferred<{ accessToken: string }>();
    refreshToken.mockReturnValue(d.promise);
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) =>
      (init.headers as Headers).get('Authorization') === 'Bearer fresh'
        ? jsonResponse(200, {})
        : jsonResponse(401, {}),
    );

    const both = Promise.all([graphFetch('u', '/a'), graphFetch('u', '/b')]);
    await vi.waitFor(() => expect(refreshToken).toHaveBeenCalled());
    d.resolve({ accessToken: 'fresh' });
    await both;

    expect(refreshToken).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 401 from a host that is not Graph (no token was sent)', async () => {
    okToken();
    fetchMock.mockImplementation(async () => new Response('no', { status: 401 }));
    await expect(graphFetch('u', 'https://x.sharepoint.com/signed')).rejects.toMatchObject({
      code: 'reauth_required',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refreshToken).not.toHaveBeenCalled();
  });
});

describe('graphFetch — timeouts', () => {
  it('bounds a JSON call with the short timeout and a download with the long one', async () => {
    okToken();
    fetchMock.mockImplementation(async () => jsonResponse(200, {}));
    const spy = vi.spyOn(AbortSignal, 'timeout');

    await graphFetch('u', '/x');
    await graphFetch('u', '/y', {}, { timeoutMs: GRAPH_DOWNLOAD_TIMEOUT_MS });

    expect(spy.mock.calls.map(([ms]) => ms)).toEqual([GRAPH_TIMEOUT_MS, GRAPH_DOWNLOAD_TIMEOUT_MS]);
    expect(GRAPH_DOWNLOAD_TIMEOUT_MS).toBeGreaterThan(GRAPH_TIMEOUT_MS);
    for (const [, init] of fetchMock.mock.calls) expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('turns a timed-out request into the transient error', async () => {
    okToken();
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(init.signal!.reason))),
    );

    const pending = graphFetch('u', '/x').catch((e) => e);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));

    const err = await pending;
    expect(err).toBeInstanceOf(GraphError);
    expect(err.code).toBe('unavailable');
    expect(err.retryable).toBe(true);
  });

  it('turns a network failure into the transient error', async () => {
    okToken();
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(graphFetch('u', '/x')).rejects.toMatchObject({ code: 'unavailable', retryable: true });
  });

  it('turns a body that stalls after the headers into the transient error', async () => {
    okToken();
    const stalled = {
      ok: true,
      status: 200,
      json: async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      },
    };
    fetchMock.mockResolvedValue(stalled);
    await expect(graphJson('u', '/x')).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('still hands a 3xx back when the caller follows redirects by hand', async () => {
    okToken();
    const redirect = new Response(null, { status: 302, headers: { location: 'https://blob/x' } });
    fetchMock.mockResolvedValue(redirect);
    await expect(graphFetch('u', '/x', { redirect: 'manual' })).resolves.toBe(redirect);
  });
});

describe('graphFetch — Retry-After', () => {
  function throttled(status: number, retryAfter?: string) {
    return new Response('{}', {
      status,
      headers: retryAfter ? { 'Retry-After': retryAfter } : {},
    });
  }

  async function run(p: Promise<Response>, ms: number) {
    const settled = p.then(
      (v) => v,
      (e) => e,
    );
    await vi.advanceTimersByTimeAsync(ms);
    return settled;
  }

  it.each([429, 503])('waits out a %i Retry-After and repeats the call', async (status) => {
    vi.useFakeTimers();
    okToken();
    fetchMock
      .mockResolvedValueOnce(throttled(status, '2'))
      .mockResolvedValueOnce(jsonResponse(200, {}));

    const p = graphFetch('u', '/x');
    const settled = p.then((r) => r.status);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(await settled).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries at most twice, then raises the transient error carrying retryAfterMs', async () => {
    vi.useFakeTimers();
    okToken();
    fetchMock.mockImplementation(async () => throttled(429, '1'));

    const err = await run(graphFetch('u', '/x'), 10_000);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(err).toBeInstanceOf(GraphError);
    expect(err.code).toBe('unavailable');
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(1_000);
  });

  it('does not wait at all for a Retry-After beyond the budget', async () => {
    vi.useFakeTimers();
    okToken();
    fetchMock.mockImplementation(async () => throttled(503, '31'));

    const err = await run(graphFetch('u', '/x'), 0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err).toMatchObject({ code: 'unavailable', retryAfterMs: 31_000 });
  });

  it('never waits longer than 30 s in total', async () => {
    vi.useFakeTimers();
    okToken();
    fetchMock.mockImplementation(async () => throttled(429, '20'));

    const err = await run(graphFetch('u', '/x'), 60_000);

    // 20 s fits, a second 20 s would make 40 s.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(err).toMatchObject({ code: 'unavailable', retryAfterMs: 20_000 });
  });

  it('does not retry a throttle that names no wait', async () => {
    vi.useFakeTimers();
    okToken();
    fetchMock.mockImplementation(async () => throttled(429));
    const err = await run(graphFetch('u', '/x'), 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err).toMatchObject({ code: 'unavailable', retryAfterMs: null });
  });

  it('only honours Retry-After on 429 and 503', async () => {
    vi.useFakeTimers();
    okToken();
    fetchMock.mockImplementation(async () => throttled(500, '1'));
    const err = await run(graphFetch('u', '/x'), 10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err).toMatchObject({ code: 'unavailable', status: 500 });
  });
});
