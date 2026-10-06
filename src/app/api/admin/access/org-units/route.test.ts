import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/audit/authz-denied', () => ({ recordAuthzDenied: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/authz/principal', () => ({ resolvePrincipal: vi.fn() }));
vi.mock('@/lib/authz/access-admin', () => ({ listOrgUnits: vi.fn(), createOrgUnit: vi.fn() }));
vi.mock('@/lib/authz/scope', () => ({ orgUnitsInScope: vi.fn() }));

import { GET, POST } from './route';
import { auth } from '@/lib/auth';
import { resolvePrincipal } from '@/lib/authz/principal';
import { createOrgUnit, listOrgUnits } from '@/lib/authz/access-admin';
import { orgUnitsInScope } from '@/lib/authz/scope';
import { ConflictError, NotFoundError, ReadOnlyModeError } from '@/lib/authz/access-errors';
import { FAKE_PRINCIPAL_ADMIN, FAKE_SESSION, makeJsonReq, NO_PARAMS, makePrincipal } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockResolve = vi.mocked(resolvePrincipal);
const mockList = vi.mocked(listOrgUnits);
const mockCreate = vi.mocked(createOrgUnit);
const mockScope = vi.mocked(orgUnitsInScope);

const URL_ = 'http://localhost/api/admin/access/org-units';
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const VIEW = { uuid: U1, name: 'Kommune', parentUuid: null, source: 'local', memberCount: 0 };

const manager = makePrincipal({
  roles: ['tt-bruger', 'tt-skabelonansvarlig'],
  capabilities: ['template.use', 'template.manage', 'directory.read'],
  scopes: { 'directory.read': { global: false, roots: [{ orgUnitUuid: U2, includeDescendants: true }] } },
});

beforeEach(() => {
  vi.stubEnv('ACCESS_SOURCE', 'local');
  mockGetSession.mockReset().mockResolvedValue(FAKE_SESSION as never);
  mockResolve.mockReset().mockResolvedValue(FAKE_PRINCIPAL_ADMIN);
  mockList.mockReset().mockResolvedValue([VIEW]);
  mockCreate.mockReset().mockResolvedValue(VIEW);
  mockScope.mockReset();
});

describe('GET /api/admin/access/org-units (access.manage, or directory.read within scope)', () => {
  const get = () => GET(makeJsonReq(URL_, 'GET'), NO_PARAMS);

  it('401 without a session', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    expect((await get()).status).toBe(401);
  });

  it('403 for a plain user (no directory.read)', async () => {
    mockResolve.mockResolvedValue(makePrincipal());
    expect((await get()).status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('an administrator gets the whole tree without a scope lookup', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).orgUnits).toEqual([VIEW]);
    expect(mockList).toHaveBeenCalledWith({});
    expect(mockScope).not.toHaveBeenCalled();
  });

  it('a scoped reader only gets the units inside its scope', async () => {
    mockResolve.mockResolvedValue(manager);
    mockScope.mockResolvedValue({ all: false, uuids: [U2] });
    await get();
    expect(mockScope).toHaveBeenCalledWith(manager, 'directory.read');
    expect(mockList).toHaveBeenCalledWith({ uuids: [U2] });
  });

  it('a global directory reader without access.manage sees everything', async () => {
    mockResolve.mockResolvedValue(makePrincipal({ capabilities: ['template.use', 'directory.read'], scopes: { 'directory.read': { global: true, roots: [] } } }));
    mockScope.mockResolvedValue({ all: true });
    await get();
    expect(mockList).toHaveBeenCalledWith({});
  });

  it('works in rollekatalog mode (read-only view)', async () => {
    vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
    expect((await get()).status).toBe(200);
  });
});

describe('POST /api/admin/access/org-units (access.manage)', () => {
  const post = (body?: unknown) => POST(makeJsonReq(URL_, 'POST', body), NO_PARAMS);

  it('401 without a session', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    expect((await post({ name: 'x' })).status).toBe(401);
  });

  it('403 even for a scoped template manager', async () => {
    mockResolve.mockResolvedValue(manager);
    expect((await post({ name: 'x' })).status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('409 when the service refuses in rollekatalog mode', async () => {
    mockCreate.mockRejectedValue(new ReadOnlyModeError());
    const res = await post({ name: 'x' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Rollekatalog/);
  });

  it('201 with whitelisted fields; name is passed through for the service to trim', async () => {
    const res = await post({ name: 'Kommune', parentUuid: U2 });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ orgUnit: VIEW });
    expect(mockCreate).toHaveBeenCalledWith({ name: 'Kommune', parentUuid: U2, actorUserId: FAKE_SESSION.user.id });
  });

  it('trims the name at the boundary', async () => {
    await post({ name: '  Kommune  ' });
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ name: 'Kommune' }));
  });

  it.each([
    ['unknown key', { name: 'x', source: 'rollekatalog' }],
    ['missing name', {}],
    ['blank name', { name: '   ' }],
    ['name too long', { name: 'x'.repeat(201) }],
    ['non-string name', { name: 5 }],
    ['bad parent uuid', { name: 'x', parentUuid: 'abc' }],
  ])('400 for %s', async (_n, body) => {
    expect((await post(body)).status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('404 when the parent is unknown and 409 on conflict', async () => {
    mockCreate.mockRejectedValueOnce(new NotFoundError('Den overordnede enhed findes ikke', 'parent_not_found'));
    expect((await post({ name: 'x', parentUuid: U2 })).status).toBe(404);
    mockCreate.mockRejectedValueOnce(new ConflictError('x'));
    expect((await post({ name: 'x' })).status).toBe(409);
  });
});
