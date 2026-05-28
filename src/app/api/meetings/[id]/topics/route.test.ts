import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAnalyzeTopics = vi.hoisted(() => vi.fn());

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('@/lib/ai/topics', () => ({
  analyzeTopics: mockAnalyzeTopics,
}));

import { POST } from './route';
import { auth } from '@/lib/auth';
import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);

const BASE_URL = 'http://localhost/api/meetings/meet-1/topics';
const PARAMS = { params: Promise.resolve({ id: 'meet-1' }) };

const sampleTopics = [
  { topic: 'Budget 2024', followUps: ['Deadline?', 'Ansvarlig?'] },
  { topic: 'Personalemøde', followUps: ['Hvornår?'] },
];

// ─── POST /api/meetings/[id]/topics ──────────────────────────────────────────

describe('POST /api/meetings/[id]/topics', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockAnalyzeTopics.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { transcript: 'text' }), PARAMS);
    expect(res.status).toBe(401);
  });

  it('returns empty topics when transcript is missing', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);

    const res = await POST(makeJsonReq(BASE_URL, 'POST', {}), PARAMS);
    expect(res.status).toBe(200);
    expect((await res.json()).topics).toEqual([]);
    expect(mockAnalyzeTopics).not.toHaveBeenCalled();
  });

  it('returns empty topics when transcript is whitespace only', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);

    const res = await POST(makeJsonReq(BASE_URL, 'POST', { transcript: '   ' }), PARAMS);
    expect(res.status).toBe(200);
    expect((await res.json()).topics).toEqual([]);
    expect(mockAnalyzeTopics).not.toHaveBeenCalled();
  });

  it('returns analyzed topics on success', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockAnalyzeTopics.mockResolvedValueOnce(sampleTopics);

    const res = await POST(makeJsonReq(BASE_URL, 'POST', { transcript: 'Vi diskuterer budget.' }), PARAMS);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.topics).toHaveLength(2);
    expect(body.topics[0].topic).toBe('Budget 2024');
  });

  it('returns empty topics on analyzeTopics error', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockAnalyzeTopics.mockRejectedValueOnce(new Error('Mistral error'));

    const res = await POST(makeJsonReq(BASE_URL, 'POST', { transcript: 'text' }), PARAMS);
    expect(res.status).toBe(200);
    expect((await res.json()).topics).toEqual([]);
  });

  it('passes the transcript to analyzeTopics', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockAnalyzeTopics.mockResolvedValueOnce([]);

    await POST(makeJsonReq(BASE_URL, 'POST', { transcript: 'budgetmøde transskription' }), PARAMS);

    expect(mockAnalyzeTopics).toHaveBeenCalledWith('budgetmøde transskription');
  });
});
