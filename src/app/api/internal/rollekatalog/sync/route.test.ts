import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/db', () => ({ pool: { query: vi.fn() }, db: {} }));
vi.mock('@/lib/rollekatalog/sync', () => ({ runSync: vi.fn() }));

import { NextRequest } from 'next/server';
import { POST } from './route';
import { runSync } from '@/lib/rollekatalog/sync';
import { emptySyncCounts, type SyncResult } from '@/lib/rollekatalog/types';

const SECRET = 'cron-secret-value';
const mockRun = vi.mocked(runSync);
const post = (secret: string | null = SECRET, body?: unknown) =>
  new NextRequest('http://localhost/api/internal/rollekatalog/sync', {
    method: 'POST',
    headers: secret === null ? {} : { 'x-cron-secret': secret },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const counts = { ...emptySyncCounts(), usersUpserted: 4, orgUnitsUpserted: 2 };
const result = (over: Partial<SyncResult>): SyncResult => ({ status: 'success', runId: 'run-1', counts, errorCode: null, ...over });

beforeEach(() => {
  vi.stubEnv('INTERNAL_CRON_SECRET', SECRET);
  vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
  vi.stubEnv('ROLLEKATALOG_URL', 'https://rk.example.dk');
  vi.stubEnv('ROLLEKATALOG_READ_API_KEY', 'read-key');
  vi.stubEnv('ROLLEKATALOG_ORG_API_KEY', 'org-key');
  mockRun.mockReset().mockResolvedValue(result({}));
});
afterEach(() => vi.unstubAllEnvs());

describe('POST /api/internal/rollekatalog/sync', () => {
  it('404 when INTERNAL_CRON_SECRET is unset, and nothing runs', async () => {
    vi.stubEnv('INTERNAL_CRON_SECRET', '');
    expect((await POST(post())).status).toBe(404);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it.each([
    ['no secret', null],
    ['a wrong secret', 'nope'],
    ['a near miss', `${SECRET}x`],
  ])('401 for %s, and nothing runs', async (_l, secret) => {
    const res = await POST(post(secret));
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(SECRET);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('409 not_rollekatalog_mode in local mode, and nothing runs', async () => {
    vi.stubEnv('ACCESS_SOURCE', 'local');
    const res = await POST(post());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not_rollekatalog_mode', code: 'not_rollekatalog_mode' });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it.each([
    ['no URL', 'ROLLEKATALOG_URL', '', 'not_configured'],
    ['a missing read key', 'ROLLEKATALOG_READ_API_KEY', '', 'not_configured'],
    ['a missing org key', 'ROLLEKATALOG_ORG_API_KEY', '', 'not_configured'],
    ['an insecure URL', 'ROLLEKATALOG_URL', 'http://rk.example.dk', 'insecure_url'],
  ])('409 not_configured with %s, and nothing runs', async (_l, name, value, code) => {
    vi.stubEnv(name, value);
    const res = await POST(post());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not_configured', code });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('the guards come after the secret check', async () => {
    vi.stubEnv('ACCESS_SOURCE', 'local');
    expect((await POST(post('nope'))).status).toBe(401);
  });

  it('runs a cron sync and returns exactly status, counts and errorCode', async () => {
    const res = await POST(post());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'success', counts, errorCode: null });
    expect(mockRun).toHaveBeenCalledWith({ trigger: 'cron' });
  });

  it('never forces, even if the caller sends force in a body', async () => {
    await POST(post(SECRET, { force: true }));
    expect(mockRun).toHaveBeenCalledWith({ trigger: 'cron' });
  });

  it('409 when another run holds the lock', async () => {
    mockRun.mockResolvedValue(result({ status: 'already_running', runId: null, counts: emptySyncCounts() }));
    const res = await POST(post());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ status: 'already_running' });
  });

  it.each(['empty_response', 'removal_threshold'])('502 with the code for an aborted run (%s)', async (code) => {
    mockRun.mockResolvedValue(result({ status: 'aborted', errorCode: code }));
    const res = await POST(post());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ status: 'aborted', counts, errorCode: code });
  });

  it('502 for an upstream error code, 500 for an unexpected one', async () => {
    mockRun.mockResolvedValue(result({ status: 'error', errorCode: 'timeout' }));
    expect((await POST(post())).status).toBe(502);
    mockRun.mockResolvedValue(result({ status: 'error', errorCode: 'unexpected' }));
    expect((await POST(post())).status).toBe(500);
  });

  it('the body never carries the run id or any extra field', async () => {
    mockRun.mockResolvedValue(result({ status: 'error', errorCode: 'network' }));
    const body = await (await POST(post())).json();
    expect(Object.keys(body).sort()).toEqual(['counts', 'errorCode', 'status']);
  });

  it('a crashing sync is a JSON 500 without the error text', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockRun.mockRejectedValue(new Error('connection to 10.1.2.3 refused'));
    const res = await POST(post());
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('10.1.2.3');
    err.mockRestore();
  });
});
