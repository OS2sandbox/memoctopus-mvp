import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/audit/authz-denied', () => ({ recordAuthzDenied: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/authz/principal', () => ({ resolvePrincipal: vi.fn() }));
vi.mock('@/lib/authz/access-admin', () => ({ updateOrgUnit: vi.fn(), deleteOrgUnit: vi.fn() }));

import { PATCH, DELETE } from './route';
import { auth } from '@/lib/auth';
import { resolvePrincipal } from '@/lib/authz/principal';
import { deleteOrgUnit, updateOrgUnit } from '@/lib/authz/access-admin';
import { ConflictError, NotFoundError, ReadOnlyModeError } from '@/lib/authz/access-errors';
import { FAKE_PRINCIPAL_ADMIN, FAKE_SESSION, makeJsonReq, makePrincipal } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockResolve = vi.mocked(resolvePrincipal);
const mockUpdate = vi.mocked(updateOrgUnit);
const mockDelete = vi.mocked(deleteOrgUnit);

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const VIEW = { uuid: U1, name: 'Ny', parentUuid: U2, source: 'local', memberCount: 0 };
const ctx = (uuid: string) => ({ params: Promise.resolve({ uuid }) });
const patch = (body?: unknown, uuid = U1) =>
  PATCH(makeJsonReq(`http://localhost/api/admin/access/org-units/${uuid}`, 'PATCH', body), ctx(uuid));
const del = (uuid = U1) =>
  DELETE(makeJsonReq(`http://localhost/api/admin/access/org-units/${uuid}`, 'DELETE'), ctx(uuid));

beforeEach(() => {
  vi.stubEnv('ACCESS_SOURCE', 'local');
  mockGetSession.mockReset().mockResolvedValue(FAKE_SESSION as never);
  mockResolve.mockReset().mockResolvedValue(FAKE_PRINCIPAL_ADMIN);
  mockUpdate.mockReset().mockResolvedValue(VIEW);
  mockDelete.mockReset().mockResolvedValue(undefined);
});

describe('PATCH /api/admin/access/org-units/[uuid] (access.manage)', () => {
  it('401 / 403 / 409 gates', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    expect((await patch({ name: 'x' })).status).toBe(401);

    mockResolve.mockResolvedValueOnce(makePrincipal());
    expect((await patch({ name: 'x' })).status).toBe(403);

    mockUpdate.mockRejectedValueOnce(new ReadOnlyModeError());
    expect((await patch({ name: 'x' })).status).toBe(409);
  });

  it('updates name and parent', async () => {
    const res = await patch({ name: 'Ny', parentUuid: U2 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orgUnit: VIEW });
    expect(mockUpdate).toHaveBeenCalledWith(U1, { name: 'Ny', parentUuid: U2 }, FAKE_SESSION.user.id);
  });

  it('parentUuid null moves the unit to the root', async () => {
    await patch({ parentUuid: null });
    expect(mockUpdate).toHaveBeenCalledWith(U1, { parentUuid: null }, FAKE_SESSION.user.id);
  });

  it.each([
    ['empty body', {}],
    ['unknown key', { name: 'x', managerUuid: U2 }],
    ['blank name', { name: ' ' }],
    ['bad parent', { parentUuid: 'x' }],
  ])('400 for %s', async (_n, body) => {
    expect((await patch(body)).status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('400 for a malformed path uuid', async () => {
    expect((await patch({ name: 'x' }, 'nope')).status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('404 for an unknown unit', async () => {
    mockUpdate.mockRejectedValue(new NotFoundError('Enheden findes ikke'));
    expect((await patch({ name: 'x' })).status).toBe(404);
  });

  it('409 when the move would create a cycle', async () => {
    mockUpdate.mockRejectedValue(new ConflictError('cycle', 'cycle'));
    const res = await patch({ parentUuid: U2 });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('cycle');
  });
});

describe('DELETE /api/admin/access/org-units/[uuid] (access.manage)', () => {
  it('401 / 403 / 409 gates', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    expect((await del()).status).toBe(401);

    mockResolve.mockResolvedValueOnce(makePrincipal());
    expect((await del()).status).toBe(403);

    mockDelete.mockRejectedValueOnce(new ReadOnlyModeError());
    expect((await del()).status).toBe(409);
  });

  it('deletes', async () => {
    const res = await del();
    expect(res.status).toBe(200);
    expect(mockDelete).toHaveBeenCalledWith(U1, FAKE_SESSION.user.id);
  });

  it('400 for a malformed uuid', async () => {
    expect((await del('nope')).status).toBe(400);
  });

  it('404 for an unknown unit; 409 when it has children or role assignments', async () => {
    mockDelete.mockRejectedValueOnce(new NotFoundError('Enheden findes ikke'));
    expect((await del()).status).toBe(404);
    mockDelete.mockRejectedValueOnce(new ConflictError('Enheden har underenheder', 'has_children'));
    expect((await del()).status).toBe(409);
    mockDelete.mockRejectedValueOnce(new ConflictError('Enheden har rolletildelinger', 'has_role_assignments'));
    expect((await del()).status).toBe(409);
  });
});
