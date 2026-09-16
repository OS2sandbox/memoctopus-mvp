import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/db', () => ({ pool: {}, db: {} }));
vi.mock('@/lib/teams/graph-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/teams/graph-client')>();
  return { ...actual, hasGraphScopes: vi.fn() };
});

import { GET } from './route';
import { auth } from '@/lib/auth';
import { GraphError, hasGraphScopes } from '@/lib/teams/graph-client';
import { FAKE_SESSION } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockScopes = vi.mocked(hasGraphScopes);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue(FAKE_SESSION as never);
});

describe('GET /api/teams/status', () => {
  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    expect((await GET()).status).toBe(401);
  });

  it('reports a fully consented Microsoft user', async () => {
    mockScopes.mockResolvedValueOnce({ ok: true, missing: [] });
    expect(await (await GET()).json()).toEqual({
      microsoftLinked: true,
      scopesOk: true,
      missing: [],
    });
    expect(mockScopes).toHaveBeenCalledWith('user-123');
  });

  it('reports the missing scopes for a user who signed in before they were added', async () => {
    mockScopes.mockResolvedValueOnce({ ok: false, missing: ['Calendars.Read'] });
    expect(await (await GET()).json()).toEqual({
      microsoftLinked: true,
      scopesOk: false,
      missing: ['Calendars.Read'],
    });
  });

  it('reports no Microsoft account when the token cannot be obtained', async () => {
    mockScopes.mockRejectedValueOnce(new GraphError('reauth_required', 'Log ind igen.'));
    expect(await (await GET()).json()).toEqual({
      microsoftLinked: false,
      scopesOk: false,
      missing: [],
    });
  });

  it('never throws on an unexpected failure', async () => {
    mockScopes.mockRejectedValueOnce(new Error('boom'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).microsoftLinked).toBe(false);
    spy.mockRestore();
  });
});
