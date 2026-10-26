import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({ pool: {}, db: {} }));
vi.mock('@/lib/auth', () => ({ auth: { api: {} } }));
vi.mock('@/lib/outlook/addin-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/outlook/addin-auth')>()),
  authenticateAddinRequest: vi.fn(),
}));
vi.mock('@/lib/teams/meeting-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/teams/meeting-resolver')>()),
  resolveJoinUrl: vi.fn(),
}));
vi.mock('@/lib/teams/register', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/teams/register')>()),
  registerTeamsMeeting: vi.fn(),
  unregisterTeamsMeeting: vi.fn(),
}));
vi.mock('@/lib/teams/store', () => ({
  listTeamsMeetingsByGraphId: vi.fn(),
  getTeamsMeeting: vi.fn(),
}));

import { POST } from './route';
import { DELETE } from './[id]/route';
import { AddinAuthError, authenticateAddinRequest } from '@/lib/outlook/addin-auth';
import { ResolveError, resolveJoinUrl } from '@/lib/teams/meeting-resolver';
import { registerTeamsMeeting, unregisterTeamsMeeting } from '@/lib/teams/register';
import { getTeamsMeeting, listTeamsMeetingsByGraphId } from '@/lib/teams/store';

const mockAuth = vi.mocked(authenticateAddinRequest);
const mockResolve = vi.mocked(resolveJoinUrl);
const mockRegister = vi.mocked(registerTeamsMeeting);
const mockUnregister = vi.mocked(unregisterTeamsMeeting);
const mockByGraphId = vi.mocked(listTeamsMeetingsByGraphId);
const mockGet = vi.mocked(getTeamsMeeting);

const JOIN = 'https://teams.microsoft.com/l/meetup-join/19:meeting_abc@thread.v2/0';
const RESOLVED = {
  graphMeetingId: 'graph-1',
  joinUrl: JOIN,
  subject: 'Styregruppe',
  organizerId: 'org-1',
  isOrganizer: true,
  scheduledStart: '2026-10-27T09:00:00Z',
  scheduledEnd: '2026-10-27T10:00:00Z',
  meetingType: null,
  options: null,
} as never;

function post(body: unknown, token = 'a.b.c') {
  return POST(
    new Request('http://localhost/api/outlook/meetings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }) as never,
  );
}

function del(id: string) {
  return DELETE(
    new Request(`http://localhost/api/outlook/meetings/${id}`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer a.b.c' },
    }) as never,
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mockAuth.mockResolvedValue('user-1');
  mockResolve.mockResolvedValue(RESOLVED);
  mockByGraphId.mockResolvedValue([]);
  mockRegister.mockImplementation(async (_u, input) => ({
    row: {
      id: input.meetingId,
      subject: 'Styregruppe',
      scheduledStart: new Date('2026-10-27T09:00:00Z'),
      scheduledEnd: new Date('2026-10-27T10:00:00Z'),
      isOrganizer: true,
      armed: true,
    } as never,
    armResult: 'armed',
  }));
});

describe('POST /api/outlook/meetings', () => {
  it('refuses without a valid add-in token, before touching Graph', async () => {
    mockAuth.mockRejectedValueOnce(new AddinAuthError('invalid_token', 'bad signature'));

    const res = await post({ joinUrl: JOIN });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'invalid_token' });
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('says so when the feature is off', async () => {
    mockAuth.mockRejectedValueOnce(new AddinAuthError('disabled'));
    expect((await post({ joinUrl: JOIN })).status).toBe(403);
  });

  it('refuses a link that is not a Teams link, before touching Graph', async () => {
    const res = await post({ joinUrl: 'https://evil.example/l/meetup-join/x' });
    expect(res.status).toBe(400);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('arms a new meeting under a fresh id, marked as from Outlook', async () => {
    const res = await post({ joinUrl: JOIN });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ armResult: 'armed', armed: true, alreadyRegistered: false });
    expect(body.id).toMatch(/^ol-[0-9a-f-]{36}$/);
    expect(mockRegister).toHaveBeenCalledWith('user-1', {
      meetingId: body.id,
      joinUrl: JOIN,
      resolved: RESOLVED,
      occurrenceStart: null,
      occurrenceEnd: null,
      origin: 'outlook',
      keepState: false,
    });
  });

  it('uses the appointment\'s own times, so a series occurrence gets its window', async () => {
    await post({ joinUrl: JOIN, start: '2026-11-03T09:00:00.000Z', end: '2026-11-03T10:00:00.000Z' });
    expect(mockRegister.mock.calls[0][1]).toMatchObject({
      occurrenceStart: new Date('2026-11-03T09:00:00.000Z'),
      occurrenceEnd: new Date('2026-11-03T10:00:00.000Z'),
    });
  });

  it('ignores times that do not make a window', async () => {
    await post({ joinUrl: JOIN, start: '2026-11-03T10:00:00.000Z', end: '2026-11-03T09:00:00.000Z' });
    expect(mockRegister.mock.calls[0][1]).toMatchObject({ occurrenceStart: null, occurrenceEnd: null });
    await post({ joinUrl: JOIN, start: 'not a date', end: 42 });
    expect(mockRegister.mock.calls[1][1]).toMatchObject({ occurrenceStart: null, occurrenceEnd: null });
  });

  it('re-arms the same row when the button is pressed again, keeping its state', async () => {
    mockByGraphId.mockResolvedValueOnce([
      { id: 'ol-existing', state: 'fetching', origin: 'outlook', scheduledStart: null },
    ] as never);

    const body = await (await post({ joinUrl: JOIN })).json();

    expect(body).toMatchObject({ id: 'ol-existing', alreadyRegistered: true });
    expect(mockRegister.mock.calls[0][1]).toMatchObject({ meetingId: 'ol-existing', keepState: true });
  });

  it('keeps occurrences of a series apart', async () => {
    mockByGraphId.mockResolvedValueOnce([
      { id: 'ol-week1', state: 'awaiting_teams', origin: 'outlook', scheduledStart: new Date('2026-11-03T09:00:00.000Z') },
    ] as never);

    const body = await (await post({ joinUrl: JOIN, start: '2026-11-10T09:00:00.000Z', end: '2026-11-10T10:00:00.000Z' })).json();

    expect(body.id).not.toBe('ol-week1');
    expect(body.alreadyRegistered).toBe(false);
  });

  it('starts a new row when the existing one is finished', async () => {
    mockByGraphId.mockResolvedValueOnce([{ id: 'ol-old', state: 'ready', origin: 'outlook', scheduledStart: null }] as never);

    const body = await (await post({ joinUrl: JOIN })).json();

    expect(body.id).not.toBe('ol-old');
    expect(body.alreadyRegistered).toBe(false);
  });

  it('leaves a meeting registered in the dashboard exactly as it is', async () => {
    mockByGraphId.mockResolvedValueOnce([
      { id: 'd-1', state: 'awaiting_teams', origin: null, armed: true, armResult: 'armed', subject: 'S', isOrganizer: true, scheduledStart: null, scheduledEnd: null },
    ] as never);

    const body = await (await post({ joinUrl: JOIN })).json();

    expect(body).toMatchObject({ id: 'd-1', managedInDashboard: true, alreadyRegistered: true, armed: true });
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('passes Graph errors on with their Danish message', async () => {
    mockResolve.mockRejectedValueOnce(new ResolveError('not_invited', 'Du er ikke inviteret.'));

    const res = await post({ joinUrl: JOIN });

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_invited', message: 'Du er ikke inviteret.' });
  });
});

describe('DELETE /api/outlook/meetings/[id]', () => {
  it('switches off a meeting armed from Outlook', async () => {
    mockGet.mockResolvedValueOnce({ id: 'ol-1', origin: 'outlook' } as never);
    mockUnregister.mockResolvedValueOnce({ disarmed: true });

    const res = await del('ol-1');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, disarmed: true });
    expect(mockGet).toHaveBeenCalledWith('user-1', 'ol-1');
  });

  it('leaves a meeting registered in the dashboard alone', async () => {
    mockGet.mockResolvedValueOnce({ id: 'd-1', origin: null } as never);

    expect((await del('d-1')).status).toBe(404);
    expect(mockUnregister).not.toHaveBeenCalled();
  });

  it('is a 404 for an id that is not the caller\'s', async () => {
    mockGet.mockResolvedValueOnce(null);
    expect((await del('ol-other')).status).toBe(404);
  });

  it('refuses without a valid add-in token', async () => {
    mockAuth.mockRejectedValueOnce(new AddinAuthError('missing_token'));
    expect((await del('ol-1')).status).toBe(401);
    expect(mockGet).not.toHaveBeenCalled();
  });
});
