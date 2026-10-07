import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/db', () => ({ pool: { query: vi.fn() }, db: {} }));
vi.mock('@/lib/rollekatalog/catalogue-sync', () => ({ runCatalogueRefresh: vi.fn() }));

import { NextRequest } from 'next/server';
import { POST } from './route';
import { runCatalogueRefresh } from '@/lib/rollekatalog/catalogue-sync';

const SECRET = 'cron-secret-value';
const mockRun = vi.mocked(runCatalogueRefresh);
const post = (secret: string | null = SECRET) =>
  new NextRequest('http://localhost/api/internal/rollekatalog/roles', {
    method: 'POST',
    headers: secret === null ? {} : { 'x-cron-secret': secret },
  });
const counts = { fetched: 4, added: 1, updated: 3, deactivated: 0, skipped: 0 };

beforeEach(() => {
  vi.stubEnv('INTERNAL_CRON_SECRET', SECRET);
  vi.stubEnv('ACCESS_SOURCE', 'claims');
  vi.stubEnv('ROLLEKATALOG_URL', 'https://rk.example.dk');
  vi.stubEnv('ROLLEKATALOG_READ_API_KEY', 'read-key');
  mockRun.mockReset().mockResolvedValue({ status: 'success', counts, errorCode: null });
});
afterEach(() => vi.unstubAllEnvs());

describe('POST /api/internal/rollekatalog/roles', () => {
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

  it('runs in claims mode (the catalogue does not depend on ACCESS_SOURCE) and reports counts only', async () => {
    for (const mode of ['claims', 'local', 'rollekatalog']) {
      vi.stubEnv('ACCESS_SOURCE', mode);
      const res = await POST(post());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'success', counts, errorCode: null });
    }
    // Never forced by a cron: only the admin button may bypass the removal threshold.
    expect(mockRun).toHaveBeenCalledWith({ trigger: 'cron' });
  });

  it.each([
    ['no URL', 'ROLLEKATALOG_URL', '', 'not_configured'],
    ['no READ key', 'ROLLEKATALOG_READ_API_KEY', '', 'not_configured'],
    ['an insecure URL', 'ROLLEKATALOG_URL', 'http://rk.example.dk', 'insecure_url'],
  ])('409 with %s, and nothing runs', async (_l, name, value, code) => {
    vi.stubEnv(name, value);
    const res = await POST(post());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not_configured', code });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('the ORG key is not needed (the catalogue uses the READ key only)', async () => {
    vi.stubEnv('ROLLEKATALOG_ORG_API_KEY', '');
    expect((await POST(post())).status).toBe(200);
  });

  it('maps an upstream failure to 502 and a database failure to 500, with the short code only', async () => {
    mockRun.mockResolvedValueOnce({ status: 'error', counts, errorCode: 'timeout' });
    const a = await POST(post());
    expect(a.status).toBe(502);
    expect((await a.json()).errorCode).toBe('timeout');
    mockRun.mockResolvedValueOnce({ status: 'error', counts, errorCode: 'db_error' });
    expect((await POST(post())).status).toBe(500);
    mockRun.mockResolvedValueOnce({ status: 'already_running', counts, errorCode: 'already_running' });
    expect((await POST(post())).status).toBe(409);
  });
});
