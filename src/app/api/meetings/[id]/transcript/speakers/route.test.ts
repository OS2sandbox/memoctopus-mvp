import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('@/lib/db/user-schema', () => ({
  queryUserSchemaOne: vi.fn(),
}));

import { PATCH } from './route';
import { auth } from '@/lib/auth';
import { queryUserSchemaOne } from '@/lib/db/user-schema';
import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockQueryOne = vi.mocked(queryUserSchemaOne);

const BASE_URL = 'http://localhost/api/meetings/meet-1/transcript/speakers';
const PARAMS = { params: Promise.resolve({ id: 'meet-1' }) };

const sampleSegments = [
  { speaker: 'Taler 1', start: 0, end: 5, text: 'Hej verden.' },
  { speaker: 'Taler 2', start: 6, end: 10, text: 'Hej hej.' },
  { speaker: 'Taler 1', start: 11, end: 15, text: 'Farvel.' },
];

// ─── PATCH /api/meetings/[id]/transcript/speakers ─────────────────────────────

describe('PATCH /api/meetings/[id]/transcript/speakers', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockQueryOne.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await PATCH(makeJsonReq(BASE_URL, 'PATCH', { from: 'Taler 1', to: 'Lars' }), PARAMS);
    expect(res.status).toBe(401);
  });

  it('returns 404 when transcript not found', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(null as never);

    const res = await PATCH(makeJsonReq(BASE_URL, 'PATCH', { from: 'Taler 1', to: 'Lars' }), PARAMS);
    expect(res.status).toBe(404);
  });

  it('returns 400 when "from" is missing', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);

    const res = await PATCH(makeJsonReq(BASE_URL, 'PATCH', { to: 'Lars' }), PARAMS);
    expect(res.status).toBe(400);
  });

  it('returns 400 when "to" is empty string', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);

    const res = await PATCH(makeJsonReq(BASE_URL, 'PATCH', { from: 'Taler 1', to: '' }), PARAMS);
    expect(res.status).toBe(400);
  });

  it('renames all matching speakers and returns updated segments', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'transcript-1', segments: sampleSegments } as never);
    mockQueryOne.mockResolvedValueOnce({} as never); // UPDATE transcripts

    const res = await PATCH(
      makeJsonReq(BASE_URL, 'PATCH', { from: 'Taler 1', to: 'Lars' }),
      PARAMS,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    const renamedSegments = body.segments;

    expect(renamedSegments.filter((s: { speaker: string }) => s.speaker === 'Lars')).toHaveLength(2);
    expect(renamedSegments.filter((s: { speaker: string }) => s.speaker === 'Taler 2')).toHaveLength(1);
  });

  it('does not modify segments with a different speaker', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'transcript-1', segments: sampleSegments } as never);
    mockQueryOne.mockResolvedValueOnce({} as never);

    const res = await PATCH(
      makeJsonReq(BASE_URL, 'PATCH', { from: 'Taler 1', to: 'Lars' }),
      PARAMS,
    );

    const body = await res.json();
    const unchanged = body.segments.find((s: { speaker: string }) => s.speaker === 'Taler 2');
    expect(unchanged).toBeDefined();
    expect(unchanged.text).toBe('Hej hej.');
  });

  it('handles non-existent speaker name gracefully (returns segments unchanged)', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'transcript-1', segments: sampleSegments } as never);
    mockQueryOne.mockResolvedValueOnce({} as never);

    const res = await PATCH(
      makeJsonReq(BASE_URL, 'PATCH', { from: 'Taler 99', to: 'Nobody' }),
      PARAMS,
    );

    const body = await res.json();
    expect(body.segments).toHaveLength(3);
    body.segments.forEach((s: { speaker: string }) => {
      expect(s.speaker).not.toBe('Nobody');
    });
  });

  it('handles null segments in transcript (treats as empty array)', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'transcript-1', segments: null } as never);
    mockQueryOne.mockResolvedValueOnce({} as never);

    const res = await PATCH(
      makeJsonReq(BASE_URL, 'PATCH', { from: 'Taler 1', to: 'Lars' }),
      PARAMS,
    );

    expect(res.status).toBe(200);
    expect((await res.json()).segments).toEqual([]);
  });
});
