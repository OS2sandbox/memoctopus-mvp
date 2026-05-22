import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('@/lib/db/user-schema', () => ({
  queryUserSchema: vi.fn(),
  queryUserSchemaOne: vi.fn(),
}));

import { GET, POST } from './route';
import { auth } from '@/lib/auth';
import { queryUserSchema, queryUserSchemaOne } from '@/lib/db/user-schema';
import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockQueryMany = vi.mocked(queryUserSchema);
const mockQueryOne = vi.mocked(queryUserSchemaOne);

const BASE_URL = 'http://localhost/api/meetings';

// ─── GET /api/meetings ────────────────────────────────────────────────────────

describe('GET /api/meetings', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockQueryMany.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await GET(makeJsonReq(BASE_URL, 'GET'));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Unauthorized');
  });

  it('returns the list of meetings and uses the session user id', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    const meetings = [
      { id: 'meet-1', title: 'Møde 1', participants: [], status: 'done', created_at: '2026-01-01T00:00:00Z' },
    ];
    mockQueryMany.mockResolvedValueOnce(meetings as never);

    const res = await GET(makeJsonReq(BASE_URL, 'GET'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(meetings);
    expect(mockQueryMany).toHaveBeenCalledWith('user-123', expect.any(String));
  });

  it('returns an empty array when user has no meetings', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryMany.mockResolvedValueOnce([]);

    const res = await GET(makeJsonReq(BASE_URL, 'GET'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('returns { count } when ?count=1 is passed', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryMany.mockResolvedValueOnce([{ count: '42' }] as never);

    const res = await GET(makeJsonReq(`${BASE_URL}?count=1`, 'GET'));
    expect(res.status).toBe(200);
    expect((await res.json()).count).toBe(42);
  });
});

// ─── POST /api/meetings ───────────────────────────────────────────────────────

describe('POST /api/meetings', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockQueryOne.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { title: 'Test' }));
    expect(res.status).toBe(401);
  });

  it('creates a meeting and returns 201 with the id', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'new-meeting-id' } as never);

    const res = await POST(makeJsonReq(BASE_URL, 'POST', { title: 'Projektmøde', participants: ['Alice', 'Bob'] }));

    expect(res.status).toBe(201);
    expect((await res.json()).id).toBe('new-meeting-id');
  });

  it('passes title and participants to the DB insert', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'x' } as never);

    await POST(makeJsonReq(BASE_URL, 'POST', { title: 'Ugentligt møde', participants: ['Hans', 'Grethe'] }));

    const [userId, , params] = mockQueryOne.mock.calls[0];
    expect(userId).toBe('user-123');
    expect(params[0]).toBe('Ugentligt møde');
    expect(params[1]).toEqual(expect.arrayContaining(['Hans', 'Grethe']));
  });

  it('defaults participants to empty array when omitted', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'x' } as never);

    await POST(makeJsonReq(BASE_URL, 'POST', { title: 'Ingen deltagere' }));

    const [, , params] = mockQueryOne.mock.calls[0];
    expect(params[1]).toEqual([]);
  });

  it('returns 400 when title is missing', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);

    const res = await POST(makeJsonReq(BASE_URL, 'POST', { participants: [] }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeDefined();
  });

  it('returns 400 when title is empty string', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { title: '' }));
    expect(res.status).toBe(400);
  });

  it.each([
    ['too long', 'A'.repeat(201), 400],
    ['at max length', 'A'.repeat(200), 201],
  ])('returns %s status for title of length %i', async (_label, title, status) => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    if (status === 201) mockQueryOne.mockResolvedValueOnce({ id: 'x' } as never);

    const res = await POST(makeJsonReq(BASE_URL, 'POST', { title }));
    expect(res.status).toBe(status);
  });
});
