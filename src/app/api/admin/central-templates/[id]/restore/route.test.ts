import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/authz/principal', () => ({ resolvePrincipal: vi.fn() }));
vi.mock('@/lib/skabeloner/central', () => ({ restoreCentralTemplate: vi.fn() }));

import { POST } from './route';
import { auth } from '@/lib/auth';
import { resolvePrincipal } from '@/lib/authz/principal';
import { restoreCentralTemplate } from '@/lib/skabeloner/central';
import { ConflictError, NotFoundError, VersionConflictError } from '@/lib/authz/access-errors';
import { FAKE_SESSION, makeJsonReq, makePrincipal } from '@/test/helpers';
import { ADMIN_TEMPLATE, manager, NOTE, T1 } from '../../fixtures';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockResolve = vi.mocked(resolvePrincipal);
const mockFn = vi.mocked(restoreCentralTemplate);

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body?: unknown, id = T1) =>
  POST(makeJsonReq(`http://localhost/api/admin/central-templates/${id}/restore`, 'POST', body), ctx(id));
const BODY = { baseVersion: 3, changeNote: NOTE };

beforeEach(() => {
  vi.stubEnv('ACCESS_SOURCE', 'local');
  mockGetSession.mockReset().mockResolvedValue(FAKE_SESSION as never);
  mockResolve.mockReset().mockResolvedValue(manager);
  mockFn.mockReset().mockResolvedValue({ ...ADMIN_TEMPLATE, status: 'active', currentVersion: 4 });
});

describe('POST /api/admin/central-templates/[id]/restore', () => {
  it('401 / 403 gates', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    expect((await post(BODY)).status).toBe(401);
    mockResolve.mockResolvedValueOnce(makePrincipal());
    expect((await post(BODY)).status).toBe(403);
    expect(mockFn).not.toHaveBeenCalled();
  });

  it('changes the status and returns the template', async () => {
    const res = await post(BODY);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect((await res.json()).template).toMatchObject({ status: 'active', currentVersion: 4 });
    expect(mockFn).toHaveBeenCalledWith(manager, T1, BODY);
  });

  it.each([
    ['no body fields', {}],
    ['short change note', { baseVersion: 3, changeNote: 'kort' }],
    ['missing baseVersion', { changeNote: NOTE }],
    ['unknown key', { ...BODY, prompt: 'x' }],
  ])('400 for %s', async (_n, body) => {
    expect((await post(body)).status).toBe(400);
    expect(mockFn).not.toHaveBeenCalled();
  });

  it('400 for a malformed path id', async () => {
    expect((await post(BODY, 'nope')).status).toBe(400);
  });

  it('404 for an out-of-scope template', async () => {
    mockFn.mockRejectedValue(new NotFoundError());
    expect((await post(BODY)).status).toBe(404);
  });

  it('409 with currentVersion on a stale baseVersion', async () => {
    mockFn.mockRejectedValue(new VersionConflictError(5));
    const res = await post(BODY);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ currentVersion: 5 });
  });

  it('409 when already in the target state', async () => {
    mockFn.mockRejectedValue(new ConflictError('Allerede', 'not_archived'));
    expect((await post(BODY)).status).toBe(409);
  });
});
