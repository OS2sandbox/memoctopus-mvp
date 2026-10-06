import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/authz/principal', () => ({ resolvePrincipal: vi.fn() }));
vi.mock('@/lib/skabeloner/central', () => ({ listScopeOrgUnits: vi.fn() }));

import { GET } from './route';
import { auth } from '@/lib/auth';
import { resolvePrincipal } from '@/lib/authz/principal';
import { listScopeOrgUnits } from '@/lib/skabeloner/central';
import { FAKE_SESSION, makeJsonReq, NO_PARAMS } from '@/test/helpers';
import { CHILD, manager, OWNER } from '@/test/central-fixtures';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockResolve = vi.mocked(resolvePrincipal);
const mockScope = vi.mocked(listScopeOrgUnits);

const get = () => GET(makeJsonReq('http://localhost/api/admin/central-templates/scope', 'GET'), NO_PARAMS);

beforeEach(() => {
  mockGetSession.mockReset().mockResolvedValue(FAKE_SESSION as never);
  mockResolve.mockReset().mockResolvedValue(manager);
  mockScope.mockReset().mockResolvedValue([
    { uuid: OWNER, name: 'Kommune', parentUuid: null },
    { uuid: CHILD, name: 'Skole', parentUuid: OWNER },
  ]);
});

describe('GET /api/admin/central-templates/scope', () => {
  it('returns exactly what the service scopes for the calling manager', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      orgUnits: [
        { uuid: OWNER, name: 'Kommune', parentUuid: null },
        { uuid: CHILD, name: 'Skole', parentUuid: OWNER },
      ],
    });
    expect(mockScope).toHaveBeenCalledWith(manager);
  });

  it('whitelists unit fields', async () => {
    mockScope.mockResolvedValue([
      { uuid: OWNER, name: 'K', parentUuid: null, source: 'local', memberCount: 9 } as never,
    ]);
    const { orgUnits } = await (await get()).json();
    expect(Object.keys(orgUnits[0]).sort()).toEqual(['name', 'parentUuid', 'uuid']);
  });

  it('an empty scope yields an empty list, not an error', async () => {
    mockScope.mockResolvedValue([]);
    expect(await (await get()).json()).toEqual({ orgUnits: [] });
  });
});
