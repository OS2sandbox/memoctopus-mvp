import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/authz/principal', () => ({ resolvePrincipal: vi.fn() }));
vi.mock('@/lib/authz/access-admin', () => ({ listOrgUnitMembers: vi.fn(), setOrgUnitMembers: vi.fn() }));

import { GET, PUT } from './route';
import { auth } from '@/lib/auth';
import { resolvePrincipal } from '@/lib/authz/principal';
import { listOrgUnitMembers, setOrgUnitMembers } from '@/lib/authz/access-admin';
import { ConflictError, NotFoundError } from '@/lib/authz/access-errors';
import { FAKE_PRINCIPAL_ADMIN, FAKE_SESSION, makeJsonReq, makePrincipal } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockResolve = vi.mocked(resolvePrincipal);
const mockList = vi.mocked(listOrgUnitMembers);
const mockSet = vi.mocked(setOrgUnitMembers);

const U1 = '11111111-1111-4111-8111-111111111111';
const MEMBERS = [{ directoryUserUuid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', appUserId: 'a1', name: 'Anna' }];
const ctx = (uuid: string) => ({ params: Promise.resolve({ uuid }) });
const url = (uuid: string) => `http://localhost/api/admin/access/org-units/${uuid}/members`;
const put = (body?: unknown, uuid = U1) => PUT(makeJsonReq(url(uuid), 'PUT', body), ctx(uuid));
const get = (uuid = U1) => GET(makeJsonReq(url(uuid), 'GET'), ctx(uuid));

beforeEach(() => {
  vi.stubEnv('ACCESS_SOURCE', 'local');
  mockGetSession.mockReset().mockResolvedValue(FAKE_SESSION as never);
  mockResolve.mockReset().mockResolvedValue(FAKE_PRINCIPAL_ADMIN);
  mockList.mockReset().mockResolvedValue(MEMBERS);
  mockSet.mockReset().mockResolvedValue(MEMBERS);
});

describe('GET /api/admin/access/org-units/[uuid]/members (access.manage)', () => {
  it('401 / 403', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    expect((await get()).status).toBe(401);
    mockResolve.mockResolvedValueOnce(makePrincipal());
    expect((await get()).status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('lists the members, also in rollekatalog mode', async () => {
    vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ members: MEMBERS });
  });

  it('400 for a bad uuid; 404 for an unknown unit', async () => {
    expect((await get('nope')).status).toBe(400);
    mockList.mockRejectedValue(new NotFoundError('Enheden findes ikke'));
    expect((await get()).status).toBe(404);
  });
});

describe('PUT /api/admin/access/org-units/[uuid]/members (access.manage)', () => {
  it('401 / 403 / 409 gates', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    expect((await put({ appUserIds: [] })).status).toBe(401);
    mockResolve.mockResolvedValueOnce(makePrincipal());
    expect((await put({ appUserIds: [] })).status).toBe(403);
    vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
    expect((await put({ appUserIds: [] })).status).toBe(409);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('replaces the membership', async () => {
    const res = await put({ appUserIds: ['a1', 'a2'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ members: MEMBERS });
    expect(mockSet).toHaveBeenCalledWith(U1, ['a1', 'a2'], FAKE_SESSION.user.id);
  });

  it.each([
    ['missing list', {}],
    ['unknown key', { appUserIds: [], extra: 1 }],
    ['non-array', { appUserIds: 'a1' }],
    ['empty id', { appUserIds: [''] }],
    ['non-string id', { appUserIds: [1] }],
    ['too many', { appUserIds: Array.from({ length: 1001 }, (_, i) => `u${i}`) }],
  ])('400 for %s', async (_n, body) => {
    expect((await put(body)).status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('400 for a bad path uuid', async () => {
    expect((await put({ appUserIds: [] }, 'nope')).status).toBe(400);
  });

  it('404 for an unknown unit or user; 409 for a rollekatalog-sourced unit', async () => {
    mockSet.mockRejectedValueOnce(new NotFoundError('Enheden findes ikke'));
    expect((await put({ appUserIds: [] })).status).toBe(404);
    mockSet.mockRejectedValueOnce(new NotFoundError('En bruger findes ikke', 'user_not_found'));
    expect((await put({ appUserIds: ['ghost'] })).status).toBe(404);
    mockSet.mockRejectedValueOnce(new ConflictError('Enheden styres af Rollekatalog', 'not_local'));
    expect((await put({ appUserIds: [] })).status).toBe(409);
  });
});
