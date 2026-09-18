import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/db', () => ({ pool: {}, db: {} }));
vi.mock('@/lib/db/user-schema', () => ({
  queryUserSchema: vi.fn(),
  queryUserSchemaOne: vi.fn(),
  ensureUserSchema: vi.fn(),
}));
vi.mock('@/lib/teams/store', () => ({
  getTeamsMeeting: vi.fn(),
  deleteTeamsMeeting: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/teams/poller', () => ({ pollMeeting: vi.fn() }));
vi.mock('@/lib/teams/meeting-arm', () => ({ disarmMeeting: vi.fn() }));

import { GET, DELETE } from './route';
import { auth } from '@/lib/auth';
import { GraphError } from '@/lib/teams/graph-client';
import { disarmMeeting } from '@/lib/teams/meeting-arm';
import { pollMeeting } from '@/lib/teams/poller';
import { deleteTeamsMeeting, getTeamsMeeting, type TeamsMeetingRow } from '@/lib/teams/store';
import { FAKE_SESSION } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockGet = vi.mocked(getTeamsMeeting);
const mockPoll = vi.mocked(pollMeeting);
const mockDisarm = vi.mocked(disarmMeeting);
const mockDelete = vi.mocked(deleteTeamsMeeting);

function row(over: Partial<TeamsMeetingRow> = {}): TeamsMeetingRow {
  return {
    id: 'm1',
    graphMeetingId: 'graph-1',
    joinUrl: 'https://teams.microsoft.com/l/meetup-join/x',
    subject: 'Ugentligt møde',
    organizerId: 'org-1',
    isOrganizer: true,
    armed: true,
    scheduledStart: new Date('2026-09-08T10:00:00Z'),
    scheduledEnd: new Date('2026-09-08T11:00:00Z'),
    state: 'awaiting_teams',
    lastPolledAt: null,
    attempts: 0,
    failureReason: null,
    transcriptId: null,
    recordingId: null,
    eventId: null,
    armResult: 'armed',
    createdAt: new Date('2026-09-08T09:00:00Z'),
    ...over,
  };
}

const params = Promise.resolve({ id: 'm1' });
const req = (qs = '') => new NextRequest(`http://localhost/api/teams/meetings/m1${qs}`);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue(FAKE_SESSION as never);
  mockDelete.mockResolvedValue(undefined);
  mockDisarm.mockResolvedValue(undefined);
});

describe('GET /api/teams/meetings/[id]', () => {
  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    expect((await GET(req(), { params })).status).toBe(401);
  });

  it('returns 404 when the meeting is not the caller’s', async () => {
    mockGet.mockResolvedValueOnce(null);
    const res = await GET(req(), { params });
    expect(res.status).toBe(404);
    expect(mockGet).toHaveBeenCalledWith('user-123', 'm1');
  });

  it('serializes the row without polling by default', async () => {
    mockGet.mockResolvedValueOnce(row({ lastPolledAt: new Date('2026-09-08T11:05:00Z') }));

    const res = await GET(req(), { params });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: 'm1',
      state: 'awaiting_teams',
      armed: true,
      isOrganizer: true,
      subject: 'Ugentligt møde',
      scheduledStart: '2026-09-08T10:00:00.000Z',
      scheduledEnd: '2026-09-08T11:00:00.000Z',
      failureReason: null,
      lastPolledAt: '2026-09-08T11:05:00.000Z',
      armResult: 'armed',
    });
    expect(mockPoll).not.toHaveBeenCalled();
  });

  it('polls first and answers with the resulting state when poll=1', async () => {
    mockGet.mockResolvedValueOnce(row());
    mockPoll.mockResolvedValueOnce(row({ state: 'ready' }));

    const body = await (await GET(req('?poll=1'), { params })).json();

    // force: this endpoint is also the "Prøv igen" button, which must be able to
    // revive a row the poller has already written off as failed.
    expect(mockPoll).toHaveBeenCalledWith('user-123', 'm1', expect.any(Date), { force: true });
    expect(body.state).toBe('ready');
  });

  it('serializes the arm outcome so the screen can explain a blocked policy', async () => {
    mockGet.mockResolvedValueOnce(row({ armed: false, armResult: 'policy_blocked' }));

    const body = await (await GET(req(), { params })).json();

    expect(body.armResult).toBe('policy_blocked');
    expect(body.armed).toBe(false);
  });

  it('maps a Graph failure during poll=1 to its documented status', async () => {
    mockGet.mockResolvedValueOnce(row());
    mockPoll.mockRejectedValueOnce(new GraphError('reauth_required', 'Log ind igen.'));

    const res = await GET(req('?poll=1'), { params });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('reauth_required');
  });
});

describe('DELETE /api/teams/meetings/[id]', () => {
  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    expect((await DELETE(req(), { params })).status).toBe(401);
  });

  it('returns 404 for a meeting the caller does not own', async () => {
    mockGet.mockResolvedValueOnce(null);
    expect((await DELETE(req(), { params })).status).toBe(404);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('disarms an armed meeting and deletes the row', async () => {
    mockGet.mockResolvedValueOnce(row({ armed: true }));

    const res = await DELETE(req(), { params });

    expect(await res.json()).toEqual({ ok: true });
    expect(mockDisarm).toHaveBeenCalledWith('user-123', 'graph-1');
    expect(mockDelete).toHaveBeenCalledWith('user-123', 'm1');
  });

  it('does not disarm a meeting we never armed', async () => {
    mockGet.mockResolvedValueOnce(row({ armed: false }));
    await DELETE(req(), { params });
    expect(mockDisarm).not.toHaveBeenCalled();
    expect(mockDelete).toHaveBeenCalled();
  });

  it('still deletes when disarming fails', async () => {
    mockGet.mockResolvedValueOnce(row({ armed: true }));
    mockDisarm.mockRejectedValueOnce(new GraphError('http', 'Graph-fejl.'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await DELETE(req(), { params });

    expect(await res.json()).toEqual({ ok: true });
    expect(mockDelete).toHaveBeenCalled();
    spy.mockRestore();
  });
});
