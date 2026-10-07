import { describe, it, expect, vi, beforeEach } from 'vitest';

// The access gate (requireAppAccess) resolves the live principal; a plain
// tt-bruger unless a test says otherwise.
vi.mock('@/lib/authz/principal', async () => ({
  resolvePrincipal: vi.fn(async () => (await import('@/test/helpers')).makePrincipal()),
}));
vi.mock('@/lib/audit/authz-denied', () => ({ recordAuthzDenied: vi.fn() }));
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({
  auth: {
    api: {
      getSession: vi.fn().mockResolvedValue({ user: { id: 'u1' } }),
    },
  },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/audit/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit/record')>()),
  recordServerEvent: vi.fn().mockResolvedValue({ status: 'stored' }),
}));

vi.mock('@/lib/bot-pending-audio', () => ({
  readPendingMeta: vi.fn(),
  readPendingAudio: vi.fn(),
  deletePendingAudio: vi.fn().mockResolvedValue(undefined),
  assertBotMeetingOwner: vi.fn(),
}));

import { GET } from './route';
import { recordServerEvent } from '@/lib/audit/record';
import { readPendingMeta, readPendingAudio, deletePendingAudio, assertBotMeetingOwner } from '@/lib/bot-pending-audio';
import { recordAuthzDenied } from '@/lib/audit/authz-denied';

const mockReadMeta = vi.mocked(readPendingMeta);
const mockReadAudio = vi.mocked(readPendingAudio);
const mockAssertOwner = vi.mocked(assertBotMeetingOwner);
const mockRecord = vi.mocked(recordServerEvent);

function makeRequest(meetingId: string): NextRequest {
  return new NextRequest(`http://localhost/api/bot/audio/${meetingId}`, { method: 'GET' });
}

function makeParams(meetingId: string) {
  return { params: Promise.resolve({ meetingId }) };
}

beforeEach(() => {
  mockReadMeta.mockReset();
  mockReadAudio.mockReset();
  mockAssertOwner.mockReset();
  mockAssertOwner.mockResolvedValue(true);
  mockRecord.mockReset().mockResolvedValue({ status: 'stored' });
  vi.mocked(deletePendingAudio).mockClear();
});

describe('GET /api/bot/audio/[meetingId]', () => {
  it('returns 404 when meta is not yet available (pending)', async () => {
    mockReadMeta.mockResolvedValue(null);
    const res = await GET(makeRequest('meeting-1'), makeParams('meeting-1'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.status).toBe('pending');
  });

  it('returns no-recording 200 when bot finished without audio', async () => {
    mockReadMeta.mockResolvedValue({
      mimeType: '',
      participants: [],
      durationSeconds: null,
      hasRecording: false,
      createdAt: Date.now(),
    });
    const res = await GET(makeRequest('meeting-1'), makeParams('meeting-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('no-recording');
  });

  it('returns 200 with the audio buffer and headers', async () => {
    mockReadMeta.mockResolvedValue({
      mimeType: 'audio/webm',
      participants: ['Anna', 'Bo'],
      durationSeconds: 120,
      hasRecording: true,
      createdAt: Date.now(),
    });
    mockReadAudio.mockResolvedValue(Buffer.from('fake-audio'));
    const res = await GET(makeRequest('meeting-1'), makeParams('meeting-1'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('audio/webm');
    expect(res.headers.get('X-Duration')).toBe('120');
    const participants = JSON.parse(decodeURIComponent(res.headers.get('X-Participants') ?? ''));
    expect(participants).toEqual(['Anna', 'Bo']);
  });

  it('returns JSON 500 (not bare HTML) when assertSafeId throws on an invalid meetingId', async () => {
    // assertSafeId is called inside readPendingMeta; simulate the throw it would produce
    // for a meetingId with path-traversal characters.
    mockReadMeta.mockRejectedValue(new Error('Invalid meetingId: ../etc/passwd'));
    const res = await GET(makeRequest('../etc/passwd'), makeParams('../etc/passwd'));
    expect(res.status).toBe(500);
    // Must be parseable JSON — not a bare HTML page.
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('returns 404 (never the recording) when the meeting belongs to another user', async () => {
    mockAssertOwner.mockResolvedValue(false);
    mockReadMeta.mockResolvedValue({
      mimeType: 'audio/webm', participants: ['Secret'], durationSeconds: 60,
      hasRecording: true, createdAt: Date.now(),
    });
    mockReadAudio.mockResolvedValue(Buffer.from('another-users-audio'));
    const res = await GET(makeRequest('meeting-1'), makeParams('meeting-1'));
    expect(res.status).toBe(404);
    expect((await res.json()).status).toBe('pending');
    // Must never read or delete a non-owner's stash.
    expect(mockReadMeta).not.toHaveBeenCalled();
    expect(mockReadAudio).not.toHaveBeenCalled();
  });

  it('returns 401 when there is no session', async () => {
    const { auth } = await import('@/lib/auth');
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);
    mockReadMeta.mockResolvedValue(null);
    const res = await GET(makeRequest('meeting-1'), makeParams('meeting-1'));
    expect(res.status).toBe(401);
  });
});

describe('audit', () => {
  const MEETING = '11111111-1111-4111-8111-111111111111';
  const META = {
    mimeType: 'audio/webm', participants: ['Anna', 'Bo'], durationSeconds: 120,
    hasRecording: true, createdAt: Date.now(),
  };

  it('asks for the server-held copy to be deleted as a recorded handoff when the recording is handed over', async () => {
    mockReadMeta.mockResolvedValue(META);
    mockReadAudio.mockResolvedValue(Buffer.from('fake-audio'));
    const req = makeRequest(MEETING);
    expect((await GET(req, makeParams(MEETING))).status).toBe(200);
    expect(deletePendingAudio).toHaveBeenCalledTimes(1);
    expect(deletePendingAudio).toHaveBeenCalledWith(MEETING, { trigger: 'handoff', actorUserId: 'u1', req });
    // The event itself is written by deletePendingAudio (see bot-pending-audio.test.ts), not by the route.
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('records no deletion for pending and no-recording responses (nothing was held)', async () => {
    mockReadMeta.mockResolvedValueOnce(null);
    await GET(makeRequest(MEETING), makeParams(MEETING));
    mockReadMeta.mockResolvedValueOnce({ ...META, hasRecording: false });
    await GET(makeRequest(MEETING), makeParams(MEETING));
    expect(vi.mocked(deletePendingAudio).mock.calls.every((c) => c[1] === undefined)).toBe(true);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('records a non-owner as authz.denied (a probe of someone else\'s recording) and still answers like "pending"', async () => {
    vi.mocked(recordAuthzDenied).mockClear();
    mockAssertOwner.mockResolvedValueOnce(false);
    const res = await GET(makeRequest(MEETING), makeParams(MEETING));
    expect(res.status).toBe(404);
    expect(recordAuthzDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'u1',
        required: 'bot.meeting_owner',
        reason: 'not_owner',
        entityType: 'meeting',
        entityId: MEETING,
      }),
    );
    expect(deletePendingAudio).not.toHaveBeenCalled();
  });
});
