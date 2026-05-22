import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth', () => ({
  auth: {
    api: {
      getSession: vi.fn(),
    },
  },
}));

vi.mock('@/lib/db/user-schema', () => ({
  queryUserSchema: vi.fn(),
  queryUserSchemaOne: vi.fn(),
}));

import { GET, POST } from './route';
import { auth } from '@/lib/auth';
import { queryUserSchema, queryUserSchemaOne } from '@/lib/db/user-schema';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockQueryMany = vi.mocked(queryUserSchema);
const mockQueryOne = vi.mocked(queryUserSchemaOne);

const FAKE_SESSION = { user: { id: 'user-123', email: 'test@example.com' } };

function makeReq(method: string, body?: unknown): NextRequest {
  return new NextRequest('http://localhost/api/meetings', {
    method,
    ...(body !== undefined
      ? {
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json' },
        }
      : {}),
  });
}

// ─── GET /api/meetings ────────────────────────────────────────────────────────

describe('GET /api/meetings', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockQueryMany.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await GET();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Unauthorized');
  });

  it('returns the list of meetings for an authenticated user', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    const meetings = [
      { id: 'meet-1', title: 'Møde 1', participants: [], status: 'done', created_at: '2026-01-01T00:00:00Z' },
    ];
    mockQueryMany.mockResolvedValueOnce(meetings as never);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(meetings);
  });

  it('queries with the authenticated user id', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryMany.mockResolvedValueOnce([]);

    await GET();

    expect(mockQueryMany).toHaveBeenCalledWith('user-123', expect.any(String));
  });

  it('returns an empty array when user has no meetings', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryMany.mockResolvedValueOnce([]);

    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
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
    const res = await POST(makeReq('POST', { title: 'Test' }));
    expect(res.status).toBe(401);
  });

  it('creates a meeting and returns 201 with the id', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'new-meeting-id' } as never);

    const res = await POST(makeReq('POST', { title: 'Projektmøde', participants: ['Alice', 'Bob'] }));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe('new-meeting-id');
  });

  it('passes title and participants to the DB insert', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'x' } as never);

    await POST(makeReq('POST', { title: 'Ugentligt møde', participants: ['Hans', 'Grethe'] }));

    const [userId, , params] = mockQueryOne.mock.calls[0];
    expect(userId).toBe('user-123');
    expect(params[0]).toBe('Ugentligt møde');
    expect(params[1]).toEqual(expect.arrayContaining(['Hans', 'Grethe']));
  });

  it('defaults participants to empty array when omitted', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'x' } as never);

    await POST(makeReq('POST', { title: 'Ingen deltagere' }));

    const [, , params] = mockQueryOne.mock.calls[0];
    expect(params[1]).toEqual([]);
  });

  it('returns 400 when title is missing', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);

    const res = await POST(makeReq('POST', { participants: [] }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it('returns 400 when title is empty string', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);

    const res = await POST(makeReq('POST', { title: '' }));

    expect(res.status).toBe(400);
  });

  it('returns 400 when title exceeds 200 characters', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);

    const res = await POST(makeReq('POST', { title: 'A'.repeat(201) }));

    expect(res.status).toBe(400);
  });

  it('accepts title at exactly 200 characters', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'x' } as never);

    const res = await POST(makeReq('POST', { title: 'A'.repeat(200) }));

    expect(res.status).toBe(201);
  });
});
