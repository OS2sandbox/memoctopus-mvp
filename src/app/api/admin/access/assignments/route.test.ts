import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/authz/principal', () => ({ resolvePrincipal: vi.fn() }));
vi.mock('@/lib/authz/access-admin', () => ({ grantRole: vi.fn() }));

import { POST } from './route';
import { auth } from '@/lib/auth';
import { resolvePrincipal } from '@/lib/authz/principal';
import { grantRole } from '@/lib/authz/access-admin';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/authz/access-errors';
import { FAKE_PRINCIPAL_ADMIN, FAKE_SESSION, makeJsonReq, NO_PARAMS, makePrincipal } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockResolve = vi.mocked(resolvePrincipal);
const mockGrant = vi.mocked(grantRole);
const post = (body?: unknown) => POST(makeJsonReq('http://localhost/api/admin/access/assignments', 'POST', body), NO_PARAMS);

const UNIT = '11111111-1111-4111-8111-111111111111';
const VIEW = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  roleKey: 'tt-logleser',
  scopeOrgUnitUuid: null,
  scopeOrgUnitName: null,
  includeDescendants: true,
  startDate: null,
  stopDate: null,
  source: 'local',
  active: true,
};

beforeEach(() => {
  vi.stubEnv('ACCESS_SOURCE', 'local');
  mockGetSession.mockReset().mockResolvedValue(FAKE_SESSION as never);
  mockResolve.mockReset().mockResolvedValue(FAKE_PRINCIPAL_ADMIN);
  mockGrant.mockReset().mockResolvedValue(VIEW);
});

describe('POST /api/admin/access/assignments (access.manage)', () => {
  it('401 without a session', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    expect((await post({ appUserId: 'u', roleKey: 'tt-bruger' })).status).toBe(401);
  });

  it('403 without access.manage, and nothing is granted', async () => {
    mockResolve.mockResolvedValue(makePrincipal());
    expect((await post({ appUserId: 'u', roleKey: 'tt-administrator' })).status).toBe(403);
    expect(mockGrant).not.toHaveBeenCalled();
  });

  it('409 with the Rollekatalog message in rollekatalog mode, before validating the body', async () => {
    vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
    const res = await post({ bogus: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('Skrivebeskyttet: roller og organisation styres af Rollekatalog');
    expect(mockGrant).not.toHaveBeenCalled();
  });

  it('403 still wins over 409 for a caller without access in rollekatalog mode', async () => {
    vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
    mockResolve.mockResolvedValue(makePrincipal());
    expect((await post({ appUserId: 'u', roleKey: 'tt-bruger' })).status).toBe(403);
  });

  it('201 and the acting admin id on the happy path, with dates coerced', async () => {
    const res = await post({
      appUserId: 'app-1',
      roleKey: 'tt-skabelonansvarlig',
      scopeOrgUnitUuid: UNIT,
      includeDescendants: false,
      startDate: '2026-01-01',
      stopDate: '2027-01-01T00:00:00Z',
    });
    expect(res.status).toBe(201);
    expect((await res.json()).assignment.id).toBe(VIEW.id);
    expect(mockGrant).toHaveBeenCalledWith({
      appUserId: 'app-1',
      roleKey: 'tt-skabelonansvarlig',
      scopeOrgUnitUuid: UNIT,
      includeDescendants: false,
      startDate: new Date('2026-01-01'),
      stopDate: new Date('2027-01-01T00:00:00Z'),
      actorUserId: FAKE_SESSION.user.id,
    });
  });

  it('accepts null scope and null dates', async () => {
    const res = await post({ appUserId: 'app-1', roleKey: 'tt-logleser', scopeOrgUnitUuid: null, startDate: null, stopDate: null });
    expect(res.status).toBe(201);
  });

  it.each([
    ['unknown key', { appUserId: 'u', roleKey: 'tt-bruger', isAdmin: true }],
    ['unknown role', { appUserId: 'u', roleKey: 'tt-god' }],
    ['missing user', { roleKey: 'tt-bruger' }],
    ['empty user', { appUserId: '', roleKey: 'tt-bruger' }],
    ['bad scope uuid', { appUserId: 'u', roleKey: 'tt-logleser', scopeOrgUnitUuid: 'not-a-uuid' }],
    ['numeric date', { appUserId: 'u', roleKey: 'tt-bruger', startDate: 12345 }],
    ['free-text date', { appUserId: 'u', roleKey: 'tt-bruger', startDate: 'next tuesday' }],
    ['non-boolean flag', { appUserId: 'u', roleKey: 'tt-logleser', includeDescendants: 'yes' }],
    ['array body', [1]],
    ['null body', null],
  ])('400 for %s', async (_n, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(mockGrant).not.toHaveBeenCalled();
  });

  it('400 for invalid JSON', async () => {
    const res = await POST(new Request('http://localhost/x', { method: 'POST', body: '{nope' }) as never, NO_PARAMS);
    expect(res.status).toBe(400);
  });

  it('does not echo the offending input in validation errors', async () => {
    const res = await post({ appUserId: 'u', roleKey: 'tt-bruger', secretField: 'hunter2' });
    expect(JSON.stringify(await res.json())).not.toContain('hunter2');
  });

  it('maps the scope rules of the service to 400', async () => {
    mockGrant.mockRejectedValue(new ValidationError('Rollen kræver en organisationsenhed', 'scope_required'));
    const res = await post({ appUserId: 'u', roleKey: 'tt-skabelonansvarlig' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('scope_required');
  });

  it('maps not-found and conflict from the service to 404 and 409', async () => {
    mockGrant.mockRejectedValueOnce(new NotFoundError('Brugeren findes ikke', 'user_not_found'));
    expect((await post({ appUserId: 'u', roleKey: 'tt-bruger' })).status).toBe(404);
    mockGrant.mockRejectedValueOnce(new ConflictError('Rollen er allerede tildelt', 'already_assigned'));
    expect((await post({ appUserId: 'u', roleKey: 'tt-bruger' })).status).toBe(409);
  });

  it('500 (JSON) for an unexpected error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGrant.mockRejectedValue(new Error('boom'));
    const res = await post({ appUserId: 'u', roleKey: 'tt-bruger' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});
