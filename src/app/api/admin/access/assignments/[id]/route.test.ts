import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/audit/authz-denied', () => ({ recordAuthzDenied: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/authz/principal', () => ({ resolvePrincipal: vi.fn() }));
vi.mock('@/lib/authz/access-admin', () => ({ revokeAssignment: vi.fn() }));

import { DELETE } from './route';
import { auth } from '@/lib/auth';
import { resolvePrincipal } from '@/lib/authz/principal';
import { revokeAssignment } from '@/lib/authz/access-admin';
import { ConflictError, NotFoundError, ReadOnlyModeError } from '@/lib/authz/access-errors';
import { FAKE_PRINCIPAL_ADMIN, FAKE_SESSION, makeJsonReq, makePrincipal } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockResolve = vi.mocked(resolvePrincipal);
const mockRevoke = vi.mocked(revokeAssignment);

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const del = (id: string = ID) =>
  DELETE(makeJsonReq(`http://localhost/api/admin/access/assignments/${id}`, 'DELETE'), { params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.stubEnv('ACCESS_SOURCE', 'local');
  mockGetSession.mockReset().mockResolvedValue(FAKE_SESSION as never);
  mockResolve.mockReset().mockResolvedValue(FAKE_PRINCIPAL_ADMIN);
  mockRevoke.mockReset().mockResolvedValue(undefined);
});

describe('DELETE /api/admin/access/assignments/[id] (access.manage)', () => {
  it('401 without a session', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    expect((await del()).status).toBe(401);
  });

  it('403 without access.manage', async () => {
    mockResolve.mockResolvedValue(makePrincipal());
    expect((await del()).status).toBe(403);
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it('409 when the service refuses in rollekatalog mode', async () => {
    mockRevoke.mockRejectedValue(new ReadOnlyModeError());
    const res = await del();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('read_only');
  });

  it('400 for a malformed id', async () => {
    const res = await del('not-a-uuid');
    expect(res.status).toBe(400);
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it('revokes with the acting admin id', async () => {
    const res = await del();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockRevoke).toHaveBeenCalledWith(ID, FAKE_SESSION.user.id);
  });

  it('404 when the assignment does not exist', async () => {
    mockRevoke.mockRejectedValue(new NotFoundError('Rolletildelingen findes ikke'));
    expect((await del()).status).toBe(404);
  });

  it('409 for the last administrator', async () => {
    mockRevoke.mockRejectedValue(new ConflictError('Den sidste administrator kan ikke fjernes', 'last_administrator'));
    const res = await del();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('last_administrator');
  });
});
