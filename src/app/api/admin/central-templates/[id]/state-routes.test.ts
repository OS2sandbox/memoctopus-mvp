import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/authz/principal', () => ({ resolvePrincipal: vi.fn() }));
vi.mock('@/lib/skabeloner/central', () => ({ archiveCentralTemplate: vi.fn(), restoreCentralTemplate: vi.fn() }));

import { POST as archivePost } from './archive/route';
import { POST as restorePost } from './restore/route';
import { auth } from '@/lib/auth';
import { resolvePrincipal } from '@/lib/authz/principal';
import { archiveCentralTemplate, restoreCentralTemplate } from '@/lib/skabeloner/central';
import { ConflictError, NotFoundError, VersionConflictError } from '@/lib/authz/access-errors';
import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';
import { ADMIN_TEMPLATE, manager, NOTE, T1 } from '@/test/central-fixtures';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockResolve = vi.mocked(resolvePrincipal);

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const BODY = { baseVersion: 3, changeNote: NOTE };

// Archive and restore are the same route shape: they differ only in the service
// function, the URL segment and the resulting status.
describe.each([
  { name: 'archive', POST: archivePost, fn: vi.mocked(archiveCentralTemplate), status: 'archived', conflictCode: 'already_archived' },
  { name: 'restore', POST: restorePost, fn: vi.mocked(restoreCentralTemplate), status: 'active', conflictCode: 'not_archived' },
])('POST /api/admin/central-templates/[id]/$name', ({ name, POST, fn, status, conflictCode }) => {
  const post = (body?: unknown, id = T1) =>
    POST(makeJsonReq(`http://localhost/api/admin/central-templates/${id}/${name}`, 'POST', body), ctx(id));

  beforeEach(() => {
    vi.stubEnv('ACCESS_SOURCE', 'local');
    mockGetSession.mockReset().mockResolvedValue(FAKE_SESSION as never);
    mockResolve.mockReset().mockResolvedValue(manager);
    vi.mocked(archiveCentralTemplate).mockReset();
    vi.mocked(restoreCentralTemplate).mockReset();
    fn.mockResolvedValue({ ...ADMIN_TEMPLATE, status, currentVersion: 4 } as never);
  });

  it('changes the status and returns the template', async () => {
    const res = await post(BODY);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect((await res.json()).template).toMatchObject({ status, currentVersion: 4 });
    expect(fn).toHaveBeenCalledWith(manager, T1, BODY);
  });

  it.each([
    ['no body fields', {}],
    ['short change note', { baseVersion: 3, changeNote: 'kort' }],
    ['missing baseVersion', { changeNote: NOTE }],
    ['unknown key', { ...BODY, prompt: 'x' }],
  ])('400 for %s', async (_n, body) => {
    expect((await post(body)).status).toBe(400);
    expect(fn).not.toHaveBeenCalled();
  });

  it('400 for a malformed path id', async () => {
    expect((await post(BODY, 'nope')).status).toBe(400);
  });

  it('404 for an out-of-scope template', async () => {
    fn.mockRejectedValue(new NotFoundError());
    expect((await post(BODY)).status).toBe(404);
  });

  it('409 with currentVersion on a stale baseVersion', async () => {
    fn.mockRejectedValue(new VersionConflictError(5));
    const res = await post(BODY);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ currentVersion: 5 });
  });

  it('409 when already in the target state', async () => {
    fn.mockRejectedValue(new ConflictError('Allerede', conflictCode));
    expect((await post(BODY)).status).toBe(409);
  });
});
