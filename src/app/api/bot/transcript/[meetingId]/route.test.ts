import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('@/lib/bot-pending-audio', () => ({
  readPendingTranscript: vi.fn(),
  deletePendingTranscript: vi.fn().mockResolvedValue(undefined),
}));

import { NextRequest } from 'next/server';
import { GET } from './route';
import { auth } from '@/lib/auth';
import { readPendingTranscript, deletePendingTranscript } from '@/lib/bot-pending-audio';
import { FAKE_SESSION } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockRead = vi.mocked(readPendingTranscript);
const mockDelete = vi.mocked(deletePendingTranscript);

const PARAMS = { params: Promise.resolve({ meetingId: 'm1' }) };
const REQ = new NextRequest('http://localhost/api/bot/transcript/m1');

const SEGMENTS = [{ speaker: 'Taler 1', start: 0, end: 3, text: 'hej' }];

beforeEach(() => {
  mockGetSession.mockReset();
  mockRead.mockReset();
  mockDelete.mockReset().mockResolvedValue(undefined);
});

describe('GET /api/bot/transcript/[meetingId]', () => {
  it('returns 401 when no session exists', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    const res = await GET(REQ, PARAMS);
    expect(res.status).toBe(401);
  });

  it("returns status 'none' when no server-side run exists", async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockRead.mockResolvedValueOnce(null);
    const res = await GET(REQ, PARAMS);
    expect((await res.json()).status).toBe('none');
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("returns status 'processing' without deleting the stash", async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockRead.mockResolvedValueOnce({ status: 'processing', createdAt: 1 });
    const res = await GET(REQ, PARAMS);
    expect((await res.json()).status).toBe('processing');
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('hands off a ready transcript and deletes the stash', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockRead.mockResolvedValueOnce({ status: 'ready', segments: SEGMENTS, diarized: true, createdAt: 1 });
    const res = await GET(REQ, PARAMS);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'ready', segments: SEGMENTS, diarized: true });
    expect(mockDelete).toHaveBeenCalledWith('m1');
  });

  it("returns status 'failed' and deletes the stash so the client falls back", async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockRead.mockResolvedValueOnce({ status: 'failed', createdAt: 1 });
    const res = await GET(REQ, PARAMS);
    expect((await res.json()).status).toBe('failed');
    expect(mockDelete).toHaveBeenCalledWith('m1');
  });
});
