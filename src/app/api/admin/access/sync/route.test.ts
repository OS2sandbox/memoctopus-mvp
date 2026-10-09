import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/audit/authz-denied', () => ({ recordAuthzDenied: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/authz/principal', () => ({ resolvePrincipal: vi.fn() }));
vi.mock('@/lib/rollekatalog/sync', () => ({ runSync: vi.fn() }));
vi.mock('@/lib/rollekatalog/sync-run', () => ({ getLatestSyncRun: vi.fn() }));

import { GET, POST } from './route';
import { auth } from '@/lib/auth';
import { resolvePrincipal } from '@/lib/authz/principal';
import { runSync } from '@/lib/rollekatalog/sync';
import { getLatestSyncRun } from '@/lib/rollekatalog/sync-run';
import { emptySyncCounts, type SyncResult } from '@/lib/rollekatalog/types';
import { FAKE_PRINCIPAL_ADMIN, FAKE_SESSION, NO_PARAMS, makeJsonReq, makePrincipal } from '@/test/helpers';
import { NextRequest } from 'next/server';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockResolve = vi.mocked(resolvePrincipal);
const mockRun = vi.mocked(runSync);
const mockLatest = vi.mocked(getLatestSyncRun);

const URL = 'http://localhost/api/admin/access/sync';
const post = (body?: unknown) => makeJsonReq(URL, 'POST', body);
const get = () => makeJsonReq(URL, 'GET');
const counts = { ...emptySyncCounts(), usersUpserted: 3 };
const result = (over: Partial<SyncResult> = {}): SyncResult => ({ status: 'success', runId: 'run-1', counts, errorCode: null, ...over });

const OPERATOR = makePrincipal({ roles: ['bruger', 'admin'], capabilities: ['template.use', 'audit.read', 'directory.read'] });
const ACCESS_MANAGER = makePrincipal({ capabilities: ['template.use', 'access.manage'] });

beforeEach(() => {
  vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
  vi.stubEnv('ROLLEKATALOG_URL', '');
  mockGetSession.mockReset().mockResolvedValue(FAKE_SESSION as never);
  mockResolve.mockReset().mockResolvedValue(FAKE_PRINCIPAL_ADMIN);
  mockRun.mockReset().mockResolvedValue(result());
  mockLatest.mockReset().mockResolvedValue(null);
});

describe('POST /api/admin/access/sync (sync.run, rollekatalog mode only)', () => {
  it('401 without a session', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    expect((await POST(post(), NO_PARAMS)).status).toBe(401);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('403 without sync.run, even with access.manage', async () => {
    mockResolve.mockResolvedValue(ACCESS_MANAGER);
    expect((await POST(post(), NO_PARAMS)).status).toBe(403);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('403 for a disabled principal', async () => {
    mockResolve.mockResolvedValue({ ...FAKE_PRINCIPAL_ADMIN, disabled: true });
    expect((await POST(post(), NO_PARAMS)).status).toBe(403);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('409 with a Danish message in local mode, and nothing runs', async () => {
    vi.stubEnv('ACCESS_SOURCE', 'local');
    const res = await POST(post(), NO_PARAMS);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('not_rollekatalog_mode');
    expect(body.error).toMatch(/Rollekatalog/);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('a caller without sync.run gets 403, not the mode 409 (no information leak)', async () => {
    vi.stubEnv('ACCESS_SOURCE', 'local');
    mockResolve.mockResolvedValue(ACCESS_MANAGER);
    expect((await POST(post(), NO_PARAMS)).status).toBe(403);
  });

  it('runs a manual sync with the session user as actor, not forced by default', async () => {
    const res = await POST(post(), NO_PARAMS);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'success', counts, errorCode: null });
    expect(mockRun).toHaveBeenCalledWith({ trigger: 'manual', force: false, actorUserId: 'admin-123' });
  });

  it('accepts a body-less POST, an empty object and force:false', async () => {
    await POST(new NextRequest(URL, { method: 'POST' }), NO_PARAMS);
    await POST(post({}), NO_PARAMS);
    await POST(post({ force: false }), NO_PARAMS);
    expect(mockRun).toHaveBeenCalledTimes(3);
    for (const call of mockRun.mock.calls) expect(call[0]).toMatchObject({ force: false });
  });

  it('passes force=true through (the removal-threshold override)', async () => {
    await POST(post({ force: true }), NO_PARAMS);
    expect(mockRun).toHaveBeenCalledWith({ trigger: 'manual', force: true, actorUserId: 'admin-123' });
  });

  it.each([[{ force: 'yes' }], [{ force: 1 }], [{ force: true, extra: 1 }], [{ trigger: 'cron' }], [[true]]])(
    '400 for an invalid body %j, and nothing runs',
    async (body) => {
      const res = await POST(post(body), NO_PARAMS);
      expect(res.status).toBe(400);
      expect(mockRun).not.toHaveBeenCalled();
    },
  );

  it('400 for malformed JSON', async () => {
    const req = new NextRequest(URL, { method: 'POST', body: '{nope', headers: { 'Content-Type': 'application/json' } });
    const res = await POST(req, NO_PARAMS);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_json');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('409 already_running with a Danish message', async () => {
    mockRun.mockResolvedValue(result({ status: 'already_running', runId: null, counts: emptySyncCounts() }));
    const res = await POST(post(), NO_PARAMS);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'already_running', code: 'already_running' });
    expect(body.error).toBe('En synkronisering kører allerede.');
  });

  it('502 for removal_threshold with the code (so the UI can offer "Gennemtving")', async () => {
    mockRun.mockResolvedValue(result({ status: 'aborted', errorCode: 'removal_threshold' }));
    const res = await POST(post(), NO_PARAMS);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'aborted', errorCode: 'removal_threshold', code: 'removal_threshold' });
    expect(body.error).toMatch(/Gennemtving|gennemtving/);
  });

  it('502 for empty_response', async () => {
    mockRun.mockResolvedValue(result({ status: 'aborted', errorCode: 'empty_response' }));
    const res = await POST(post({ force: true }), NO_PARAMS);
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('empty_response');
  });

  it.each([
    ['not_configured', 502],
    ['unauthorized', 502],
    ['timeout', 502],
    ['unexpected', 500],
  ])('error %s gives %i with a Danish message and never the raw code as text', async (code, status) => {
    mockRun.mockResolvedValue(result({ status: 'error', errorCode: code }));
    const res = await POST(post(), NO_PARAMS);
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body.errorCode).toBe(code);
    expect(body.error).not.toContain(code);
  });

  it('an unknown error code gets the generic message', async () => {
    mockRun.mockResolvedValue(result({ status: 'error', errorCode: 'something_new' }));
    const body = await (await POST(post(), NO_PARAMS)).json();
    expect(body.error).toBe('Synkroniseringen mislykkedes. Intet er ændret.');
  });

  it('a crashing sync is the standard JSON 500', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockRun.mockRejectedValue(new Error('password=hunter2'));
    const res = await POST(post(), NO_PARAMS);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('hunter2');
    err.mockRestore();
  });
});

describe('GET /api/admin/access/sync', () => {
  const run = {
    id: 'r1',
    startedAt: new Date('2026-10-05T10:00:00Z'),
    finishedAt: new Date('2026-10-05T10:00:03Z'),
    status: 'success' as const,
    counts,
    errorCode: null,
  };

  it('401 without a session', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    expect((await GET(get(), NO_PARAMS)).status).toBe(401);
    expect(mockLatest).not.toHaveBeenCalled();
  });

  it('403 without sync.run or access.manage (a log reader)', async () => {
    mockResolve.mockResolvedValue(OPERATOR);
    expect((await GET(get(), NO_PARAMS)).status).toBe(403);
    expect(mockLatest).not.toHaveBeenCalled();
  });

  it('is readable with only access.manage (the read-only user list shows the sync time)', async () => {
    mockResolve.mockResolvedValue(ACCESS_MANAGER);
    mockLatest.mockResolvedValue(run);
    expect((await GET(get(), NO_PARAMS)).status).toBe(200);
  });

  it('is readable with only sync.run', async () => {
    mockResolve.mockResolvedValue(makePrincipal({ capabilities: ['template.use', 'sync.run'] }));
    expect((await GET(get(), NO_PARAMS)).status).toBe(200);
  });

  it('returns the latest run with ISO dates, the mode and the config issue', async () => {
    mockLatest.mockResolvedValue(run);
    const res = await GET(get(), NO_PARAMS);
    expect(await res.json()).toEqual({
      run: {
        id: 'r1',
        startedAt: '2026-10-05T10:00:00.000Z',
        finishedAt: '2026-10-05T10:00:03.000Z',
        status: 'success',
        counts,
        errorCode: null,
      },
      source: 'rollekatalog',
      configIssue: 'not_configured',
      itSystem: 'os2taletiltekst',
    });
  });

  it('names the configured IT system, and only the identifier (no keys or URL)', async () => {
    vi.stubEnv('ROLLEKATALOG_ITSYSTEM_ID', 'mit-system');
    vi.stubEnv('ROLLEKATALOG_READ_API_KEY', 'secret-read-key');
    vi.stubEnv('ROLLEKATALOG_ORG_API_KEY', 'secret-org-key');
    vi.stubEnv('ROLLEKATALOG_URL', 'https://rk.example.dk');
    const body = await (await GET(get(), NO_PARAMS)).json();
    expect(body.itSystem).toBe('mit-system');
    expect(JSON.stringify(body)).not.toMatch(/secret-|rk\.example/);
    for (const k of ['ROLLEKATALOG_ITSYSTEM_ID', 'ROLLEKATALOG_READ_API_KEY', 'ROLLEKATALOG_ORG_API_KEY']) vi.stubEnv(k, '');
  });

  it('run is null before the first sync', async () => {
    expect((await (await GET(get(), NO_PARAMS)).json()).run).toBeNull();
  });

  it('works in local mode too (the mirror may have been primed)', async () => {
    vi.stubEnv('ACCESS_SOURCE', 'local');
    const res = await GET(get(), NO_PARAMS);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('local');
    expect(body.itSystem).toBeNull();
  });
});
