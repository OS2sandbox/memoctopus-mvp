import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('@/lib/pending-artifacts', () => ({
  readPendingTranscript: vi.fn(),
  deletePendingTranscript: vi.fn().mockResolvedValue(undefined),
  assertMeetingOwner: vi.fn(),
}));

import { NextRequest } from 'next/server';
import { GET } from './route';
import { auth } from '@/lib/auth';
import { readPendingTranscript, deletePendingTranscript, assertMeetingOwner } from '@/lib/pending-artifacts';
import { FAKE_SESSION } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockRead = vi.mocked(readPendingTranscript);
const mockDelete = vi.mocked(deletePendingTranscript);
const mockAssertOwner = vi.mocked(assertMeetingOwner);

const PARAMS = { params: Promise.resolve({ id: 'm1' }) };
const REQ = new NextRequest('http://localhost/api/meetings/m1/pending-transcript');

const SEGMENTS = [{ speaker: 'Taler 1', start: 0, end: 3, text: 'hej' }];

beforeEach(() => {
  mockGetSession.mockReset();
  mockRead.mockReset();
  mockDelete.mockReset().mockResolvedValue(undefined);
  mockAssertOwner.mockReset();
  mockAssertOwner.mockResolvedValue(true);
});

describe('GET /api/meetings/[id]/pending-transcript', () => {
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

  it("returns 'none' (never the transcript) when the meeting belongs to another user", async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockAssertOwner.mockResolvedValueOnce(false);
    mockRead.mockResolvedValueOnce({ status: 'ready', segments: SEGMENTS, diarized: true, createdAt: 1 });
    const res = await GET(REQ, PARAMS);
    expect((await res.json()).status).toBe('none');
    // Must never read or delete a non-owner's transcript stash.
    expect(mockRead).not.toHaveBeenCalled();
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
