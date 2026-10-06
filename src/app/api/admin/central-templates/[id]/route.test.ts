import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/authz/principal', () => ({ resolvePrincipal: vi.fn() }));
vi.mock('@/lib/skabeloner/central', () => ({ getManageableTemplate: vi.fn(), updateCentralTemplate: vi.fn() }));

import { GET, PUT } from './route';
import { auth } from '@/lib/auth';
import { resolvePrincipal } from '@/lib/authz/principal';
import { getManageableTemplate, updateCentralTemplate } from '@/lib/skabeloner/central';
import { NotFoundError, ValidationError, VersionConflictError, ConflictError } from '@/lib/authz/access-errors';
import { FAKE_SESSION, makeJsonReq, makePrincipal } from '@/test/helpers';
import { ADMIN_TEMPLATE, CHILD, manager, NOTE, T1 } from '../fixtures';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockResolve = vi.mocked(resolvePrincipal);
const mockGet = vi.mocked(getManageableTemplate);
const mockUpdate = vi.mocked(updateCentralTemplate);

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const url = (id: string) => `http://localhost/api/admin/central-templates/${id}`;
const get = (id = T1) => GET(makeJsonReq(url(id), 'GET'), ctx(id));
const put = (body?: unknown, id = T1) => PUT(makeJsonReq(url(id), 'PUT', body), ctx(id));

const BODY = { baseVersion: 3, changeNote: NOTE, prompt: 'Ny prompt' };

beforeEach(() => {
  vi.stubEnv('ACCESS_SOURCE', 'local');
  mockGetSession.mockReset().mockResolvedValue(FAKE_SESSION as never);
  mockResolve.mockReset().mockResolvedValue(manager);
  mockGet.mockReset().mockResolvedValue(ADMIN_TEMPLATE);
  mockUpdate.mockReset().mockResolvedValue({ ...ADMIN_TEMPLATE, currentVersion: 4 });
});

describe('GET /api/admin/central-templates/[id]', () => {
  it('401 / 403 gates', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    expect((await get()).status).toBe(401);
    mockResolve.mockResolvedValueOnce(makePrincipal());
    expect((await get()).status).toBe(403);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('returns the template including the prompt to a manager in scope', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ template: ADMIN_TEMPLATE });
    expect(mockGet).toHaveBeenCalledWith(manager, T1);
  });

  it('404 for an unknown or out-of-scope template (the service hides which)', async () => {
    mockGet.mockRejectedValue(new NotFoundError());
    expect((await get()).status).toBe(404);
  });

  it('400 for a malformed id without touching the service', async () => {
    expect((await get('nope')).status).toBe(400);
    expect(mockGet).not.toHaveBeenCalled();
  });
});

describe('PUT /api/admin/central-templates/[id]', () => {
  it('401 / 403 gates', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    expect((await put(BODY)).status).toBe(401);
    mockResolve.mockResolvedValueOnce(makePrincipal());
    expect((await put(BODY)).status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('updates and returns the new version', async () => {
    const res = await put(BODY);
    expect(res.status).toBe(200);
    expect((await res.json()).template.currentVersion).toBe(4);
    expect(mockUpdate).toHaveBeenCalledWith(manager, T1, BODY);
  });

  it('accepts a targets-only change', async () => {
    await put({ baseVersion: 3, changeNote: NOTE, targets: [{ orgUnitUuid: CHILD }] });
    expect(mockUpdate).toHaveBeenCalledWith(manager, T1, {
      baseVersion: 3,
      changeNote: NOTE,
      targets: [{ orgUnitUuid: CHILD, includeDescendants: true }],
    });
  });

  it('trims the change note before it reaches the service', async () => {
    await put({ ...BODY, changeNote: `   ${NOTE}   ` });
    expect(mockUpdate.mock.calls[0][2]).toMatchObject({ changeNote: NOTE });
  });

  it.each([
    ['missing baseVersion', { changeNote: NOTE, prompt: 'x' }],
    ['non-integer baseVersion', { ...BODY, baseVersion: 1.5 }],
    ['string baseVersion', { ...BODY, baseVersion: '3' }],
    ['zero baseVersion', { ...BODY, baseVersion: 0 }],
    ['missing changeNote', { baseVersion: 3, prompt: 'x' }],
    ['short changeNote', { ...BODY, changeNote: 'for kort' }],
    ['unknown key', { ...BODY, ownerOrgUnitUuid: T1 }],
    ['status smuggled in', { ...BODY, status: 'archived' }],
    ['blank prompt', { ...BODY, prompt: ' ' }],
    ['bad target uuid', { ...BODY, targets: [{ orgUnitUuid: 'x' }] }],
  ])('400 for %s', async (_n, body) => {
    expect((await put(body)).status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('the short-note 400 carries the Danish message', async () => {
    const res = await put({ ...BODY, changeNote: 'for kort' });
    expect((await res.json()).error).toBe('Beskriv ændringen (mindst 10 tegn)');
  });

  it('400 for a malformed path id', async () => {
    expect((await put(BODY, 'nope')).status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('404 for an out-of-scope template', async () => {
    mockUpdate.mockRejectedValue(new NotFoundError());
    expect((await put(BODY)).status).toBe(404);
  });

  it('409 with currentVersion on a stale baseVersion', async () => {
    mockUpdate.mockRejectedValue(new VersionConflictError(7));
    const res = await put(BODY);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'version_conflict', currentVersion: 7 });
  });

  it('409 for an archived template', async () => {
    mockUpdate.mockRejectedValue(new ConflictError('Gendan skabelonen først', 'template_archived'));
    const res = await put(BODY);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('template_archived');
  });

  it('400 when the service rejects targets outside the owner subtree or an empty change', async () => {
    mockUpdate.mockRejectedValueOnce(new ValidationError('Uden for ejerenhed', 'target_outside_owner'));
    expect((await put(BODY)).status).toBe(400);
    mockUpdate.mockRejectedValueOnce(new ValidationError('Ingen ændringer', 'no_changes'));
    const res = await put(BODY);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('no_changes');
  });

  it('works in rollekatalog mode', async () => {
    vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
    expect((await put(BODY)).status).toBe(200);
  });

  it('exposes no DELETE (there is no hard delete)', async () => {
    const mod = await import('./route');
    expect(mod).not.toHaveProperty('DELETE');
  });
});
