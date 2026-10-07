import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/audit/authz-denied', () => ({ recordAuthzDenied: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/authz/principal', () => ({ resolvePrincipal: vi.fn() }));
vi.mock('@/lib/skabeloner/central', () => ({ listCatalogue: vi.fn() }));

import { GET } from './route';
import { auth } from '@/lib/auth';
import { resolvePrincipal } from '@/lib/authz/principal';
import { listCatalogue } from '@/lib/skabeloner/central';
import { FAKE_SESSION, makeJsonReq, makePrincipal, NO_PARAMS } from '@/test/helpers';
import { manager } from '@/test/central-fixtures';

const mockSession = vi.mocked(auth.api.getSession);
const mockResolve = vi.mocked(resolvePrincipal);
const mockCatalogue = vi.mocked(listCatalogue);

const URL_ = 'http://localhost/api/admin/central-templates/roles';
const get = () => GET(makeJsonReq(URL_, 'GET'), NO_PARAMS);

const globalManager = makePrincipal({
  roles: ['tt-bruger', 'tt-skabelonansvarlig'],
  capabilities: ['template.use', 'template.manage'],
  scopes: { 'template.manage': { global: true, roots: [] } },
});
const globalAdmin = makePrincipal({
  roles: ['tt-bruger', 'tt-administrator'],
  capabilities: ['template.use', 'template.manage', 'sync.run'],
  scopes: { 'template.manage': { global: true, roots: [] } },
});

const ENTRIES = [
  { kind: 'role' as const, identifier: 'sagsbehandler', name: 'Sagsbehandler', source: 'rollekatalog' as const, active: true, holders: 3 },
  { kind: 'group' as const, identifier: 'social', name: 'Socialforvaltningen', source: 'config' as const, active: false, holders: 0 },
];

beforeEach(() => {
  vi.stubEnv('ACCESS_SOURCE', 'claims');
  vi.stubEnv('ROLLEKATALOG_URL', 'https://rk.example.dk');
  vi.stubEnv('ROLLEKATALOG_READ_API_KEY', 'read-key');
  mockSession.mockReset().mockResolvedValue(FAKE_SESSION as never);
  mockResolve.mockReset().mockResolvedValue(globalManager);
  mockCatalogue.mockReset().mockResolvedValue({ entries: ENTRIES, lastRefreshedAt: '2026-06-02T08:00:00.000Z' });
});
afterEach(() => vi.unstubAllEnvs());

describe('GET /api/admin/central-templates/roles (template.manage)', () => {
  it('401 without a session, 403 without the capability, and the catalogue is not read', async () => {
    mockSession.mockResolvedValueOnce(null as never);
    expect((await get()).status).toBe(401);
    mockResolve.mockResolvedValueOnce(makePrincipal());
    expect((await get()).status).toBe(403);
    expect(mockCatalogue).not.toHaveBeenCalled();
  });

  it('returns the merged catalogue (names and identifiers, withdrawn entries too), uncached', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json();
    expect(body.roles).toEqual(ENTRIES);
    expect(body.lastRefreshedAt).toBe('2026-06-02T08:00:00.000Z');
  });

  it('canTarget only for a manager with a GLOBAL scope; a scoped one still sees the list', async () => {
    expect((await (await get()).json()).canTarget).toBe(true);
    mockResolve.mockResolvedValueOnce(manager);
    const scoped = await (await get()).json();
    expect(scoped.canTarget).toBe(false);
    expect(scoped.roles).toHaveLength(2);
  });

  it('canRefresh needs sync.run AND a configured Rollekatalog (URL and READ key)', async () => {
    expect((await (await get()).json()).canRefresh).toBe(false); // global manager without sync.run
    mockResolve.mockResolvedValueOnce(globalAdmin);
    expect((await (await get()).json()).canRefresh).toBe(true);
    vi.stubEnv('ROLLEKATALOG_READ_API_KEY', '');
    mockResolve.mockResolvedValueOnce(globalAdmin);
    expect((await (await get()).json()).canRefresh).toBe(false);
  });

  it('exposes nothing but the whitelisted catalogue fields', async () => {
    mockCatalogue.mockResolvedValueOnce({
      entries: [{ ...ENTRIES[0], cpr: '0101010000', itSystemName: 'X' } as never],
      lastRefreshedAt: null,
    });
    const body = await (await get()).json();
    expect(Object.keys(body.roles[0]).sort()).toEqual(['active', 'holders', 'identifier', 'kind', 'name', 'source']);
  });
});
