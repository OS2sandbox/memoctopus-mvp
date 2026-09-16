import { describe, it, expect, vi, beforeEach } from 'vitest';

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
vi.mock('@/lib/teams/store', () => ({ upsertTeamsMeeting: vi.fn() }));
vi.mock('@/lib/bot-pending-audio', () => ({
  getBotMeetingOwner: vi.fn(),
  setBotMeetingOwner: vi.fn(),
}));

import { POST } from './route';
import { auth } from '@/lib/auth';
import { GraphError } from '@/lib/teams/graph-client';
import { armMeeting } from '@/lib/teams/meeting-arm';
import { ResolveError, resolveJoinUrl } from '@/lib/teams/meeting-resolver';
import { upsertTeamsMeeting } from '@/lib/teams/store';
import { getBotMeetingOwner, setBotMeetingOwner } from '@/lib/bot-pending-audio';
import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockResolve = vi.mocked(resolveJoinUrl);
const mockArm = vi.mocked(armMeeting);
const mockUpsert = vi.mocked(upsertTeamsMeeting);
const mockGetOwner = vi.mocked(getBotMeetingOwner);
const mockSetOwner = vi.mocked(setBotMeetingOwner);

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

beforeEach(() => {
  vi.clearAllMocks();
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

const post = (body: unknown) => POST(makeJsonReq(URL_, 'POST', body));

describe('POST /api/teams/meetings', () => {
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
    mockArm.mockResolvedValueOnce({ result: 'armed', options: RESOLVED.options });

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
    mockArm.mockResolvedValueOnce({ result: 'armed', options: RESOLVED.options });

    expect((await post({ meetingId: 'm1', joinUrl: JOIN })).status).toBe(200);
  });

  it('prefers the occurrence window and stores its event id', async () => {
    // A recurring series has one onlineMeeting whose window is the series';
    // occurrence 2+ would otherwise never have its artifacts picked up.
    mockResolve.mockResolvedValueOnce(RESOLVED);
    mockArm.mockResolvedValueOnce({ result: 'armed', options: RESOLVED.options });

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
    mockArm.mockResolvedValueOnce({ result: 'armed', options: RESOLVED.options });

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
    mockArm.mockResolvedValueOnce({ result: 'armed', options: RESOLVED.options });

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
