import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/audit/authz-denied', () => ({ recordAuthzDenied: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/authz/principal', () => ({ resolvePrincipal: vi.fn() }));

import { GET } from './route';
import { auth } from '@/lib/auth';
import { resolvePrincipal } from '@/lib/authz/principal';
import { FAKE_PRINCIPAL_ADMIN, makeJsonReq, NO_PARAMS, makePrincipal } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockResolve = vi.mocked(resolvePrincipal);
const req = () => makeJsonReq('http://localhost/api/me', 'GET');

const SESSION = {
  user: { id: 'user-123', name: 'Anna', email: 'anna@example.dk', image: null, emailVerified: true },
  session: { id: 's1', token: 'secret-session-token', ipAddress: '1.2.3.4' },
};

beforeEach(() => {
  vi.stubEnv('ACCESS_SOURCE', 'local');
  mockGetSession.mockReset().mockResolvedValue(SESSION as never);
  mockResolve.mockReset().mockResolvedValue(makePrincipal());
});
afterEach(() => vi.unstubAllEnvs());

describe('GET /api/me', () => {
  it('401 without a session', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    const res = await GET(req(), NO_PARAMS);
    expect(res.status).toBe(401);
  });

  it('403 for a disabled user', async () => {
    mockResolve.mockResolvedValue(makePrincipal({ disabled: true, capabilities: [], roles: [] }));
    expect((await GET(req(), NO_PARAMS)).status).toBe(403);
  });

  it('returns the baseline user with empty scopes', async () => {
    const res = await GET(req(), NO_PARAMS);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: { id: 'user-123', name: 'Anna', email: 'anna@example.dk' },
      roles: ['tt-bruger'],
      capabilities: ['template.use'],
      scopes: {},
      source: 'local',
      readOnly: false,
    });
  });

  it('reports scopes as ids only', async () => {
    const unit = '11111111-1111-4111-8111-111111111111';
    mockResolve.mockResolvedValue(
      makePrincipal({
        roles: ['tt-bruger', 'tt-skabelonansvarlig'],
        capabilities: ['template.use', 'template.manage', 'directory.read'],
        scopes: { 'template.manage': { global: false, roots: [{ orgUnitUuid: unit, includeDescendants: true }] } },
        source: 'local',
      }),
    );
    const json = await (await GET(req(), NO_PARAMS)).json();
    expect(json.scopes).toEqual({ 'template.manage': { global: false, roots: [{ orgUnitUuid: unit, includeDescendants: true }] } });
    expect(json.roles).toContain('tt-skabelonansvarlig');
  });

  it('marks the response read-only outside local mode', async () => {
    vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
    mockResolve.mockResolvedValue(FAKE_PRINCIPAL_ADMIN);
    const json = await (await GET(req(), NO_PARAMS)).json();
    expect(json.source).toBe('rollekatalog');
    expect(json.readOnly).toBe(true);
  });

  it('never leaks session internals, tokens or extra user fields', async () => {
    const text = JSON.stringify(await (await GET(req(), NO_PARAMS)).json());
    expect(text).not.toContain('secret-session-token');
    expect(text).not.toContain('1.2.3.4');
    expect(Object.keys(JSON.parse(text).user).sort()).toEqual(['email', 'id', 'name']);
  });

  it('returns a JSON 500 when the principal cannot be resolved', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockResolve.mockRejectedValue(new Error('db down'));
    const res = await GET(req(), NO_PARAMS);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});
