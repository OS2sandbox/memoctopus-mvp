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

import { GET } from './route';
import { auth } from '@/lib/auth';
import { queryUserSchema } from '@/lib/db/user-schema';
import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockQueryMany = vi.mocked(queryUserSchema);

const BASE_URL = 'http://localhost/api/account/usage';

describe('GET /api/account/usage', () => {
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

  it('returns usage stats for an authenticated user', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryMany
      .mockResolvedValueOnce([{ count: '5' }] as never)
      .mockResolvedValueOnce([{ bytes: '102400', oldest: '2026-01-01T00:00:00Z' }] as never);

    const res = await GET(makeJsonReq(BASE_URL, 'GET'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      meetingCount: 5,
      audioBytes: 102400,
      oldestMeeting: '2026-01-01T00:00:00Z',
    });
  });

  it('returns zeros and null oldest when user has no data', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryMany
      .mockResolvedValueOnce([{ count: '0' }] as never)
      .mockResolvedValueOnce([{ bytes: '0', oldest: null }] as never);

    const res = await GET(makeJsonReq(BASE_URL, 'GET'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      meetingCount: 0,
      audioBytes: 0,
      oldestMeeting: null,
    });
  });

  it('handles empty query results gracefully (no rows returned)', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryMany
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never);

    const res = await GET(makeJsonReq(BASE_URL, 'GET'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      meetingCount: 0,
      audioBytes: 0,
      oldestMeeting: null,
    });
  });

  it('parses count and bytes as integers', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryMany
      .mockResolvedValueOnce([{ count: '12' }] as never)
      .mockResolvedValueOnce([{ bytes: '999999', oldest: null }] as never);

    const res = await GET(makeJsonReq(BASE_URL, 'GET'));
    const body = await res.json();
    expect(typeof body.meetingCount).toBe('number');
    expect(typeof body.audioBytes).toBe('number');
    expect(body.meetingCount).toBe(12);
    expect(body.audioBytes).toBe(999999);
  });

  it('queries with the session user id', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryMany
      .mockResolvedValueOnce([{ count: '1' }] as never)
      .mockResolvedValueOnce([{ bytes: '512', oldest: null }] as never);

    await GET(makeJsonReq(BASE_URL, 'GET'));

    for (const call of mockQueryMany.mock.calls) {
      expect(call[0]).toBe('user-123');
    }
  });

  it('fetches meeting count and audio stats in two separate queries', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryMany
      .mockResolvedValueOnce([{ count: '3' }] as never)
      .mockResolvedValueOnce([{ bytes: '256', oldest: null }] as never);

    await GET(makeJsonReq(BASE_URL, 'GET'));

    expect(mockQueryMany).toHaveBeenCalledTimes(2);
    const [, countSql] = mockQueryMany.mock.calls[0];
    const [, audioSql] = mockQueryMany.mock.calls[1];
    expect(countSql).toMatch(/COUNT\(\*\)/i);
    expect(audioSql).toMatch(/audio_files/i);
  });

  it('only counts non-deleted audio files (deleted_at IS NULL)', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryMany
      .mockResolvedValueOnce([{ count: '1' }] as never)
      .mockResolvedValueOnce([{ bytes: '0', oldest: null }] as never);

    await GET(makeJsonReq(BASE_URL, 'GET'));

    const [, audioSql] = mockQueryMany.mock.calls[1];
    expect(audioSql).toMatch(/deleted_at IS NULL/i);
  });
});
