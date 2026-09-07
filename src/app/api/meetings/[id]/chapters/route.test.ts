import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGroupIntoChapters = vi.hoisted(() => vi.fn());

vi.mock('@/lib/ai/chapters', () => ({
  groupIntoChapters: mockGroupIntoChapters,
}));

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

import { POST } from './route';
import { auth } from '@/lib/auth';
import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);

const BASE_URL = 'http://localhost/api/meetings/meet-1/chapters';

const sampleSegments = [
  { speaker: 'Taler 1', start: 0, end: 5, text: 'Punkt et.' },
  { speaker: 'Taler 2', start: 6, end: 10, text: 'Punkt to.' },
];

const sampleChapters = [
  { id: 'ch-0', title: 'Indledning', summary: 'S', startTime: 0, endTime: 5, segmentIndices: [0] },
  { id: 'ch-1', title: 'Diskussion', summary: 'S', startTime: 6, endTime: 10, segmentIndices: [1] },
];

// The route generates chapters via AI and returns them; it does NOT persist —
// the client stores them in IndexedDB. There is no auth or DB access.
describe('POST /api/meetings/[id]/chapters', () => {
  beforeEach(() => {
    mockGroupIntoChapters.mockReset();
    mockGetSession.mockReset();
    mockGetSession.mockResolvedValue(FAKE_SESSION as never);
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments }));
    expect(res.status).toBe(401);
    expect(mockGroupIntoChapters).not.toHaveBeenCalled();
  });

  it('returns generated chapters from groupIntoChapters', async () => {
    mockGroupIntoChapters.mockResolvedValueOnce(sampleChapters);

    const res = await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.chapters).toHaveLength(2);
    expect(body.chapters[0].title).toBe('Indledning');
    expect(mockGroupIntoChapters).toHaveBeenCalledWith(sampleSegments);
  });

  it('returns an empty chapters array when segments is empty (no AI call)', async () => {
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { segments: [] }));
    expect(res.status).toBe(200);
    expect((await res.json()).chapters).toEqual([]);
    expect(mockGroupIntoChapters).not.toHaveBeenCalled();
  });

  it('returns an empty chapters array when segments is missing', async () => {
    const res = await POST(makeJsonReq(BASE_URL, 'POST', {}));
    expect(res.status).toBe(200);
    expect((await res.json()).chapters).toEqual([]);
    expect(mockGroupIntoChapters).not.toHaveBeenCalled();
  });

  it('fails soft to an empty chapters array when groupIntoChapters throws', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const aiError = new Error('AI error');
    mockGroupIntoChapters.mockRejectedValueOnce(aiError);

    const res = await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments }));
    expect(res.status).toBe(200);
    expect((await res.json()).chapters).toEqual([]);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[chapters route] groupIntoChapters failed, returning empty fallback:',
      aiError,
    );
    consoleErrorSpy.mockRestore();
  });
});
