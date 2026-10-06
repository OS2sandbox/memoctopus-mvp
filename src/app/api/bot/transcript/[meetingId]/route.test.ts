import { describe, it, expect, vi, beforeEach } from 'vitest';

// The access gate (requireAppAccess) resolves the live principal; a plain
// tt-bruger unless a test says otherwise.
vi.mock('@/lib/authz/principal', async () => ({
  resolvePrincipal: vi.fn(async () => (await import('@/test/helpers')).makePrincipal()),
}));
vi.mock('@/lib/audit/authz-denied', () => ({ recordAuthzDenied: vi.fn() }));

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('@/lib/audit/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit/record')>()),
  recordServerEvent: vi.fn().mockResolvedValue({ status: 'stored' }),
}));

vi.mock('@/lib/bot-pending-audio', () => ({
  readPendingTranscript: vi.fn(),
  deletePendingTranscript: vi.fn().mockResolvedValue(undefined),
  assertBotMeetingOwner: vi.fn(),
}));

import { NextRequest } from 'next/server';
import { GET } from './route';
import { auth } from '@/lib/auth';
import { readPendingTranscript, deletePendingTranscript, assertBotMeetingOwner } from '@/lib/bot-pending-audio';
import { recordServerEvent } from '@/lib/audit/record';
import { FAKE_SESSION } from '@/test/helpers';

const mockRecord = vi.mocked(recordServerEvent);

const mockGetSession = vi.mocked(auth.api.getSession);
const mockRead = vi.mocked(readPendingTranscript);
const mockDelete = vi.mocked(deletePendingTranscript);
const mockAssertOwner = vi.mocked(assertBotMeetingOwner);

const PARAMS = { params: Promise.resolve({ meetingId: 'm1' }) };
const REQ = new NextRequest('http://localhost/api/bot/transcript/m1');

const SEGMENTS = [{ speaker: 'Taler 1', start: 0, end: 3, text: 'hej' }];

beforeEach(() => {
  mockGetSession.mockReset();
  mockRead.mockReset();
  mockDelete.mockReset().mockResolvedValue(undefined);
  mockAssertOwner.mockReset();
  mockAssertOwner.mockResolvedValue(true);
  mockRecord.mockReset().mockResolvedValue({ status: 'stored' });
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

describe('audit', () => {
  const MEETING = '11111111-1111-4111-8111-111111111111';
  const params = { params: Promise.resolve({ meetingId: MEETING }) };

  it('writes no audit event for a hand-over, a failed run, none, processing or a non-owner', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION as never);
    mockRead.mockResolvedValueOnce({ status: 'ready', segments: SEGMENTS, diarized: true, createdAt: 1 });
    await GET(REQ, params);
    mockRead.mockResolvedValueOnce({ status: 'failed', createdAt: 1 });
    await GET(REQ, params);
    mockRead.mockResolvedValueOnce(null);
    await GET(REQ, params);
    mockRead.mockResolvedValueOnce({ status: 'processing', createdAt: 1 });
    await GET(REQ, params);
    mockAssertOwner.mockResolvedValueOnce(false);
    await GET(REQ, params);
    expect(mockRecord).not.toHaveBeenCalled();
  });
});
