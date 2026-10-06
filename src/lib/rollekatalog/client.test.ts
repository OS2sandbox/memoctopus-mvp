import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_KEY_HEADER, createRollekatalogClient, type ClientOptions } from './client';
import { RollekatalogError, errorCodeOf } from './errors';
import { startMockRollekatalog, type MockRollekatalog } from './mock-server';

let mock: MockRollekatalog;
beforeAll(async () => {
  mock = await startMockRollekatalog();
});
afterAll(async () => {
  await mock.close();
});
beforeEach(() => {
  mock.resetData();
  mock.setFaults([]);
  mock.clearRequests();
});
afterEach(() => vi.unstubAllEnvs());

const noSleep = async () => {};
const opts = (extra: ClientOptions = {}): ClientOptions => ({
  baseUrl: mock.url,
  readKey: mock.readKey,
  orgKey: mock.orgKey,
  sleep: noSleep,
  ...extra,
});

async function failure(p: Promise<unknown>): Promise<RollekatalogError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(RollekatalogError);
    return e as RollekatalogError;
  }
  throw new Error('expected a RollekatalogError');
}

describe('happy paths against the mock', () => {
  it('getOrganisation uses the ORG key and returns the whitelisted shape', async () => {
    const org = await createRollekatalogClient(opts()).getOrganisation();
    expect(org.users.length).toBe(9);
    expect(org.orgUnits.length).toBe(5);
    expect(mock.requests).toEqual([{ method: 'GET', path: '/api/organisation/v3', query: '', keyRole: 'org', status: 200 }]);
  });
  it('getRoleAssignments uses the READ key, the IT system and the optional domain', async () => {
    const a = await createRollekatalogClient(opts({ domain: 'Administrativt' })).getRoleAssignments();
    expect(a).toHaveLength(10);
    expect(mock.requests[0]).toMatchObject({
      path: '/api/read/itsystem/roleAssignmentsWithContraints/os2taletiltekst',
      query: 'domain=Administrativt',
      keyRole: 'read',
    });
  });
  it('getRoleAssignments without domain sends no query', async () => {
    await createRollekatalogClient(opts()).getRoleAssignments();
    expect(mock.requests[0].query).toBe('');
  });
  it('reads URL and keys from the environment at call time when no options are given', async () => {
    vi.stubEnv('ROLLEKATALOG_URL', mock.url);
    vi.stubEnv('ROLLEKATALOG_READ_API_KEY', mock.readKey);
    vi.stubEnv('ROLLEKATALOG_ORG_API_KEY', mock.orgKey);
    vi.stubEnv('ROLLEKATALOG_ITSYSTEM_ID', 'os2taletiltekst');
    expect((await createRollekatalogClient().getOrganisation()).users.length).toBe(9);
    expect((await createRollekatalogClient().getRoleAssignments()).length).toBeGreaterThan(0);
  });
});

describe('auth header and key roles', () => {
  it('sends the key in the ApiKey header and never in Authorization', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchSpy = vi.fn(async (_url: unknown, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>);
      return new Response('[]', { status: 200 });
    });
    await createRollekatalogClient(opts({ fetch: fetchSpy as unknown as typeof fetch })).getRoleAssignments();
    expect(API_KEY_HEADER).toBe('ApiKey');
    expect(seen[0]).toMatchObject({ ApiKey: mock.readKey });
    expect(Object.keys(seen[0]).map((k) => k.toLowerCase())).not.toContain('authorization');
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'manual' });
    // The key is a header only: never part of the URL.
    expect(String(fetchSpy.mock.calls[0][0])).not.toContain(mock.readKey);
  });

  it('401 for an unknown key, not retried', async () => {
    const err = await failure(createRollekatalogClient(opts({ orgKey: 'wrong' })).getOrganisation());
    expect(err.code).toBe('unauthorized');
    expect(err.httpStatus).toBe(401);
    expect(mock.requests).toHaveLength(1);
  });

  it('403 when the READ key is used for organisation (wrong key role), not retried', async () => {
    const err = await failure(createRollekatalogClient(opts({ orgKey: mock.readKey })).getOrganisation());
    expect(err.code).toBe('forbidden');
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]).toMatchObject({ keyRole: 'read', status: 403 });
  });

  it('403 when the ORG key is used for the read endpoints (ORGANISATION does not imply READ_ACCESS)', async () => {
    const c = createRollekatalogClient(opts({ readKey: mock.orgKey }));
    expect((await failure(c.getRoleAssignments())).code).toBe('forbidden');
    expect(mock.requests.every((r) => r.keyRole === 'org' && r.status === 403)).toBe(true);
  });

  it('not_configured without a key, and no request is made', async () => {
    const c = createRollekatalogClient(opts({ orgKey: null }));
    expect((await failure(c.getOrganisation())).code).toBe('not_configured');
    expect(mock.requests).toHaveLength(0);
  });
});

describe('status mapping', () => {
  it('404 for an unknown system on the bulk endpoint (body []) is not_found and is not retried', async () => {
    const err = await failure(createRollekatalogClient(opts({ itSystemId: 'other' })).getRoleAssignments());
    expect(err.code).toBe('not_found');
    expect(err.httpStatus).toBe(404);
    expect(mock.requests).toHaveLength(1);
  });
  it('unknown domain is not_found', async () => {
    const err = await failure(createRollekatalogClient(opts({ domain: 'Nope' })).getRoleAssignments());
    expect(err.code).toBe('not_found');
  });
  it('other 4xx is invalid_response and not retried; a redirect is not followed', async () => {
    const f400 = vi.fn(async () => new Response('', { status: 400 }));
    const e400 = await failure(createRollekatalogClient(opts({ fetch: f400 as unknown as typeof fetch })).getRoleAssignments());
    expect(e400.code).toBe('invalid_response');
    expect(f400).toHaveBeenCalledTimes(1);
    const f302 = vi.fn(async () => new Response('', { status: 302, headers: { Location: 'https://elsewhere.invalid/' } }));
    const e302 = await failure(createRollekatalogClient(opts({ fetch: f302 as unknown as typeof fetch })).getRoleAssignments());
    expect(e302).toMatchObject({ code: 'invalid_response', httpStatus: 302 });
    expect(f302).toHaveBeenCalledTimes(1);
  });
});

describe('retries', () => {
  it('retries 5xx and then succeeds', async () => {
    mock.setFaults([{ match: '/api/read/', status: 503, times: 2 }]);
    const sleeps: number[] = [];
    const a = await createRollekatalogClient(opts({ sleep: async (ms) => void sleeps.push(ms), backoffMs: 10 })).getRoleAssignments();
    expect(a).toHaveLength(10);
    expect(mock.requests.map((r) => r.status)).toEqual([503, 503, 200]);
    expect(sleeps).toEqual([10, 20]);
  });
  it('gives up after 2 retries with server_error', async () => {
    mock.setFaults([{ match: '/api/read/', status: 500 }]);
    const err = await failure(createRollekatalogClient(opts()).getRoleAssignments());
    expect(err).toMatchObject({ code: 'server_error', httpStatus: 500 });
    expect(mock.requests).toHaveLength(3);
  });
  it('never retries more than 2 times even if asked', async () => {
    mock.setFaults([{ match: '/api/read/', status: 500 }]);
    await failure(createRollekatalogClient(opts({ retries: 10 })).getRoleAssignments());
    expect(mock.requests).toHaveLength(3);
  });
  it('retries 429 and then succeeds', async () => {
    mock.setFaults([{ match: '/api/read/', status: 429, times: 1 }]);
    const a = await createRollekatalogClient(opts()).getRoleAssignments();
    expect(a).toHaveLength(10);
    expect(mock.requests.map((r) => r.status)).toEqual([429, 200]);
  });
  it('never retries a timeout: exactly one request reaches the server', async () => {
    mock.setFaults([{ match: '/api/read/', delayMs: 400, times: 1 }]);
    const sleeps: number[] = [];
    const err = await failure(
      createRollekatalogClient(opts({ timeoutMs: 100, sleep: async (ms) => void sleeps.push(ms) })).getRoleAssignments(),
    );
    expect(err.code).toBe('timeout');
    expect(sleeps).toEqual([]);
    // The faulted request is only recorded when the server answers; wait for it, then
    // prove no second request arrived behind it.
    await new Promise((r) => setTimeout(r, 600));
    expect(mock.requests.length).toBeLessThanOrEqual(1);
  });
  it('does not retry a timeout on the organisation endpoint either', async () => {
    const f = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const err = await failure(createRollekatalogClient(opts({ fetch: f as unknown as typeof fetch, timeoutMs: 50 })).getOrganisation());
    expect(err.code).toBe('timeout');
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('retries a network failure, then reports network', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('fetch failed: getaddrinfo ENOTFOUND secret-host.internal');
    });
    const err = await failure(createRollekatalogClient(opts({ fetch: f as unknown as typeof fetch })).getRoleAssignments());
    expect(err.code).toBe('network');
    expect(f).toHaveBeenCalledTimes(3);
    expect(err.message).not.toContain('secret-host');
    expect(err.cause).toBeUndefined();
  });
});

describe('timeout, size and body handling', () => {
  it('times out with code timeout', async () => {
    mock.setFaults([{ match: '/api/read/', delayMs: 500 }]);
    const err = await failure(createRollekatalogClient(opts({ timeoutMs: 100, retries: 0 })).getRoleAssignments());
    expect(err.code).toBe('timeout');
  });
  it('aborts a slow body read at the timeout (the deadline covers the body), code timeout, no retry', async () => {
    const f = vi.fn(async (_url: unknown, init?: RequestInit) => {
      // Headers arrive at once, then the body stalls until the client aborts.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('[{"'));
          init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return new Response(body, { status: 200 });
    });
    const err = await failure(createRollekatalogClient(opts({ fetch: f as unknown as typeof fetch, timeoutMs: 50 })).getRoleAssignments());
    expect(err.code).toBe('timeout');
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('rejects an oversized body announced by Content-Length', async () => {
    mock.setFaults([{ match: '/api/read/', oversize: { bytes: 5000 } }]);
    const err = await failure(createRollekatalogClient(opts({ maxBytes: 4096 })).getRoleAssignments());
    expect(err.code).toBe('too_large');
    expect(mock.requests).toHaveLength(1);
  });
  it('enforces the cap while reading a chunked body without Content-Length', async () => {
    mock.setFaults([{ match: '/api/read/', oversize: { bytes: 100_000, chunked: true } }]);
    const err = await failure(createRollekatalogClient(opts({ maxBytes: 4096 })).getRoleAssignments());
    expect(err.code).toBe('too_large');
  });
  it('reports invalid JSON as invalid_response, not retried', async () => {
    mock.setFaults([{ match: '/api/read/', invalidJson: true }]);
    const err = await failure(createRollekatalogClient(opts()).getRoleAssignments());
    expect(err.code).toBe('invalid_response');
    expect(mock.requests).toHaveLength(1);
  });
  it('reports a well-formed body of the wrong shape as invalid_response', async () => {
    mock.setData({ roleAssignments: [{ assignments: [{}] }] });
    expect((await failure(createRollekatalogClient(opts()).getRoleAssignments())).code).toBe('invalid_response');
  });
  it('reports an empty 200 body as invalid_response', async () => {
    const f = vi.fn(async () => new Response('', { status: 200 }));
    expect((await failure(createRollekatalogClient(opts({ fetch: f as unknown as typeof fetch })).getRoleAssignments())).code).toBe('invalid_response');
  });
  it('reports a refused connection as network', async () => {
    const dead = await startMockRollekatalog();
    const url = dead.url;
    await dead.close();
    const err = await failure(createRollekatalogClient(opts({ baseUrl: url, retries: 0 })).getRoleAssignments());
    expect(err.code).toBe('network');
  });
});

describe('URL rules', () => {
  it('refuses an insecure URL without making a request', async () => {
    const f = vi.fn();
    const c = createRollekatalogClient(opts({ baseUrl: 'http://rk.example.dk', fetch: f as unknown as typeof fetch }));
    expect((await failure(c.getRoleAssignments())).code).toBe('insecure_url');
    expect(f).not.toHaveBeenCalled();
  });
  it('is not_configured for a missing or invalid URL', async () => {
    vi.stubEnv('ROLLEKATALOG_URL', '');
    expect((await failure(createRollekatalogClient({ readKey: 'a', orgKey: 'b' }).getRoleAssignments())).code).toBe('not_configured');
    expect((await failure(createRollekatalogClient(opts({ baseUrl: 'nope' })).getRoleAssignments())).code).toBe('not_configured');
  });
  it('an https URL is used as is', async () => {
    const f = vi.fn(async () => new Response('[]', { status: 200 }));
    await createRollekatalogClient(opts({ baseUrl: 'https://rk.example.dk/', fetch: f as unknown as typeof fetch })).getRoleAssignments();
    expect(String((f.mock.calls as unknown[][])[0][0])).toBe('https://rk.example.dk/api/read/itsystem/roleAssignmentsWithContraints/os2taletiltekst');
  });
});

describe('secrets hygiene', () => {
  const SECRET = 'SUPER-SECRET-KEY-9f8e7d';

  it('keeps keys out of error text, serialised errors and console output on every failure path', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const failing: Array<[string, ClientOptions, (c: ReturnType<typeof createRollekatalogClient>) => Promise<unknown>]> = [
      ['401', { fetch: (async () => new Response('', { status: 401 })) as unknown as typeof fetch }, (c) => c.getOrganisation()],
      ['403', { fetch: (async () => new Response('', { status: 403 })) as unknown as typeof fetch }, (c) => c.getOrganisation()],
      ['404', { fetch: (async () => new Response('', { status: 404 })) as unknown as typeof fetch }, (c) => c.getRoleAssignments()],
      ['5xx', { fetch: (async () => new Response('', { status: 502 })) as unknown as typeof fetch }, (c) => c.getOrganisation()],
      ['network', { fetch: (async () => { throw new TypeError(`fetch failed with ApiKey ${SECRET}`); }) as unknown as typeof fetch }, (c) => c.getOrganisation()],
      ['json', { fetch: (async () => new Response(`not json ${SECRET}`, { status: 200 })) as unknown as typeof fetch }, (c) => c.getOrganisation()],
      ['schema', { fetch: (async () => new Response(JSON.stringify({ users: [{ uuid: SECRET }], orgUnits: [] }), { status: 200 })) as unknown as typeof fetch }, (c) => c.getOrganisation()],
      ['too_large', { maxBytes: 1024, fetch: (async () => new Response('x'.repeat(2048), { status: 200 })) as unknown as typeof fetch }, (c) => c.getOrganisation()],
    ];
    for (const [label, extra, call] of failing) {
      const err = await failure(call(createRollekatalogClient(opts({ orgKey: SECRET, readKey: SECRET, ...extra }))));
      const text = `${err.message} ${err.stack ?? ''} ${JSON.stringify(err)} ${String(err)} ${errorCodeOf(err)}`;
      expect(text, label).not.toContain(SECRET);
      expect(text, label).not.toContain('anne.p');
    }
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it('does not log on success either', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const spyW = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await createRollekatalogClient(opts()).getOrganisation();
    expect(spy).not.toHaveBeenCalled();
    expect(spyW).not.toHaveBeenCalled();
    spy.mockRestore();
    spyW.mockRestore();
  });
});

describe('errorCodeOf', () => {
  it('returns the code of a RollekatalogError and unexpected for anything else', () => {
    expect(errorCodeOf(new RollekatalogError('timeout'))).toBe('timeout');
    expect(errorCodeOf(new Error('x'))).toBe('unexpected');
    expect(errorCodeOf('x')).toBe('unexpected');
  });
});
