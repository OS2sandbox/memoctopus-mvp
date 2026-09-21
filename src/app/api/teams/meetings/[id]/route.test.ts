import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/db', () => ({ pool: {}, db: {} }));
vi.mock('@/lib/db/user-schema', () => ({
  queryUserSchema: vi.fn(),
  queryUserSchemaOne: vi.fn(),
  ensureUserSchema: vi.fn(),
}));
vi.mock('@/lib/teams/store', async (importOriginal) => ({
  // The real POLL_GIVE_UP_MS / giveUpAnchor, so the re-collect window is the poller's.
  ...(await importOriginal<typeof import('@/lib/teams/store')>()),
  getTeamsMeeting: vi.fn(),
  deleteTeamsMeeting: vi.fn().mockResolvedValue(undefined),
  setTeamsMeetingState: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/pending-artifacts', () => ({ readPendingTranscript: vi.fn() }));
vi.mock('@/lib/teams/poller', () => ({ pollMeeting: vi.fn() }));
vi.mock('@/lib/teams/meeting-arm', () => ({ disarmMeeting: vi.fn() }));

import { GET, DELETE, POST } from './route';
import { auth } from '@/lib/auth';
import { GraphError } from '@/lib/teams/graph-client';
import { disarmMeeting } from '@/lib/teams/meeting-arm';
import { pollMeeting } from '@/lib/teams/poller';
import {
  POLL_GIVE_UP_MS,
  deleteTeamsMeeting,
  getTeamsMeeting,
  setTeamsMeetingState,
  type TeamsMeetingRow,
} from '@/lib/teams/store';
import { readPendingTranscript } from '@/lib/pending-artifacts';
import { FAKE_SESSION } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockGet = vi.mocked(getTeamsMeeting);
const mockPoll = vi.mocked(pollMeeting);
const mockDisarm = vi.mocked(disarmMeeting);
const mockDelete = vi.mocked(deleteTeamsMeeting);
const mockSetState = vi.mocked(setTeamsMeetingState);
const mockReadStash = vi.mocked(readPendingTranscript);

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
  process.env.TEAMS_GRAPH_ENABLED = 'true';
  mockGetSession.mockResolvedValue(FAKE_SESSION as never);
  mockDelete.mockResolvedValue(undefined);
  mockDisarm.mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env.TEAMS_GRAPH_ENABLED;
});

describe('GET /api/teams/meetings/[id]', () => {
  it('tells the screen whether the integration is on', async () => {
    mockGet.mockResolvedValueOnce(row());
    expect((await (await GET(req(), { params })).json()).enabled).toBe(true);

    delete process.env.TEAMS_GRAPH_ENABLED;
    mockGet.mockResolvedValueOnce(row({ state: 'needs_reauth' }));
    const body = await (await GET(req(), { params })).json();
    expect(body.enabled).toBe(false);
    expect(body.state).toBe('needs_reauth');
  });

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
      enabled: true,
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

    expect(await res.json()).toEqual({ ok: true, disarmed: true });
    expect(mockDisarm).toHaveBeenCalledWith('user-123', 'graph-1', null);
    expect(mockDelete).toHaveBeenCalledWith('user-123', 'm1');
  });

  it('hands the stored pre-arm options to the disarm', async () => {
    const original = {
      allowRecording: false,
      allowTranscription: false,
      recordAutomatically: false,
      meetingSpokenLanguageTag: 'en-GB',
    };
    mockGet.mockResolvedValueOnce(row({ armed: true, originalOptions: original }));

    await DELETE(req(), { params });

    expect(mockDisarm).toHaveBeenCalledWith('user-123', 'graph-1', original);
  });

  it('also undoes a meeting whose policy blocked the arm: the PATCH went out anyway', async () => {
    mockGet.mockResolvedValueOnce(row({ armed: false, armResult: 'policy_blocked' }));

    await DELETE(req(), { params });

    expect(mockDisarm).toHaveBeenCalledWith('user-123', 'graph-1', null);
  });

  it('does not disarm a meeting we never armed, and says there was nothing to undo', async () => {
    mockGet.mockResolvedValueOnce(row({ armed: false, armResult: 'not_organizer' }));
    const res = await DELETE(req(), { params });
    expect(mockDisarm).not.toHaveBeenCalled();
    expect(mockDelete).toHaveBeenCalled();
    expect(await res.json()).toEqual({ ok: true, disarmed: true });
  });

  it('still deletes when disarming fails', async () => {
    mockGet.mockResolvedValueOnce(row({ armed: true }));
    mockDisarm.mockRejectedValueOnce(new GraphError('http', 'Graph-fejl.'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await DELETE(req(), { params });

    expect(await res.json()).toEqual({ ok: true, disarmed: false });
    expect(mockDelete).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('says so, and logs it, when the integration is off and the meeting stays armed in Teams', async () => {
    delete process.env.TEAMS_GRAPH_ENABLED;
    mockGet.mockResolvedValueOnce(row({ armed: true }));
    mockDisarm.mockRejectedValueOnce(
      new GraphError('disabled', 'Teams-integrationen er ikke slået til.', { status: 403 }),
    );
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await DELETE(req(), { params });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, disarmed: false });
    expect(mockDelete).toHaveBeenCalledWith('user-123', 'm1');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('POST /api/teams/meetings/[id] — recollect', () => {
  const post = (body: unknown = { action: 'recollect' }) =>
    new NextRequest('http://localhost/api/teams/meetings/m1', {
      method: 'POST',
      body: JSON.stringify(body),
    });

  // The scenario: the poller marked the row ready and stashed the transcript, but
  // nobody collected it within the TTL, so the stash is gone. Graph still holds the
  // artifacts, so the row goes back to a pollable state and the pipeline re-runs —
  // the same mechanism "Prøv igen" uses for a failed row, not a new state machine.
  const recentlyEnded = () => new Date(Date.now() - 2 * 60 * 60 * 1000);

  beforeEach(() => {
    mockSetState.mockResolvedValue(undefined);
    mockReadStash.mockResolvedValue(null);
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    expect((await POST(post(), { params })).status).toBe(401);
  });

  it('returns 404 for a meeting the caller does not own', async () => {
    mockGet.mockResolvedValueOnce(null);
    expect((await POST(post(), { params })).status).toBe(404);
    expect(mockSetState).not.toHaveBeenCalled();
  });

  it('rejects an unknown action', async () => {
    mockGet.mockResolvedValueOnce(row({ state: 'ready' }));
    expect((await POST(post({ action: 'nope' }), { params })).status).toBe(400);
    expect(mockSetState).not.toHaveBeenCalled();
  });

  it('puts a ready row whose stash is gone back to awaiting_teams', async () => {
    mockGet
      .mockResolvedValueOnce(row({ state: 'ready', scheduledEnd: recentlyEnded() }))
      .mockResolvedValueOnce(row({ state: 'awaiting_teams', scheduledEnd: recentlyEnded() }));

    const res = await POST(post(), { params });

    expect(res.status).toBe(200);
    expect(mockSetState).toHaveBeenCalledWith('user-123', 'm1', 'awaiting_teams', null);
    expect((await res.json()).state).toBe('awaiting_teams');
  });

  it('leaves a ready row alone while its stash is still there (nothing to re-collect)', async () => {
    mockGet.mockResolvedValueOnce(row({ state: 'ready', scheduledEnd: recentlyEnded() }));
    mockReadStash.mockResolvedValueOnce({ status: 'ready', segments: [], createdAt: 1 });

    const res = await POST(post(), { params });

    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe('ready');
    expect(mockSetState).not.toHaveBeenCalled();
  });

  it.each(['awaiting_teams', 'fetching', 'failed', 'needs_reauth'] as const)(
    'refuses a %s row: only a ready one has anything to re-collect',
    async (state) => {
      mockGet.mockResolvedValueOnce(row({ state }));
      const res = await POST(post(), { params });
      expect(res.status).toBe(409);
      expect(mockSetState).not.toHaveBeenCalled();
    },
  );

  // pollMeeting gives up on a row 24 h after the meeting and would then mark the
  // revived row failed, losing the ready state for good. So refuse beforehand.
  it('refuses once the poller would give up on the meeting anyway, and leaves the row untouched', async () => {
    const tooOld = new Date(Date.now() - POLL_GIVE_UP_MS - 60_000);
    mockGet.mockResolvedValueOnce(row({ state: 'ready', scheduledEnd: tooOld }));

    const res = await POST(post(), { params });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('window_closed');
    expect(mockSetState).not.toHaveBeenCalled();
  });
});
