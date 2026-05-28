import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGroupIntoChapters = vi.hoisted(() => vi.fn());

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('@/lib/db/user-schema', () => ({
  queryUserSchemaOne: vi.fn(),
}));

vi.mock('@/lib/ai/chapters', () => ({
  groupIntoChapters: mockGroupIntoChapters,
}));

import { POST, PATCH } from './route';
import { auth } from '@/lib/auth';
import { queryUserSchemaOne } from '@/lib/db/user-schema';
import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockQueryOne = vi.mocked(queryUserSchemaOne);

const BASE_URL = 'http://localhost/api/meetings/meet-1/chapters';
const PARAMS = { params: Promise.resolve({ id: 'meet-1' }) };

const sampleSegments = [
  { speaker: 'Taler 1', start: 0, end: 5, text: 'Punkt et.' },
  { speaker: 'Taler 2', start: 6, end: 10, text: 'Punkt to.' },
];

const sampleChapters = [
  { id: 'ch-0', title: 'Indledning', summary: 'S', startTime: 0, endTime: 5, segmentIndices: [0] },
  { id: 'ch-1', title: 'Diskussion', summary: 'S', startTime: 6, endTime: 10, segmentIndices: [1] },
];

// ─── POST /api/meetings/[id]/chapters ─────────────────────────────────────────

describe('POST /api/meetings/[id]/chapters', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockQueryOne.mockReset();
    mockGroupIntoChapters.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments }), PARAMS);
    expect(res.status).toBe(401);
  });

  it('returns empty chapters array when segments is empty', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);

    const res = await POST(makeJsonReq(BASE_URL, 'POST', { segments: [] }), PARAMS);
    expect(res.status).toBe(200);
    expect((await res.json()).chapters).toEqual([]);
    expect(mockGroupIntoChapters).not.toHaveBeenCalled();
  });

  it('returns empty chapters array when segments is missing', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);

    const res = await POST(makeJsonReq(BASE_URL, 'POST', {}), PARAMS);
    expect(res.status).toBe(200);
    expect((await res.json()).chapters).toEqual([]);
  });

  it('returns generated chapters from groupIntoChapters', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockGroupIntoChapters.mockResolvedValueOnce(sampleChapters);
    mockQueryOne.mockResolvedValueOnce({ id: 'transcript-1' } as never); // transcript lookup
    mockQueryOne.mockResolvedValueOnce({} as never); // UPDATE chapters

    const res = await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments }), PARAMS);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.chapters).toHaveLength(2);
    expect(body.chapters[0].title).toBe('Indledning');
  });

  it('saves chapters to transcript when transcript is found', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockGroupIntoChapters.mockResolvedValueOnce(sampleChapters);
    mockQueryOne.mockResolvedValueOnce({ id: 'transcript-1' } as never);
    mockQueryOne.mockResolvedValueOnce({} as never);

    await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments }), PARAMS);

    const updateCall = mockQueryOne.mock.calls.find(
      ([, sql]) => typeof sql === 'string' && sql.includes('UPDATE transcripts'),
    );
    expect(updateCall).toBeDefined();
  });

  it('returns empty chapters array on groupIntoChapters error', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockGroupIntoChapters.mockRejectedValueOnce(new Error('AI error'));

    const res = await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments }), PARAMS);
    expect(res.status).toBe(200);
    expect((await res.json()).chapters).toEqual([]);
  });
});

// ─── PATCH /api/meetings/[id]/chapters ────────────────────────────────────────

describe('PATCH /api/meetings/[id]/chapters', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockQueryOne.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await PATCH(makeJsonReq(BASE_URL, 'PATCH', { chapters: sampleChapters }), PARAMS);
    expect(res.status).toBe(401);
  });

  it('returns 400 when chapters is not an array', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);

    const res = await PATCH(makeJsonReq(BASE_URL, 'PATCH', { chapters: 'not-an-array' }), PARAMS);
    expect(res.status).toBe(400);
  });

  it('returns 200 ok when chapters are saved', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({} as never);

    const res = await PATCH(makeJsonReq(BASE_URL, 'PATCH', { chapters: sampleChapters }), PARAMS);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('saves chapters JSON to transcript by meeting_id', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({} as never);

    await PATCH(makeJsonReq(BASE_URL, 'PATCH', { chapters: sampleChapters }), PARAMS);

    const [, sql, params] = mockQueryOne.mock.calls[0];
    expect(sql).toMatch(/UPDATE transcripts SET chapters/i);
    expect(params[0]).toBe(JSON.stringify(sampleChapters));
  });

  it('accepts an empty chapters array', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({} as never);

    const res = await PATCH(makeJsonReq(BASE_URL, 'PATCH', { chapters: [] }), PARAMS);
    expect(res.status).toBe(200);
  });
});
