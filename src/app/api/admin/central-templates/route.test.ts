import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/authz/principal', () => ({ resolvePrincipal: vi.fn() }));
vi.mock('@/lib/skabeloner/central', () => ({ listManageableTemplates: vi.fn(), createCentralTemplate: vi.fn() }));

import { GET, POST } from './route';
import { auth } from '@/lib/auth';
import { resolvePrincipal } from '@/lib/authz/principal';
import { createCentralTemplate, listManageableTemplates } from '@/lib/skabeloner/central';
import { NotFoundError, ValidationError } from '@/lib/authz/access-errors';
import { FAKE_PRINCIPAL_ADMIN, FAKE_SESSION, makeJsonReq, makePrincipal, NO_PARAMS } from '@/test/helpers';
import { ADMIN_TEMPLATE, CHILD, manager, NOTE, OWNER } from './fixtures';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockResolve = vi.mocked(resolvePrincipal);
const mockList = vi.mocked(listManageableTemplates);
const mockCreate = vi.mocked(createCentralTemplate);

const URL_ = 'http://localhost/api/admin/central-templates';
const ITEM = {
  id: ADMIN_TEMPLATE.id,
  name: 'Fagreferat',
  description: 'Til fagmøder',
  ownerOrgUnitUuid: OWNER,
  status: 'active' as const,
  currentVersion: 3,
  targetCount: 1,
  updatedAt: '2026-06-02T08:00:00.000Z',
};
const VALID = {
  ownerOrgUnitUuid: OWNER,
  name: 'Fagreferat',
  prompt: 'Skriv et referat',
  targets: [{ orgUnitUuid: CHILD, includeDescendants: true }],
  changeNote: NOTE,
};

const get = (qs = '') => GET(makeJsonReq(URL_ + qs, 'GET'), NO_PARAMS);
const post = (body?: unknown) => POST(makeJsonReq(URL_, 'POST', body), NO_PARAMS);

beforeEach(() => {
  vi.stubEnv('ACCESS_SOURCE', 'local');
  mockGetSession.mockReset().mockResolvedValue(FAKE_SESSION as never);
  mockResolve.mockReset().mockResolvedValue(manager);
  mockList.mockReset().mockResolvedValue([ITEM]);
  mockCreate.mockReset().mockResolvedValue(ADMIN_TEMPLATE);
});

describe('GET /api/admin/central-templates (template.manage)', () => {
  it('401 without a session, 403 without the capability', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    expect((await get()).status).toBe(401);

    mockResolve.mockResolvedValueOnce(makePrincipal());
    expect((await get()).status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('403 for a disabled manager', async () => {
    mockResolve.mockResolvedValueOnce({ ...manager, disabled: true });
    expect((await get()).status).toBe(403);
  });

  it('lists the caller scope, active only by default, uncached, without prompt text', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json();
    expect(body).toEqual({ templates: [ITEM] });
    expect(JSON.stringify(body)).not.toContain('prompt');
    expect(mockList).toHaveBeenCalledWith(manager, { status: 'active' });
  });

  it.each(['active', 'archived', 'all'])('passes ?status=%s on', async (status) => {
    await get(`?status=${status}`);
    expect(mockList).toHaveBeenCalledWith(manager, { status });
  });

  it.each(['?status=deleted', '?status=', '?foo=1'])('400 for %s', async (qs) => {
    expect((await get(qs)).status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('works for a global administrator too', async () => {
    mockResolve.mockResolvedValueOnce(FAKE_PRINCIPAL_ADMIN);
    expect((await get()).status).toBe(200);
  });

  it('does not depend on ACCESS_SOURCE', async () => {
    vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
    expect((await get()).status).toBe(200);
  });
});

describe('POST /api/admin/central-templates', () => {
  it('401 / 403 gates', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    expect((await post(VALID)).status).toBe(401);

    mockResolve.mockResolvedValueOnce(makePrincipal());
    expect((await post(VALID)).status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('creates, answering 201 with the admin DTO (prompt included for the manager)', async () => {
    const res = await post(VALID);
    expect(res.status).toBe(201);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ template: ADMIN_TEMPLATE });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const [principal, input] = mockCreate.mock.calls[0];
    expect(principal).toBe(manager);
    expect(input).toMatchObject({
      ownerOrgUnitUuid: OWNER,
      name: 'Fagreferat',
      changeNote: NOTE,
      allowUserInstruction: false,
    });
  });

  it('creates in rollekatalog mode as well (templates are not owned by Rollekatalog)', async () => {
    vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
    expect((await post(VALID)).status).toBe(201);
  });

  it('only returns whitelisted fields, never a raw service row', async () => {
    mockCreate.mockResolvedValueOnce({ ...ADMIN_TEMPLATE, createdByUserId: 'u-secret', extra: 1 } as never);
    const { template } = await (await post(VALID)).json();
    expect(template).not.toHaveProperty('createdByUserId');
    expect(template).not.toHaveProperty('extra');
  });

  it('400 with the Danish message for a too short change note', async () => {
    const res = await post({ ...VALID, changeNote: 'kort' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Beskriv ændringen (mindst 10 tegn)');
    expect(body.issues).toEqual([
      expect.objectContaining({ path: 'changeNote', message: 'Beskriv ændringen (mindst 10 tegn)' }),
    ]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('400 for a missing change note and for a whitespace-only one', async () => {
    const { changeNote: _omit, ...rest } = VALID;
    expect((await post(rest)).status).toBe(400);
    expect((await post({ ...VALID, changeNote: '            ' })).status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown key', { ...VALID, status: 'archived' }],
    ['bad owner uuid', { ...VALID, ownerOrgUnitUuid: 'x' }],
    ['bad target uuid', { ...VALID, targets: [{ orgUnitUuid: 'x' }] }],
    ['blank name', { ...VALID, name: ' ' }],
    ['blank prompt', { ...VALID, prompt: '  ' }],
    [
      'too many targets',
      {
        ...VALID,
        targets: Array.from({ length: 201 }, (_, i) => ({
          orgUnitUuid: `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`,
        })),
      },
    ],
    ['non-object body', 'x'],
  ])('400 for %s', async (_n, body) => {
    expect((await post(body)).status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('never echoes an unknown key name in the 400', async () => {
    const res = await post({ ...VALID, hemmeligNoegle: 1 });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toContain('hemmeligNoegle');
  });

  it('400 for malformed JSON', async () => {
    const { NextRequest } = await import('next/server');
    const req = new NextRequest(URL_, { method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' } });
    const res = await POST(req, NO_PARAMS);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_json');
  });

  it('404 when the owner unit is outside the caller scope', async () => {
    mockCreate.mockRejectedValue(new NotFoundError('Organisationsenheden findes ikke', 'org_unit_not_found'));
    const res = await post(VALID);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('org_unit_not_found');
  });

  it('400 when the service rejects targets outside the owner subtree', async () => {
    mockCreate.mockRejectedValue(new ValidationError('Modtagere skal ligge under ejerenheden', 'target_outside_owner'));
    const res = await post(VALID);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'target_outside_owner' });
  });
});
