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
  deletePendingMeta: vi.fn().mockResolvedValue(undefined),
  assertMeetingOwner: vi.fn(),
}));

import { GET } from './route';
import { readPendingMeta, deletePendingMeta, assertMeetingOwner } from '@/lib/pending-artifacts';

const mockReadMeta = vi.mocked(readPendingMeta);
const mockDeleteMeta = vi.mocked(deletePendingMeta);
const mockAssertOwner = vi.mocked(assertMeetingOwner);

function makeRequest(meetingId: string): NextRequest {
  return new NextRequest(`http://localhost/api/meetings/${meetingId}/pending-meta`, { method: 'GET' });
}

function makeParams(meetingId: string) {
  return { params: Promise.resolve({ id: meetingId }) };
}

beforeEach(() => {
  mockReadMeta.mockReset();
  mockDeleteMeta.mockReset().mockResolvedValue(undefined);
  mockAssertOwner.mockReset();
  mockAssertOwner.mockResolvedValue(true);
});

describe('GET /api/meetings/[id]/pending-meta', () => {
  it('returns 404 while the run has not finished', async () => {
    mockReadMeta.mockResolvedValue(null);
    const res = await GET(makeRequest('meeting-1'), makeParams('meeting-1'));
    expect(res.status).toBe(404);
    expect((await res.json()).status).toBe('pending');
  });

  // The names are the reason this route exists: Teams' transcript identifies every
  // speaker, and that is what pre-fills the participant list in Gennemgang.
  it('carries the speaker names and duration through', async () => {
    mockReadMeta.mockResolvedValue({
      participants: ['Mette Hansen', 'Jens Poulsen'],
      durationSeconds: 540,
      createdAt: Date.now(),
    });
    const body = await (await GET(makeRequest('meeting-1'), makeParams('meeting-1'))).json();
    expect(body).toEqual({
      status: 'no-recording',
      participants: ['Mette Hansen', 'Jens Poulsen'],
      durationSeconds: 540,
    });
  });

  it('answers no-recording even when the run produced no names', async () => {
    mockReadMeta.mockResolvedValue({ participants: [], durationSeconds: null, createdAt: Date.now() });
    const res = await GET(makeRequest('meeting-1'), makeParams('meeting-1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'no-recording',
      participants: [],
      durationSeconds: null,
    });
  });

  // Reading is not consuming: the record goes when the browser acknowledges the
  // transcript (or after the TTL). A reload between this read and the browser
  // saving the names must find them again instead of waiting on a 404.
  it('does not delete the meta record, so a second read returns the same answer', async () => {
    mockReadMeta.mockResolvedValue({ participants: ['Anna'], durationSeconds: 60, createdAt: Date.now() });
    const first = await (await GET(makeRequest('meeting-1'), makeParams('meeting-1'))).json();
    const second = await (await GET(makeRequest('meeting-1'), makeParams('meeting-1'))).json();
    expect(second).toEqual(first);
    expect(mockDeleteMeta).not.toHaveBeenCalled();
  });

  it('returns JSON 500 (not bare HTML) when assertSafeId throws on an invalid meetingId', async () => {
    // assertSafeId is called inside readPendingMeta; simulate the throw it would produce
    // for a meetingId with path-traversal characters.
    mockReadMeta.mockRejectedValue(new Error('Invalid meetingId: ../etc/passwd'));
    const res = await GET(makeRequest('../etc/passwd'), makeParams('../etc/passwd'));
    expect(res.status).toBe(500);
    expect(await res.json()).toHaveProperty('error');
  });

  it('answers 404 and reads nothing when the meeting belongs to another user', async () => {
    mockAssertOwner.mockResolvedValue(false);
    mockReadMeta.mockResolvedValue({
      participants: ['Secret'], durationSeconds: 60, createdAt: Date.now(),
    });
    const res = await GET(makeRequest('meeting-1'), makeParams('meeting-1'));
    expect(res.status).toBe(404);
    expect((await res.json()).status).toBe('pending');
    // Identical to "not finished yet", so a non-owner cannot detect that a run
    // exists.
    expect(mockReadMeta).not.toHaveBeenCalled();
  });

  it('returns 401 when there is no session', async () => {
    const { auth } = await import('@/lib/auth');
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);
    mockReadMeta.mockResolvedValue(null);
    const res = await GET(makeRequest('meeting-1'), makeParams('meeting-1'));
    expect(res.status).toBe(401);
  });
});
