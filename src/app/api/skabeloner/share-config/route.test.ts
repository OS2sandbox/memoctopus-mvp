import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));
vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));
// The access gate (requireAppAccess) resolves the live principal; a plain
// tt-bruger unless a test says otherwise.
vi.mock('@/lib/authz/principal', async () => ({
  resolvePrincipal: vi.fn(async () => (await import('@/test/helpers')).makePrincipal()),
}));
vi.mock('@/lib/audit/authz-denied', () => ({ recordAuthzDenied: vi.fn() }));

import { GET } from './route';
import { auth } from '@/lib/auth';
import { resolvePrincipal } from '@/lib/authz/principal';
import { FAKE_SESSION, makePrincipal } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);

beforeEach(() => {
  mockGetSession.mockReset().mockResolvedValue(FAKE_SESSION as never);
});

describe('GET /api/skabeloner/share-config', () => {
  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    expect((await GET()).status).toBe(401);
  });

  it('returns 403 for a disabled user', async () => {
    vi.mocked(resolvePrincipal).mockResolvedValueOnce(makePrincipal({ disabled: true, roles: [], capabilities: [] }));
    const res = await GET();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('returns the share config for a signed-in user', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('share');
  });
});
