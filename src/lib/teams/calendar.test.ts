import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/teams/graph-client', () => ({
  graphJson: vi.fn(),
  graphFetch: vi.fn(),
  GraphError: class GraphError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'GraphError';
      this.code = code;
    }
  },
}));

import { graphJson } from '@/lib/teams/graph-client';
import { listUpcomingOnlineMeetings } from './calendar';

const mockJson = vi.mocked(graphJson);
const USER = 'user-1';
const NOW = new Date('2026-09-08T08:00:00.000Z');

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
    subject: 'Ugentligt teammøde',
    start: { dateTime: '2026-09-09T09:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-09-09T10:00:00.0000000', timeZone: 'UTC' },
    isOnlineMeeting: true,
    onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/1' },
    organizer: { emailAddress: { address: 'Me@Kommune.dk' } },
    seriesMasterId: null,
    type: 'singleInstance',
    ...overrides,
  };
}

/** /me always resolves; calendarView pages are served in order. */
function serve(pages: unknown[], me: Record<string, unknown> = { id: 'me-oid', mail: 'me@kommune.dk' }) {
  let page = 0;
  mockJson.mockImplementation(async (_user: string, path: string) => {
    if (path.startsWith('/me?')) return me as never;
    const body = pages[Math.min(page, pages.length - 1)];
    page += 1;
    return body as never;
  });
}

function calendarPaths() {
  return mockJson.mock.calls.map((c) => c[1]).filter((p) => !p.startsWith('/me?'));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listUpcomingOnlineMeetings', () => {
  it('builds the calendarView query from the injected now and days', async () => {
    serve([{ value: [] }]);

    await listUpcomingOnlineMeetings(USER, { days: 7, now: NOW });

    const path = calendarPaths()[0];
    expect(path).toContain('/me/calendarView?');
    expect(path).toContain(`startDateTime=${encodeURIComponent('2026-09-08T08:00:00.000Z')}`);
    expect(path).toContain(`endDateTime=${encodeURIComponent('2026-09-15T08:00:00.000Z')}`);
    expect(path).toContain(
      '$select=id,subject,start,end,isOnlineMeeting,onlineMeeting,organizer,seriesMasterId,type',
    );
    expect(path).toContain('$orderby=start/dateTime');
    expect(path).toContain('$top=50');
  });

  it('defaults to 7 days ahead', async () => {
    serve([{ value: [] }]);
    await listUpcomingOnlineMeetings(USER, { now: NOW });
    expect(calendarPaths()[0]).toContain(
      `endDateTime=${encodeURIComponent('2026-09-15T08:00:00.000Z')}`,
    );
  });

  it('asks Graph to render times in UTC', async () => {
    serve([{ value: [] }]);
    await listUpcomingOnlineMeetings(USER, { now: NOW });
    const init = mockJson.mock.calls.find((c) => c[1].includes('calendarView'))![2] as RequestInit;
    expect(init.headers).toEqual({ Prefer: 'outlook.timezone="UTC"' });
  });

  it('maps an online meeting and normalises the timestamps to ISO', async () => {
    serve([{ value: [event()] }]);

    const [meeting] = await listUpcomingOnlineMeetings(USER, { now: NOW });

    expect(meeting).toEqual({
      eventId: 'evt-1',
      subject: 'Ugentligt teammøde',
      start: '2026-09-09T09:00:00.000Z',
      end: '2026-09-09T10:00:00.000Z',
      joinUrl: 'https://teams.microsoft.com/l/meetup-join/1',
      isOrganizer: true,
      isRecurring: false,
    });
  });

  it('drops events that are not online meetings or carry no join URL', async () => {
    serve([
      {
        value: [
          event({ id: 'keep' }),
          event({ id: 'not-online', isOnlineMeeting: false }),
          event({ id: 'no-url', onlineMeeting: { joinUrl: null } }),
          event({ id: 'no-online-object', onlineMeeting: null }),
        ],
      },
    ]);

    const meetings = await listUpcomingOnlineMeetings(USER, { now: NOW });

    expect(meetings.map((m) => m.eventId)).toEqual(['keep']);
  });

  it('compares the organizer address case-insensitively', async () => {
    serve([{ value: [event({ organizer: { emailAddress: { address: 'ME@KOMMUNE.DK' } } })] }]);
    const [mine] = await listUpcomingOnlineMeetings(USER, { now: NOW });
    expect(mine.isOrganizer).toBe(true);
  });

  it('falls back to userPrincipalName when the account has no mail', async () => {
    serve([{ value: [event({ organizer: { emailAddress: { address: 'me@kommune.dk' } } })] }], {
      id: 'me-oid',
      mail: null,
      userPrincipalName: 'me@kommune.dk',
    });
    const [mine] = await listUpcomingOnlineMeetings(USER, { now: NOW });
    expect(mine.isOrganizer).toBe(true);
  });

  it('is not organizer for someone else, or when we know no address at all', async () => {
    serve([{ value: [event({ organizer: { emailAddress: { address: 'chef@kommune.dk' } } })] }]);
    expect((await listUpcomingOnlineMeetings(USER, { now: NOW }))[0].isOrganizer).toBe(false);

    vi.clearAllMocks();
    serve([{ value: [event({ organizer: null })] }], { id: 'me-oid' });
    expect((await listUpcomingOnlineMeetings(USER, { now: NOW }))[0].isOrganizer).toBe(false);
  });

  it('flags recurrence from seriesMasterId or the event type', async () => {
    serve([
      {
        value: [
          event({ id: 'a', seriesMasterId: 'series-1' }),
          event({ id: 'b', type: 'occurrence' }),
          event({ id: 'c', type: 'exception' }),
          event({ id: 'd', type: 'seriesMaster' }),
          event({ id: 'e' }),
        ],
      },
    ]);

    const meetings = await listUpcomingOnlineMeetings(USER, { now: NOW });

    expect(meetings.map((m) => [m.eventId, m.isRecurring])).toEqual([
      ['a', true],
      ['b', true],
      ['c', true],
      ['d', true],
      ['e', false],
    ]);
  });

  it('follows @odata.nextLink', async () => {
    serve([
      { value: [event({ id: 'p1' })], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next-1' },
      { value: [event({ id: 'p2' })] },
    ]);

    const meetings = await listUpcomingOnlineMeetings(USER, { now: NOW });

    expect(meetings.map((m) => m.eventId)).toEqual(['p1', 'p2']);
    expect(calendarPaths()[1]).toBe('https://graph.microsoft.com/v1.0/next-1');
  });

  it('stops after three pages even if Graph keeps offering more', async () => {
    serve([
      { value: [event({ id: 'p' })], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next' },
    ]);

    const meetings = await listUpcomingOnlineMeetings(USER, { now: NOW });

    expect(calendarPaths()).toHaveLength(3);
    expect(meetings).toHaveLength(3);
  });

  it('survives an empty or malformed page body', async () => {
    serve([{}]);
    await expect(listUpcomingOnlineMeetings(USER, { now: NOW })).resolves.toEqual([]);
  });

  it('keeps a timestamp that already carries an offset, and an unparseable one verbatim', async () => {
    serve([
      {
        value: [
          event({ id: 'offset', start: { dateTime: '2026-09-09T11:00:00+02:00' } }),
          event({ id: 'broken', end: { dateTime: 'i morgen' } }),
        ],
      },
    ]);

    const [offset, broken] = await listUpcomingOnlineMeetings(USER, { now: NOW });

    expect(offset.start).toBe('2026-09-09T09:00:00.000Z');
    expect(broken.end).toBe('i morgen');
  });

  it('gives a subject-less event a Danish placeholder', async () => {
    serve([{ value: [event({ subject: null })] }]);
    expect((await listUpcomingOnlineMeetings(USER, { now: NOW }))[0].subject).toBe('(uden emne)');
  });
});
