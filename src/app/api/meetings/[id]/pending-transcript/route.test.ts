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
  acknowledgePendingTranscript: vi.fn().mockResolvedValue(undefined),
  assertMeetingOwner: vi.fn(),
}));

import { NextRequest } from 'next/server';
import { GET, DELETE } from './route';
import { auth } from '@/lib/auth';
import {
  readPendingTranscript,
  deletePendingTranscript,
  acknowledgePendingTranscript,
  assertMeetingOwner,
} from '@/lib/pending-artifacts';
import { FAKE_SESSION } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockRead = vi.mocked(readPendingTranscript);
const mockDelete = vi.mocked(deletePendingTranscript);
const mockAck = vi.mocked(acknowledgePendingTranscript);
const mockAssertOwner = vi.mocked(assertMeetingOwner);

const PARAMS = { params: Promise.resolve({ id: 'm1' }) };
const REQ = new NextRequest('http://localhost/api/meetings/m1/pending-transcript');

const SEGMENTS = [{ speaker: 'Taler 1', start: 0, end: 3, text: 'hej' }];

beforeEach(() => {
  mockGetSession.mockReset();
  mockRead.mockReset();
  mockDelete.mockReset().mockResolvedValue(undefined);
  mockAck.mockReset().mockResolvedValue(undefined);
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

  // Reading must not consume the transcript: the browser copy in IndexedDB is the
  // only durable one, and a reload or a lost response between this read and the
  // save would otherwise lose the transcript for good.
  it('hands off a ready transcript WITHOUT deleting it, so it can be fetched again', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION as never);
    mockRead.mockResolvedValue({ status: 'ready', segments: SEGMENTS, diarized: true, createdAt: 1 });

    const first = await (await GET(REQ, PARAMS)).json();
    const second = await (await GET(REQ, PARAMS)).json();

    expect(first).toMatchObject({ status: 'ready', segments: SEGMENTS, diarized: true });
    expect(second).toEqual(first);
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockAck).not.toHaveBeenCalled();
  });

  it("returns status 'failed' and deletes the stash so the client falls back", async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockRead.mockResolvedValueOnce({ status: 'failed', createdAt: 1 });
    const res = await GET(REQ, PARAMS);
    expect((await res.json()).status).toBe('failed');
    expect(mockDelete).toHaveBeenCalledWith('m1');
  });
});

describe('DELETE /api/meetings/[id]/pending-transcript (acknowledge)', () => {
  const DEL = new NextRequest('http://localhost/api/meetings/m1/pending-transcript', { method: 'DELETE' });

  it('returns 401 when no session exists', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    const res = await DELETE(DEL, PARAMS);
    expect(res.status).toBe(401);
    expect(mockAck).not.toHaveBeenCalled();
  });

  it('deletes the stash once the browser has saved the transcript', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    const res = await DELETE(DEL, PARAMS);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockAck).toHaveBeenCalledWith('m1');
  });

  it('is idempotent: acknowledging again is still ok', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION as never);
    expect((await DELETE(DEL, PARAMS)).status).toBe(200);
    expect((await DELETE(DEL, PARAMS)).status).toBe(200);
  });

  it('does nothing, and says nothing, for a meeting that belongs to another user', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockAssertOwner.mockResolvedValueOnce(false);
    const res = await DELETE(DEL, PARAMS);
    expect(res.status).toBe(200);
    expect(mockAck).not.toHaveBeenCalled();
  });

  it('after the acknowledgement a missing stash still reads as "none"', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION as never);
    await DELETE(DEL, PARAMS);
    mockRead.mockResolvedValueOnce(null);
    expect((await (await GET(REQ, PARAMS)).json()).status).toBe('none');
  });
});
