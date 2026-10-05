import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/authz/principal', () => ({ resolvePrincipal: vi.fn() }));
vi.mock('@/lib/authz/pg-runner', () => ({ defaultRunner: vi.fn() }));

import { POST } from './route';
import { auth } from '@/lib/auth';
import { resolvePrincipal } from '@/lib/authz/principal';
import { defaultRunner } from '@/lib/authz/pg-runner';
import { fixtureData, startMockRollekatalog, type MockRollekatalog } from '@/lib/rollekatalog/mock-server';
import { FAKE_PRINCIPAL_ADMIN, FAKE_SESSION, NO_PARAMS, makeJsonReq, makePrincipal } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockResolve = vi.mocked(resolvePrincipal);
const mockRunner = vi.mocked(defaultRunner);
const query = vi.fn();
const req = () => makeJsonReq('http://localhost/api/admin/access/rollekatalog/check', 'POST');

let mock: MockRollekatalog;
beforeAll(async () => {
  mock = await startMockRollekatalog();
});
afterAll(async () => {
  await mock.close();
});

const knownUserId = () => (fixtureData().roleAssignments as Array<{ userId?: string }>).find((a) => a.userId)!.userId!;

beforeEach(() => {
  mock.resetData();
  mock.setFaults([]);
  mock.clearRequests();
  vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
  vi.stubEnv('ROLLEKATALOG_URL', mock.url);
  vi.stubEnv('ROLLEKATALOG_READ_API_KEY', mock.readKey);
  vi.stubEnv('ROLLEKATALOG_ORG_API_KEY', mock.orgKey);
  mockGetSession.mockReset().mockResolvedValue(FAKE_SESSION as never);
  mockResolve.mockReset().mockResolvedValue(FAKE_PRINCIPAL_ADMIN);
  query.mockReset().mockResolvedValue({ rows: [{ ext_user_id: knownUserId(), ext_uuid: null }], rowCount: 1 });
  mockRunner.mockReset().mockReturnValue({ query } as never);
});
afterEach(() => vi.unstubAllEnvs());

describe('POST /api/admin/access/rollekatalog/check (sync.run)', () => {
  it('401 without a session', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    expect((await POST(req(), NO_PARAMS)).status).toBe(401);
    expect(mock.requests).toHaveLength(0);
  });

  it('403 without sync.run (access.manage is not enough), and Rollekatalog is not called', async () => {
    mockResolve.mockResolvedValue(makePrincipal({ capabilities: ['template.use', 'access.manage'] }));
    expect((await POST(req(), NO_PARAMS)).status).toBe(403);
    expect(mock.requests).toHaveLength(0);
  });

  it('reports every endpoint using the admin\'s own Rollekatalog user for rolesAsList', async () => {
    const res = await POST(req(), NO_PARAMS);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.configured).toBe(true);
    expect(body.endpoints.map((e: { endpoint: string; ok: boolean }) => [e.endpoint, e.ok])).toEqual([
      ['organisation', true],
      ['managers', true],
      ['roleAssignments', true],
      ['constraints', true],
      ['rolesAsList', true],
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('public.directory_users'), [FAKE_PRINCIPAL_ADMIN.directoryUserUuid]);
    expect(mock.requests.at(-1)?.path).toContain(`/api/user/${encodeURIComponent(knownUserId())}/rolesAsList`);
  });

  it('is available in local mode too (verify the config before switching)', async () => {
    vi.stubEnv('ACCESS_SOURCE', 'local');
    expect((await POST(req(), NO_PARAMS)).status).toBe(200);
  });

  it('skips rolesAsList for an admin without a linked directory user (and does not query the DB)', async () => {
    mockResolve.mockResolvedValue({ ...FAKE_PRINCIPAL_ADMIN, directoryUserUuid: null });
    const body = await (await POST(req(), NO_PARAMS)).json();
    expect(body.endpoints.at(-1)).toMatchObject({ endpoint: 'rolesAsList', skipped: true, ok: false });
    expect(query).not.toHaveBeenCalled();
    expect(mock.requests.some((r) => r.path.includes('rolesAsList'))).toBe(false);
  });

  it('a failing directory lookup only skips rolesAsList', async () => {
    query.mockRejectedValue(new Error('db down'));
    const res = await POST(req(), NO_PARAMS);
    expect(res.status).toBe(200);
    expect((await res.json()).endpoints.at(-1).skipped).toBe(true);
  });

  it('reports not_configured per endpoint when nothing is configured', async () => {
    vi.stubEnv('ROLLEKATALOG_URL', '');
    const body = await (await POST(req(), NO_PARAMS)).json();
    expect(body.configured).toBe(false);
    expect(body.configIssue).toBe('not_configured');
    for (const e of body.endpoints.filter((x: { skipped?: boolean }) => !x.skipped)) expect(e.errorCode).toBe('not_configured');
  });

  it('never returns personal data, keys or the URL, but flags that cpr is stripped', async () => {
    const raw = fixtureData();
    const text = await (await POST(req(), NO_PARAMS)).text();
    expect(JSON.parse(text).endpoints[0].cprFieldPresentInResponse).toBe(true);
    for (const u of raw.users) {
      for (const v of [u.name, u.email, u.userId, u.uuid, u.cpr, u.nemloginUuid]) {
        if (typeof v === 'string' && v) expect(text).not.toContain(v);
      }
    }
    for (const secret of [mock.readKey, mock.orgKey, mock.url, 'ApiKey']) expect(text).not.toContain(secret);
  });

  it('upstream failures stay a 200 report with codes (the check itself worked)', async () => {
    mock.setFaults([{ match: '/api/organisation/v3', status: 500 }]);
    const res = await POST(req(), NO_PARAMS);
    expect(res.status).toBe(200);
    expect((await res.json()).endpoints[0]).toMatchObject({ ok: false, httpStatusCode: 500, errorCode: 'server_error' });
  });
});
