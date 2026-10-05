import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_KEY_HEADER, createRollekatalogClient, getOrganisation, getRolesAsList, type ClientOptions } from './client';
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
  it('getManagers uses the ORG key', async () => {
    const m = await createRollekatalogClient(opts()).getManagers();
    expect(m).toHaveLength(4);
    expect(mock.requests[0]).toMatchObject({ path: '/api/v2/manager', keyRole: 'org' });
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
  it('getRolesAsList passes system, encodes the user id, and returns disabled', async () => {
    const r = await createRollekatalogClient(opts()).getRolesAsList('anne.p');
    expect(r.systemRoles).toEqual(['tt-bruger', 'tt-skabelonansvarlig']);
    expect(r.disabled).toBe(false);
    expect(mock.requests[0]).toMatchObject({ path: '/api/user/anne.p/rolesAsList', query: 'system=os2taletiltekst', keyRole: 'read' });
    const d = await createRollekatalogClient(opts()).getRolesAsList('sofie.s');
    expect(d.disabled).toBe(true);
    expect(d.systemRoles).toEqual(['tt-bruger']);
  });
  it('getConstraints uses the READ key', async () => {
    const c = await createRollekatalogClient(opts()).getConstraints();
    expect(c.length).toBe(3);
    expect(mock.requests[0]).toMatchObject({ path: '/api/v2/constraint', keyRole: 'read' });
  });
  it('reads URL and keys from the environment at call time when no options are given', async () => {
    vi.stubEnv('ROLLEKATALOG_URL', mock.url);
    vi.stubEnv('ROLLEKATALOG_READ_API_KEY', mock.readKey);
    vi.stubEnv('ROLLEKATALOG_ORG_API_KEY', mock.orgKey);
    vi.stubEnv('ROLLEKATALOG_ITSYSTEM_ID', 'os2taletiltekst');
    expect((await getOrganisation()).users.length).toBe(9);
    expect((await getRolesAsList('anne.p')).disabled).toBe(false);
  });
});

describe('auth header and key roles', () => {
  it('sends the key in the ApiKey header and never in Authorization', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchSpy = vi.fn(async (_url: unknown, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>);
      return new Response('[]', { status: 200 });
    });
    await createRollekatalogClient(opts({ fetch: fetchSpy as unknown as typeof fetch })).getManagers();
    expect(API_KEY_HEADER).toBe('ApiKey');
    expect(seen[0]).toMatchObject({ ApiKey: mock.orgKey });
    expect(Object.keys(seen[0]).map((k) => k.toLowerCase())).not.toContain('authorization');
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'manual' });
    // The key is a header only: never part of the URL.
    expect(String(fetchSpy.mock.calls[0][0])).not.toContain(mock.orgKey);
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
    expect((await failure(c.getRolesAsList('anne.p'))).code).toBe('forbidden');
    expect((await failure(c.getConstraints())).code).toBe('forbidden');
    expect(mock.requests.every((r) => r.keyRole === 'org' && r.status === 403)).toBe(true);
  });

  it('not_configured without a key, and no request is made', async () => {
    const c = createRollekatalogClient(opts({ orgKey: null }));
    expect((await failure(c.getOrganisation())).code).toBe('not_configured');
    expect(mock.requests).toHaveLength(0);
  });
});

describe('status mapping', () => {
  it('404 with an empty body (unknown user) is not_found and is not retried', async () => {
    const err = await failure(createRollekatalogClient(opts()).getRolesAsList('nobody'));
    expect(err.code).toBe('not_found');
    expect(err.httpStatus).toBe(404);
    expect(mock.requests).toHaveLength(1);
  });
  it('404 for an unknown system on the bulk endpoint (body []) is not_found', async () => {
    const err = await failure(createRollekatalogClient(opts({ itSystemId: 'other' })).getRoleAssignments());
    expect(err.code).toBe('not_found');
  });
  it('unknown domain is not_found', async () => {
    const err = await failure(createRollekatalogClient(opts({ domain: 'Nope' })).getRolesAsList('anne.p'));
    expect(err.code).toBe('not_found');
  });
  it('other 4xx is invalid_response and not retried; a redirect is not followed', async () => {
    const f400 = vi.fn(async () => new Response('', { status: 400 }));
    const e400 = await failure(createRollekatalogClient(opts({ fetch: f400 as unknown as typeof fetch })).getConstraints());
    expect(e400.code).toBe('invalid_response');
    expect(f400).toHaveBeenCalledTimes(1);
    const f302 = vi.fn(async () => new Response('', { status: 302, headers: { Location: 'https://elsewhere.invalid/' } }));
    const e302 = await failure(createRollekatalogClient(opts({ fetch: f302 as unknown as typeof fetch })).getConstraints());
    expect(e302).toMatchObject({ code: 'invalid_response', httpStatus: 302 });
    expect(f302).toHaveBeenCalledTimes(1);
  });
});

describe('retries', () => {
  it('retries 5xx and then succeeds', async () => {
    mock.setFaults([{ match: '/api/v2/manager', status: 503, times: 2 }]);
    const sleeps: number[] = [];
    const m = await createRollekatalogClient(opts({ sleep: async (ms) => void sleeps.push(ms), backoffMs: 10 })).getManagers();
    expect(m).toHaveLength(4);
    expect(mock.requests.map((r) => r.status)).toEqual([503, 503, 200]);
    expect(sleeps).toEqual([10, 20]);
  });
  it('gives up after 2 retries with server_error', async () => {
    mock.setFaults([{ match: '/api/v2/manager', status: 500 }]);
    const err = await failure(createRollekatalogClient(opts()).getManagers());
    expect(err).toMatchObject({ code: 'server_error', httpStatus: 500 });
    expect(mock.requests).toHaveLength(3);
  });
  it('never retries more than 2 times even if asked', async () => {
    mock.setFaults([{ match: '/api/v2/manager', status: 500 }]);
    await failure(createRollekatalogClient(opts({ retries: 10 })).getManagers());
    expect(mock.requests).toHaveLength(3);
  });
  it('retries a timeout', async () => {
    mock.setFaults([{ match: '/api/v2/manager', delayMs: 400, times: 1 }]);
    const m = await createRollekatalogClient(opts({ timeoutMs: 100 })).getManagers();
    expect(m).toHaveLength(4);
  });
  it('retries a network failure, then reports network', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('fetch failed: getaddrinfo ENOTFOUND secret-host.internal');
    });
    const err = await failure(createRollekatalogClient(opts({ fetch: f as unknown as typeof fetch })).getManagers());
    expect(err.code).toBe('network');
    expect(f).toHaveBeenCalledTimes(3);
    expect(err.message).not.toContain('secret-host');
    expect(err.cause).toBeUndefined();
  });
  it('the login refresh never retries and uses a short timeout', async () => {
    mock.setFaults([{ match: '/api/user/', status: 503 }]);
    const err = await failure(createRollekatalogClient(opts()).getRolesAsList('anne.p', { login: true }));
    expect(err.code).toBe('server_error');
    expect(mock.requests).toHaveLength(1);
    mock.clearRequests();
    mock.setFaults([{ match: '/api/user/', delayMs: 300 }]);
    const t0 = Date.now();
    const e2 = await failure(createRollekatalogClient(opts({ timeoutMs: 100 })).getRolesAsList('anne.p', { login: true }));
    expect(e2.code).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(280);
  });
});

describe('timeout, size and body handling', () => {
  it('times out with code timeout', async () => {
    mock.setFaults([{ match: '/api/v2/constraint', delayMs: 500 }]);
    const err = await failure(createRollekatalogClient(opts({ timeoutMs: 100, retries: 0 })).getConstraints());
    expect(err.code).toBe('timeout');
  });
  it('rejects an oversized body announced by Content-Length', async () => {
    mock.setFaults([{ match: '/api/v2/constraint', oversize: { bytes: 5000 } }]);
    const err = await failure(createRollekatalogClient(opts({ maxBytes: 4096 })).getConstraints());
    expect(err.code).toBe('too_large');
    expect(mock.requests).toHaveLength(1);
  });
  it('enforces the cap while reading a chunked body without Content-Length', async () => {
    mock.setFaults([{ match: '/api/v2/constraint', oversize: { bytes: 100_000, chunked: true } }]);
    const err = await failure(createRollekatalogClient(opts({ maxBytes: 4096 })).getConstraints());
    expect(err.code).toBe('too_large');
  });
  it('caps the single-user call at 1 MiB even if a bigger cap is configured', async () => {
    mock.setFaults([{ match: '/api/user/', oversize: { bytes: 1024 * 1024 } }]);
    const err = await failure(createRollekatalogClient(opts({ maxBytes: 50 * 1024 * 1024 })).getRolesAsList('anne.p'));
    expect(err.code).toBe('too_large');
  });
  it('reports invalid JSON as invalid_response, not retried', async () => {
    mock.setFaults([{ match: '/api/v2/constraint', invalidJson: true }]);
    const err = await failure(createRollekatalogClient(opts()).getConstraints());
    expect(err.code).toBe('invalid_response');
    expect(mock.requests).toHaveLength(1);
  });
  it('reports a well-formed body of the wrong shape as invalid_response', async () => {
    mock.setData({ constraints: [{ id: 'not-a-number' }] });
    expect((await failure(createRollekatalogClient(opts()).getConstraints())).code).toBe('invalid_response');
  });
  it('reports an empty 200 body as invalid_response', async () => {
    const f = vi.fn(async () => new Response('', { status: 200 }));
    expect((await failure(createRollekatalogClient(opts({ fetch: f as unknown as typeof fetch })).getConstraints())).code).toBe('invalid_response');
  });
  it('reports a refused connection as network', async () => {
    const dead = await startMockRollekatalog();
    const url = dead.url;
    await dead.close();
    const err = await failure(createRollekatalogClient(opts({ baseUrl: url, retries: 0 })).getManagers());
    expect(err.code).toBe('network');
  });
});

describe('URL rules', () => {
  it('refuses an insecure URL without making a request', async () => {
    const f = vi.fn();
    const c = createRollekatalogClient(opts({ baseUrl: 'http://rk.example.dk', fetch: f as unknown as typeof fetch }));
    expect((await failure(c.getManagers())).code).toBe('insecure_url');
    expect(f).not.toHaveBeenCalled();
  });
  it('is not_configured for a missing or invalid URL', async () => {
    vi.stubEnv('ROLLEKATALOG_URL', '');
    expect((await failure(createRollekatalogClient({ readKey: 'a', orgKey: 'b' }).getManagers())).code).toBe('not_configured');
    expect((await failure(createRollekatalogClient(opts({ baseUrl: 'nope' })).getManagers())).code).toBe('not_configured');
  });
  it('an https URL is used as is', async () => {
    const f = vi.fn(async () => new Response('[]', { status: 200 }));
    await createRollekatalogClient(opts({ baseUrl: 'https://rk.example.dk/', fetch: f as unknown as typeof fetch })).getManagers();
    expect(String((f.mock.calls as unknown[][])[0][0])).toBe('https://rk.example.dk/api/v2/manager');
  });
});

describe('secrets hygiene', () => {
  const SECRET = 'SUPER-SECRET-KEY-9f8e7d';

  it('keeps keys out of error text, serialised errors and console output on every failure path', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const failing: Array<[string, ClientOptions, (c: ReturnType<typeof createRollekatalogClient>) => Promise<unknown>]> = [
      ['401', { fetch: (async () => new Response('', { status: 401 })) as unknown as typeof fetch }, (c) => c.getOrganisation()],
      ['403', { fetch: (async () => new Response('', { status: 403 })) as unknown as typeof fetch }, (c) => c.getOrganisation()],
      ['404', { fetch: (async () => new Response('', { status: 404 })) as unknown as typeof fetch }, (c) => c.getRolesAsList('anne.p')],
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
