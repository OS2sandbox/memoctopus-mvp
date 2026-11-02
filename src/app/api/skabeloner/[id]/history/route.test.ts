import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/authz/principal', async () => ({
  resolvePrincipal: vi.fn(async () => (await import('@/test/helpers')).makePrincipal()),
}));
vi.mock('@/lib/audit/authz-denied', () => ({ recordAuthzDenied: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/db', () => ({ db: {}, pool: {} }));
vi.mock('@/lib/skabeloner/server', () => ({ listSkabelonVersions: vi.fn() }));

import { GET } from './route';
import { auth } from '@/lib/auth';
import { listSkabelonVersions } from '@/lib/skabeloner/server';
import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';

const mockSession = vi.mocked(auth.api.getSession);
const mockList = vi.mocked(listSkabelonVersions);
const ID = '11111111-2222-4333-8444-555555555555';
const CTX = { params: Promise.resolve({ id: ID }) };
const url = `http://localhost/api/skabeloner/${ID}/history`;

describe('GET /api/skabeloner/[id]/history', () => {
  beforeEach(() => {
    mockSession.mockReset().mockResolvedValue(FAKE_SESSION as never);
    mockList.mockReset();
  });

  it('401 without a session, and nothing is read', async () => {
    mockSession.mockResolvedValueOnce(null as never);
    expect((await GET(makeJsonReq(url, 'GET'), CTX)).status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("returns the caller's OWN history, uncached", async () => {
    mockList.mockResolvedValueOnce([
      { version: 2, changeNote: 'Strammet op', changedFields: ['prompt'], createdAt: '2026-06-02T08:00:00.000Z' },
      { version: 1, changeNote: null, changedFields: [], createdAt: '2026-06-01T08:00:00.000Z' },
    ]);
    const res = await GET(makeJsonReq(url, 'GET'), CTX);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect((await res.json()).versions).toHaveLength(2);
    expect(mockList).toHaveBeenCalledWith(FAKE_SESSION.user.id, ID);
  });

  it('404 when the template is not in the caller schema', async () => {
    mockList.mockResolvedValueOnce(null);
    expect((await GET(makeJsonReq(url, 'GET'), CTX)).status).toBe(404);
  });
});
