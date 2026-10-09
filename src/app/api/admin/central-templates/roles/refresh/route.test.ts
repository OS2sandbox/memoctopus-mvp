import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/audit/authz-denied', () => ({ recordAuthzDenied: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/authz/principal', () => ({ resolvePrincipal: vi.fn() }));
vi.mock('@/lib/db', () => ({ pool: { query: vi.fn() }, db: {} }));
vi.mock('@/lib/rollekatalog/catalogue-sync', () => ({ runCatalogueRefresh: vi.fn() }));

import { NextRequest } from 'next/server';
import { POST } from './route';
import { auth } from '@/lib/auth';
import { resolvePrincipal } from '@/lib/authz/principal';
import { runCatalogueRefresh } from '@/lib/rollekatalog/catalogue-sync';
import { FAKE_SESSION, makePrincipal, NO_PARAMS } from '@/test/helpers';
import { manager } from '@/test/central-fixtures';

const mockSession = vi.mocked(auth.api.getSession);
const mockResolve = vi.mocked(resolvePrincipal);
const mockRun = vi.mocked(runCatalogueRefresh);

const admin = makePrincipal({
  roles: ['bruger', 'admin'],
  capabilities: ['template.use', 'template.manage', 'sync.run'],
  scopes: { 'template.manage': { global: true, roots: [] }, 'sync.run': { global: true, roots: [] } },
});

const counts = { fetched: 5, added: 2, updated: 3, deactivated: 1, skipped: 0 };
const post = (body?: unknown, raw?: string) =>
  POST(
    new NextRequest('http://localhost/api/admin/central-templates/roles/refresh', {
      method: 'POST',
      ...(raw !== undefined ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    NO_PARAMS,
  );

beforeEach(() => {
  vi.stubEnv('ROLLEKATALOG_URL', 'https://rk.example.dk');
  vi.stubEnv('ROLLEKATALOG_READ_API_KEY', 'read-key-value');
  mockSession.mockReset().mockResolvedValue(FAKE_SESSION as never);
  mockResolve.mockReset().mockResolvedValue(admin);
  mockRun.mockReset().mockResolvedValue({ status: 'success', counts, errorCode: null });
});
afterEach(() => vi.unstubAllEnvs());

describe('POST /api/admin/central-templates/roles/refresh (sync.run)', () => {
  it('401 without a session; 403 for a template manager without sync.run; nothing runs', async () => {
    mockSession.mockResolvedValueOnce(null as never);
    expect((await post()).status).toBe(401);
    mockResolve.mockResolvedValueOnce(manager);
    expect((await post()).status).toBe(403);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('runs a manual refresh and reports counts only (no keys, no catalogue data)', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(mockRun).toHaveBeenCalledWith({ trigger: 'manual', force: false });
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ status: 'success', counts, errorCode: null });
    expect(text).not.toContain('read-key-value');
  });

  it('passes force on, and rejects unknown keys and bad JSON', async () => {
    await post({ force: true });
    expect(mockRun).toHaveBeenLastCalledWith({ trigger: 'manual', force: true });
    expect((await post({ force: 'yes' })).status).toBe(400);
    expect((await post({ other: 1 })).status).toBe(400);
    expect((await post(undefined, '{')).status).toBe(400);
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('409 not_configured without a URL or READ key, and nothing runs (works in every access mode)', async () => {
    vi.stubEnv('ROLLEKATALOG_READ_API_KEY', '');
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('not_configured');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it.each([
    ['aborted', 'removal_threshold', 502],
    ['aborted', 'empty_response', 502],
    ['error', 'unauthorized', 502],
    ['error', 'db_error', 500],
    ['already_running', 'already_running', 409],
  ] as const)('%s / %s -> %i with a Danish message and the short code', async (status, errorCode, http) => {
    mockRun.mockResolvedValueOnce({ status, counts: { ...counts, fetched: 0, added: 0, updated: 0, deactivated: 0 }, errorCode });
    const res = await post();
    expect(res.status).toBe(http);
    const body = await res.json();
    expect(body.code).toBe(errorCode);
    expect(body.error).toMatch(/[a-zæøå]/i);
    expect(body.error).not.toContain(errorCode);
  });
});
