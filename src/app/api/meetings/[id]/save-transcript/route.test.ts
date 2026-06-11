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

import { POST } from './route';
import { auth } from '@/lib/auth';
import { queryUserSchemaOne } from '@/lib/db/user-schema';
import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockQueryOne = vi.mocked(queryUserSchemaOne);

const BASE_URL = 'http://localhost/api/meetings/meet-1/save-transcript';
const PARAMS = { params: Promise.resolve({ id: 'meet-1' }) };

const sampleSegments = [
  { speaker: 'Taler 1', start: 0, end: 5, text: 'Hej verden.' },
  { speaker: 'Taler 2', start: 6, end: 10, text: 'Goddag.' },
];

// ─── POST /api/meetings/[id]/save-transcript ──────────────────────────────────

describe('POST /api/meetings/[id]/save-transcript', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockQueryOne.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments }), PARAMS);
    expect(res.status).toBe(401);
  });

  it('returns 404 when meeting not found', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(null as never);

    const res = await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments }), PARAMS);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Meeting not found');
  });

  it('returns 200 with transcriptId on success', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'meet-1' } as never); // meeting lookup
    mockQueryOne.mockResolvedValueOnce({ id: 'transcript-abc' } as never); // INSERT transcript
    mockQueryOne.mockResolvedValueOnce({} as never); // UPDATE meetings status

    const res = await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments }), PARAMS);

    expect(res.status).toBe(200);
    expect((await res.json()).transcriptId).toBe('transcript-abc');
  });

  it('stores joined segment text as raw_text', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'meet-1' } as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'tid' } as never);
    mockQueryOne.mockResolvedValueOnce({} as never);

    await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments }), PARAMS);

    const insertCall = mockQueryOne.mock.calls.find(
      ([, sql]) => typeof sql === 'string' && sql.includes('INSERT INTO transcripts'),
    );
    expect(insertCall).toBeDefined();
    const params = insertCall![2] as unknown[];
    expect(params[1]).toBe('Hej verden. Goddag.'); // raw_text is text joined with space
  });

  it('sets meeting status to review after saving transcript', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'meet-1' } as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'tid' } as never);
    mockQueryOne.mockResolvedValueOnce({} as never);

    await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments }), PARAMS);

    const updateCall = mockQueryOne.mock.calls.find(
      ([, sql]) => typeof sql === 'string' && sql.includes("'review'"),
    );
    expect(updateCall).toBeDefined();
  });

  it('handles empty segments array', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'meet-1' } as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'tid' } as never);
    mockQueryOne.mockResolvedValueOnce({} as never);

    const res = await POST(makeJsonReq(BASE_URL, 'POST', { segments: [] }), PARAMS);
    expect(res.status).toBe(200);
  });

  it('handles missing segments (defaults to empty)', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'meet-1' } as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'tid' } as never);
    mockQueryOne.mockResolvedValueOnce({} as never);

    const res = await POST(makeJsonReq(BASE_URL, 'POST', {}), PARAMS);
    expect(res.status).toBe(200);
  });
});
