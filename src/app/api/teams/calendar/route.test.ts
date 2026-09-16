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
vi.mock('@/lib/teams/calendar', () => ({ listUpcomingOnlineMeetings: vi.fn() }));
vi.mock('@/lib/teams/store', () => ({ listTeamsMeetings: vi.fn() }));

import { GET } from './route';
import { auth } from '@/lib/auth';
import { listUpcomingOnlineMeetings, type CalendarMeeting } from '@/lib/teams/calendar';
import { GraphError } from '@/lib/teams/graph-client';
import { listTeamsMeetings, type TeamsMeetingRow } from '@/lib/teams/store';
import { FAKE_SESSION } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockCalendar = vi.mocked(listUpcomingOnlineMeetings);
const mockList = vi.mocked(listTeamsMeetings);

const JOIN = 'https://teams.microsoft.com/l/meetup-join/19:abc@thread.v2/0';

const EVENT: CalendarMeeting = {
  eventId: 'e1',
  subject: 'Ugentligt møde',
  start: '2026-09-09T10:00:00.000Z',
  end: '2026-09-09T11:00:00.000Z',
  joinUrl: JOIN,
  isOrganizer: true,
  isRecurring: false,
};

const req = (qs = '') => new NextRequest(`http://localhost/api/teams/calendar${qs}`);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue(FAKE_SESSION as never);
  mockList.mockResolvedValue([]);
});

describe('GET /api/teams/calendar', () => {
  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    expect((await GET(req())).status).toBe(401);
  });

  it('defaults to 7 days and marks unregistered meetings with a null id', async () => {
    mockCalendar.mockResolvedValueOnce([EVENT]);

    const res = await GET(req());

    expect(mockCalendar).toHaveBeenCalledWith('user-123', { days: 7 });
    expect(await res.json()).toEqual({ meetings: [{ ...EVENT, armedMeetingId: null }] });
  });

  it('honours ?days= and clamps it', async () => {
    mockCalendar.mockResolvedValue([]);
    await GET(req('?days=3'));
    expect(mockCalendar).toHaveBeenCalledWith('user-123', { days: 3 });

    await GET(req('?days=999'));
    expect(mockCalendar).toHaveBeenLastCalledWith('user-123', { days: 30 });

    await GET(req('?days=abc'));
    expect(mockCalendar).toHaveBeenLastCalledWith('user-123', { days: 7 });
  });

  it('links a calendar entry to an existing meeting row by join URL', async () => {
    mockCalendar.mockResolvedValueOnce([EVENT, { ...EVENT, eventId: 'e2', joinUrl: null }]);
    mockList.mockResolvedValueOnce([
      { id: 'm1', joinUrl: JOIN.toUpperCase() } as unknown as TeamsMeetingRow,
    ]);

    const body = await (await GET(req())).json();

    expect(body.meetings[0].armedMeetingId).toBe('m1');
    expect(body.meetings[1].armedMeetingId).toBeNull();
  });

  it('arms only the registered occurrence of a recurring series', async () => {
    // Every occurrence shares one join URL, so keying on it alone rendered the
    // whole series as armed against the first occurrence's row.
    mockCalendar.mockResolvedValueOnce([
      { ...EVENT, eventId: 'occ-1', isRecurring: true },
      { ...EVENT, eventId: 'occ-2', isRecurring: true },
    ]);
    mockList.mockResolvedValueOnce([
      { id: 'm2', eventId: 'occ-2', joinUrl: JOIN } as unknown as TeamsMeetingRow,
    ]);

    const body = await (await GET(req())).json();

    expect(body.meetings[0].armedMeetingId).toBeNull();
    expect(body.meetings[1].armedMeetingId).toBe('m2');
  });

  it('maps a consent error to 403', async () => {
    mockCalendar.mockRejectedValueOnce(
      new GraphError('consent_required', 'Mangler samtykke.', { missingScopes: ['Calendars.Read'] }),
    );
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'consent_required', missing: ['Calendars.Read'] });
  });
});
