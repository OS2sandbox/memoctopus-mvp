import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/audit/authz-denied', () => ({ recordAuthzDenied: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/authz/principal', () => ({ resolvePrincipal: vi.fn() }));
vi.mock('@/lib/authz/access-admin', () => ({ listAppUsersWithRoles: vi.fn() }));

import { GET } from './route';
import { auth } from '@/lib/auth';
import { resolvePrincipal } from '@/lib/authz/principal';
import { listAppUsersWithRoles } from '@/lib/authz/access-admin';
import { FAKE_PRINCIPAL_ADMIN, FAKE_SESSION, makeJsonReq, NO_PARAMS, makePrincipal } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockResolve = vi.mocked(resolvePrincipal);
const mockList = vi.mocked(listAppUsersWithRoles);
const req = (qs = '') => makeJsonReq(`http://localhost/api/admin/access/users${qs}`, 'GET');

beforeEach(() => {
  vi.stubEnv('ACCESS_SOURCE', 'local');
  mockGetSession.mockReset().mockResolvedValue(FAKE_SESSION as never);
  mockResolve.mockReset().mockResolvedValue(FAKE_PRINCIPAL_ADMIN);
  mockList.mockReset().mockResolvedValue([]);
});

describe('GET /api/admin/access/users (access.manage)', () => {
  it('401 without a session', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    expect((await GET(req(), NO_PARAMS)).status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('403 without access.manage, even for a log reader with directory.read', async () => {
    mockResolve.mockResolvedValue(
      makePrincipal({ roles: ['tt-bruger', 'tt-logleser'], capabilities: ['template.use', 'audit.read', 'directory.read'] }),
    );
    expect((await GET(req(), NO_PARAMS)).status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('returns the users from the service', async () => {
    mockList.mockResolvedValue([{ id: 'u1', name: 'A', email: 'a@x.dk', directoryUserUuid: null, disabled: false, roles: [] }]);
    const res = await GET(req(), NO_PARAMS);
    expect(res.status).toBe(200);
    expect((await res.json()).users).toHaveLength(1);
  });

  it('is readable in rollekatalog mode (read-only view)', async () => {
    vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
    expect((await GET(req(), NO_PARAMS)).status).toBe(200);
  });

  it('passes validated q and limit through', async () => {
    await GET(req('?q=anna&limit=10'), NO_PARAMS);
    expect(mockList).toHaveBeenCalledWith({ q: 'anna', limit: 10 });
  });

  it.each(['?limit=0', '?limit=501', '?limit=abc', '?foo=1', `?q=${'x'.repeat(101)}`])('400 for %s', async (qs) => {
    const res = await GET(req(qs), NO_PARAMS);
    expect(res.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });
});
