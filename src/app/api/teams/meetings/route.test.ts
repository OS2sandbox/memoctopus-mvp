import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/db', () => ({ pool: {}, db: {} }));
vi.mock('@/lib/db/user-schema', () => ({
  queryUserSchema: vi.fn(),
  queryUserSchemaOne: vi.fn(),
  ensureUserSchema: vi.fn(),
}));
vi.mock('@/lib/teams/meeting-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/teams/meeting-resolver')>();
  return { ...actual, resolveJoinUrl: vi.fn() };
});
vi.mock('@/lib/teams/meeting-arm', () => ({ armMeeting: vi.fn() }));
vi.mock('@/lib/teams/store', () => ({
  upsertTeamsMeeting: vi.fn(),
  getTeamsMeeting: vi.fn(),
  getTeamsMeetingByGraphId: vi.fn(),
}));
vi.mock('@/lib/pending-artifacts', () => ({
  getMeetingOwner: vi.fn(),
  setMeetingOwner: vi.fn(),
}));

import { POST } from './route';
import { auth } from '@/lib/auth';
import { GraphError } from '@/lib/teams/graph-client';
import { armMeeting } from '@/lib/teams/meeting-arm';
import { ResolveError, resolveJoinUrl } from '@/lib/teams/meeting-resolver';
import {
  getTeamsMeeting,
  getTeamsMeetingByGraphId,
  upsertTeamsMeeting,
  type TeamsMeetingRow,
} from '@/lib/teams/store';
import { getMeetingOwner, setMeetingOwner } from '@/lib/pending-artifacts';
import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockResolve = vi.mocked(resolveJoinUrl);
const mockArm = vi.mocked(armMeeting);
const mockUpsert = vi.mocked(upsertTeamsMeeting);
const mockGetRow = vi.mocked(getTeamsMeeting);
const mockGetSibling = vi.mocked(getTeamsMeetingByGraphId);
const mockGetOwner = vi.mocked(getMeetingOwner);
const mockSetOwner = vi.mocked(setMeetingOwner);

const URL_ = 'http://localhost/api/teams/meetings';
const JOIN = 'https://teams.microsoft.com/l/meetup-join/19:meeting_abc@thread.v2/0';

const RESOLVED = {
  graphMeetingId: 'graph-1',
  joinUrl: JOIN,
  subject: 'Ugentligt møde',
  organizerId: 'org-1',
  isOrganizer: true,
  scheduledStart: '2026-09-08T10:00:00.000Z',
  scheduledEnd: '2026-09-08T11:00:00.000Z',
  meetingType: null,
  options: {
    allowRecording: true,
    allowTranscription: true,
    recordAutomatically: true,
    meetingSpokenLanguageTag: 'da-DK',
  },
};

/** What the organizer had before we armed the meeting. */
const ORIGINAL = {
  allowRecording: false,
  allowTranscription: false,
  recordAutomatically: false,
  meetingSpokenLanguageTag: 'en-GB',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRow.mockResolvedValue(null);
  mockGetSibling.mockResolvedValue(null);
  process.env.TEAMS_GRAPH_ENABLED = 'true';
  mockGetSession.mockResolvedValue(FAKE_SESSION as never);
  mockGetOwner.mockResolvedValue(null);
  mockSetOwner.mockResolvedValue(undefined);
  mockUpsert.mockImplementation(async (_u, row) => ({
    lastPolledAt: null,
    attempts: 0,
    failureReason: null,
    transcriptId: null,
    recordingId: null,
    state: 'awaiting_teams' as const,
    eventId: null,
    armResult: 'not_organizer' as const,
    createdAt: new Date('2026-09-08T09:00:00Z'),
    ...row,
  }));
});

afterEach(() => {
  delete process.env.TEAMS_GRAPH_ENABLED;
});

const post = (body: unknown) => POST(makeJsonReq(URL_, 'POST', body));

describe('POST /api/teams/meetings', () => {
  it('refuses with 403 disabled, and registers nothing, while the integration is off', async () => {
    delete process.env.TEAMS_GRAPH_ENABLED;
    const res = await post({ meetingId: 'm1', joinUrl: JOIN });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('disabled');
    expect(mockSetOwner).not.toHaveBeenCalled();
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    expect((await post({ meetingId: 'm1', joinUrl: JOIN })).status).toBe(401);
  });

  it('returns 400 when meetingId is missing', async () => {
    const res = await post({ joinUrl: JOIN });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'missing-meeting-id' });
  });

  it('returns 400 when joinUrl is missing', async () => {
    const res = await post({ meetingId: 'm1' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid-url' });
  });

  it('rejects a meeting id that could escape the stash directory', async () => {
    // The id becomes a file name in the pending stash and in the pipeline's
    // scratch directory.
    const res = await post({ meetingId: '../../etc/passwd', joinUrl: JOIN });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid-meeting-id' });
    expect(mockSetOwner).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('binds the meeting id to the registering user', async () => {
    // Both hand-off routes deny by default without an owner file, so this is
    // what makes the Teams hand-off work at all — and what keeps the stash from
    // being readable by whoever else guesses the id.
    mockResolve.mockResolvedValueOnce(RESOLVED);
    mockArm.mockResolvedValueOnce({ result: 'armed', options: RESOLVED.options, previousOptions: ORIGINAL });

    await post({ meetingId: 'm1', joinUrl: JOIN });

    expect(mockSetOwner).toHaveBeenCalledWith('m1', 'user-123');
  });

  it('refuses a meeting id another user already owns', async () => {
    mockGetOwner.mockResolvedValueOnce('someone-else');

    const res = await post({ meetingId: 'm1', joinUrl: JOIN });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'meeting-id-taken' });
    expect(mockSetOwner).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('re-registering your own meeting is fine', async () => {
    mockGetOwner.mockResolvedValueOnce('user-123');
    mockResolve.mockResolvedValueOnce(RESOLVED);
    mockArm.mockResolvedValueOnce({ result: 'armed', options: RESOLVED.options, previousOptions: ORIGINAL });

    expect((await post({ meetingId: 'm1', joinUrl: JOIN })).status).toBe(200);
  });

  it('prefers the occurrence window and stores its event id', async () => {
    // A recurring series has one onlineMeeting whose window is the series';
    // occurrence 2+ would otherwise never have its artifacts picked up.
    mockResolve.mockResolvedValueOnce(RESOLVED);
    mockArm.mockResolvedValueOnce({ result: 'armed', options: RESOLVED.options, previousOptions: ORIGINAL });

    await post({
      meetingId: 'm1',
      joinUrl: JOIN,
      eventId: 'evt-2',
      scheduledStart: '2026-09-15T10:00:00.000Z',
      scheduledEnd: '2026-09-15T11:00:00.000Z',
    });

    expect(mockUpsert).toHaveBeenCalledWith(
      'user-123',
      expect.objectContaining({
        eventId: 'evt-2',
        scheduledStart: new Date('2026-09-15T10:00:00.000Z'),
        scheduledEnd: new Date('2026-09-15T11:00:00.000Z'),
      }),
    );
  });

  it('falls back to the Graph window when the client sends no occurrence', async () => {
    mockResolve.mockResolvedValueOnce(RESOLVED);
    mockArm.mockResolvedValueOnce({ result: 'armed', options: RESOLVED.options, previousOptions: ORIGINAL });

    await post({ meetingId: 'm1', joinUrl: JOIN });

    expect(mockUpsert).toHaveBeenCalledWith(
      'user-123',
      expect.objectContaining({
        eventId: null,
        scheduledEnd: new Date('2026-09-08T11:00:00.000Z'),
      }),
    );
  });

  it('arms the meeting and stores the row when we are the organizer', async () => {
    mockResolve.mockResolvedValueOnce(RESOLVED);
    mockArm.mockResolvedValueOnce({ result: 'armed', options: RESOLVED.options, previousOptions: ORIGINAL });

    const res = await post({ meetingId: 'm1', joinUrl: JOIN });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: 'm1',
      graphMeetingId: 'graph-1',
      subject: 'Ugentligt møde',
      scheduledStart: '2026-09-08T10:00:00.000Z',
      scheduledEnd: '2026-09-08T11:00:00.000Z',
      isOrganizer: true,
      armed: true,
      armResult: 'armed',
      state: 'awaiting_teams',
    });
    expect(mockArm).toHaveBeenCalledWith('user-123', 'graph-1');
    expect(mockUpsert).toHaveBeenCalledWith(
      'user-123',
      expect.objectContaining({
        id: 'm1',
        graphMeetingId: 'graph-1',
        armed: true,
        state: 'awaiting_teams',
        scheduledEnd: new Date('2026-09-08T11:00:00.000Z'),
      }),
    );
  });

  it('stores the pre-arm options on the row so a disarm can restore them', async () => {
    mockResolve.mockResolvedValueOnce(RESOLVED);
    mockArm.mockResolvedValueOnce({ result: 'armed', options: RESOLVED.options, previousOptions: ORIGINAL });

    await post({ meetingId: 'm1', joinUrl: JOIN });

    expect(mockUpsert).toHaveBeenCalledWith(
      'user-123',
      expect.objectContaining({ originalOptions: ORIGINAL }),
    );
  });

  it('stores the snapshot for a policy_blocked meeting too: the PATCH still went out', async () => {
    mockResolve.mockResolvedValueOnce(RESOLVED);
    mockArm.mockResolvedValueOnce({
      result: 'policy_blocked',
      options: { ...RESOLVED.options, recordAutomatically: false },
      previousOptions: ORIGINAL,
    });

    await post({ meetingId: 'm1', joinUrl: JOIN });

    expect(mockUpsert).toHaveBeenCalledWith(
      'user-123',
      expect.objectContaining({ originalOptions: ORIGINAL }),
    );
  });

  it('stores no snapshot when the PATCH was refused (not the organizer)', async () => {
    mockResolve.mockResolvedValueOnce(RESOLVED);
    mockArm.mockResolvedValueOnce({
      result: 'not_organizer',
      options: ORIGINAL,
      previousOptions: ORIGINAL,
    });

    await post({ meetingId: 'm1', joinUrl: JOIN });

    expect(mockUpsert.mock.calls[0][1].originalOptions ?? null).toBeNull();
  });

  it('does not replace the snapshot of a row we already armed', async () => {
    // Re-registering reads back the values WE set; taking those as the
    // organizer's originals would make the disarm a no-op.
    mockGetRow.mockResolvedValueOnce({ armed: true, armResult: 'armed' } as TeamsMeetingRow);
    mockResolve.mockResolvedValueOnce(RESOLVED);
    mockArm.mockResolvedValueOnce({
      result: 'armed',
      options: RESOLVED.options,
      previousOptions: RESOLVED.options,
    });

    await post({ meetingId: 'm1', joinUrl: JOIN });

    expect(mockGetRow).toHaveBeenCalledWith('user-123', 'm1');
    expect(mockUpsert.mock.calls[0][1].originalOptions ?? null).toBeNull();
  });

  it('takes a fresh snapshot when the earlier registration never touched the meeting', async () => {
    mockGetRow.mockResolvedValueOnce({ armed: false, armResult: 'not_organizer' } as TeamsMeetingRow);
    mockResolve.mockResolvedValueOnce(RESOLVED);
    mockArm.mockResolvedValueOnce({ result: 'armed', options: RESOLVED.options, previousOptions: ORIGINAL });

    await post({ meetingId: 'm1', joinUrl: JOIN });

    expect(mockUpsert).toHaveBeenCalledWith(
      'user-123',
      expect.objectContaining({ originalOptions: ORIGINAL }),
    );
  });

  // A recurring series shares ONE Graph onlineMeeting, and the dashboard mints a new local
  // id for every pasted link. Looking the row up by local id alone finds nothing for
  // occurrence 2, so the pre-PATCH read (which by then holds OUR values) would be stored
  // as the "original", and deleting that occurrence would "restore" Teams to armed.
  describe('the same Graph meeting registered under another local id', () => {
    it('inherits the snapshot of the sibling we already armed instead of recording our own values', async () => {
      mockGetRow.mockResolvedValueOnce(null);
      mockGetSibling.mockResolvedValueOnce({
        armed: true,
        armResult: 'armed',
        originalOptions: ORIGINAL,
      } as TeamsMeetingRow);
      mockResolve.mockResolvedValueOnce(RESOLVED);
      mockArm.mockResolvedValueOnce({
        result: 'armed',
        options: RESOLVED.options,
        previousOptions: RESOLVED.options, // read-back of our own earlier arming
      });

      await post({ meetingId: 'm2', joinUrl: JOIN });

      expect(mockGetSibling).toHaveBeenCalledWith('user-123', 'graph-1');
      expect(mockUpsert).toHaveBeenCalledWith(
        'user-123',
        expect.objectContaining({ id: 'm2', originalOptions: ORIGINAL }),
      );
    });

    it('records no snapshot when the armed sibling has none (armed before snapshots existed)', async () => {
      mockGetRow.mockResolvedValueOnce(null);
      mockGetSibling.mockResolvedValueOnce({
        armed: true,
        armResult: 'armed',
        originalOptions: null,
      } as TeamsMeetingRow);
      mockResolve.mockResolvedValueOnce(RESOLVED);
      mockArm.mockResolvedValueOnce({
        result: 'armed',
        options: RESOLVED.options,
        previousOptions: RESOLVED.options,
      });

      await post({ meetingId: 'm2', joinUrl: JOIN });

      // Falling back to "reset recordAutomatically" beats storing our own values as originals.
      expect(mockUpsert.mock.calls[0][1].originalOptions ?? null).toBeNull();
    });

    it('takes a fresh snapshot when the sibling never touched the meeting', async () => {
      mockGetRow.mockResolvedValueOnce(null);
      mockGetSibling.mockResolvedValueOnce({ armed: false, armResult: 'not_organizer' } as TeamsMeetingRow);
      mockResolve.mockResolvedValueOnce(RESOLVED);
      mockArm.mockResolvedValueOnce({ result: 'armed', options: RESOLVED.options, previousOptions: ORIGINAL });

      await post({ meetingId: 'm2', joinUrl: JOIN });

      expect(mockUpsert).toHaveBeenCalledWith(
        'user-123',
        expect.objectContaining({ originalOptions: ORIGINAL }),
      );
    });

    it('does not look for a sibling when this very id was already armed', async () => {
      mockGetRow.mockResolvedValueOnce({ armed: true, armResult: 'armed' } as TeamsMeetingRow);
      mockResolve.mockResolvedValueOnce(RESOLVED);
      mockArm.mockResolvedValueOnce({ result: 'armed', options: RESOLVED.options, previousOptions: RESOLVED.options });

      await post({ meetingId: 'm1', joinUrl: JOIN });

      expect(mockGetSibling).not.toHaveBeenCalled();
    });
  });

  it('registers an invitee without arming', async () => {
    mockResolve.mockResolvedValueOnce({ ...RESOLVED, isOrganizer: false });

    const res = await post({ meetingId: 'm1', joinUrl: JOIN });
    const body = await res.json();

    expect(mockArm).not.toHaveBeenCalled();
    expect(body.armResult).toBe('not_organizer');
    expect(body.armed).toBe(false);
    expect(body.state).toBe('awaiting_teams');
  });

  it('reports policy_blocked but still registers the meeting', async () => {
    mockResolve.mockResolvedValueOnce(RESOLVED);
    mockArm.mockResolvedValueOnce({
      result: 'policy_blocked',
      options: { ...RESOLVED.options, recordAutomatically: false },
      previousOptions: ORIGINAL,
    });

    const body = await (await post({ meetingId: 'm1', joinUrl: JOIN })).json();
    expect(body.armResult).toBe('policy_blocked');
    expect(body.armed).toBe(false);
    // Persisted, not only returned: a reload must not tell a blocked organizer
    // that they are "not the organizer".
    expect(mockUpsert).toHaveBeenCalledWith(
      'user-123',
      expect.objectContaining({ armed: false, armResult: 'policy_blocked' }),
    );
  });

  it('maps a wrong host to 400', async () => {
    mockResolve.mockRejectedValueOnce(new ResolveError('wrong-host'));
    const res = await post({ meetingId: 'm1', joinUrl: 'https://zoom.us/j/1' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('wrong-host');
  });

  it('maps not_invited to 404', async () => {
    mockResolve.mockRejectedValueOnce(new ResolveError('not_invited'));
    const res = await post({ meetingId: 'm1', joinUrl: JOIN });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('not_invited');
  });

  it('maps consent_required to 403 with the missing scopes', async () => {
    mockResolve.mockRejectedValueOnce(
      new GraphError('consent_required', 'Mangler samtykke.', { missingScopes: ['OnlineMeetings.ReadWrite'] }),
    );
    const res = await post({ meetingId: 'm1', joinUrl: JOIN });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: 'consent_required',
      missing: ['OnlineMeetings.ReadWrite'],
    });
  });

  it('maps reauth_required to 403', async () => {
    mockResolve.mockRejectedValueOnce(new GraphError('reauth_required', 'Log ind igen.'));
    const res = await post({ meetingId: 'm1', joinUrl: JOIN });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('reauth_required');
  });

  it('maps a plain Graph HTTP failure to 502', async () => {
    mockResolve.mockRejectedValueOnce(new GraphError('http', 'Graph-fejl.', { status: 500 }));
    const res = await post({ meetingId: 'm1', joinUrl: JOIN });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('graph');
  });
});
