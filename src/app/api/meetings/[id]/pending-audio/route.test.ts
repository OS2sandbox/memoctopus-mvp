import { describe, it, expect, vi, beforeEach } from 'vitest';
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

vi.mock('@/lib/pending-artifacts', () => ({
  readPendingMeta: vi.fn(),
  readPendingAudio: vi.fn(),
  deletePendingAudio: vi.fn().mockResolvedValue(undefined),
  assertMeetingOwner: vi.fn(),
}));

import { GET } from './route';
import { readPendingMeta, readPendingAudio, assertMeetingOwner } from '@/lib/pending-artifacts';

const mockReadMeta = vi.mocked(readPendingMeta);
const mockReadAudio = vi.mocked(readPendingAudio);
const mockAssertOwner = vi.mocked(assertMeetingOwner);

function makeRequest(meetingId: string): NextRequest {
  return new NextRequest(`http://localhost/api/meetings/${meetingId}/pending-audio`, { method: 'GET' });
}

function makeParams(meetingId: string) {
  return { params: Promise.resolve({ id: meetingId }) };
}

beforeEach(() => {
  mockReadMeta.mockReset();
  mockReadAudio.mockReset();
  mockAssertOwner.mockReset();
  mockAssertOwner.mockResolvedValue(true);
});

describe('GET /api/meetings/[id]/pending-audio', () => {
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

  it('carries the speaker names through a transcript-only no-recording answer', async () => {
    // Teams' transcript names every speaker even when there is no audio, and
    // those names pre-fill the participant list in Gennemgang.
    mockReadMeta.mockResolvedValue({
      mimeType: '',
      participants: ['Mette Hansen', 'Jens Poulsen'],
      durationSeconds: 540,
      hasRecording: false,
      createdAt: Date.now(),
    });
    const body = await (await GET(makeRequest('meeting-1'), makeParams('meeting-1'))).json();
    expect(body).toEqual({
      status: 'no-recording',
      participants: ['Mette Hansen', 'Jens Poulsen'],
      durationSeconds: 540,
    });
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
