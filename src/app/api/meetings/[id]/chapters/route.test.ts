import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGroupIntoChapters = vi.hoisted(() => vi.fn());

vi.mock('@/lib/ai/chapters', () => ({
  groupIntoChapters: mockGroupIntoChapters,
}));

import { POST } from './route';
import { makeJsonReq } from '@/test/helpers';

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
    mockGroupIntoChapters.mockRejectedValueOnce(new Error('AI error'));

    const res = await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments }));
    expect(res.status).toBe(200);
    expect((await res.json()).chapters).toEqual([]);
  });
});
