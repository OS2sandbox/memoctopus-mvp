import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/teams/graph-client', () => ({
  graphJson: vi.fn(),
  graphFetch: vi.fn(),
  GraphError: class GraphError extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, options: { status?: number } = {}) {
      super(message);
      this.name = 'GraphError';
      this.code = code;
      this.status = options.status ?? 0;
    }
  },
}));

import { graphJson } from '@/lib/teams/graph-client';
import { resolveJoinUrl, getMeeting, getGraphMe, ResolveError } from './meeting-resolver';

const mockJson = vi.mocked(graphJson);
const USER = 'user-1';
const JOIN = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0';

function meeting(overrides: Record<string, unknown> = {}) {
  return {
    id: 'GRAPH-1',
    joinWebUrl: JOIN,
    subject: 'Bestyrelsesmøde',
    startDateTime: '2026-09-10T09:00:00.000Z',
    endDateTime: '2026-09-10T10:00:00.000Z',
    meetingType: 'meetNow',
    allowRecording: true,
    allowTranscription: true,
    recordAutomatically: false,
    meetingSpokenLanguageTag: 'da-DK',
    participants: { organizer: { identity: { user: { id: 'me-oid' } } } },
    ...overrides,
  };
}

/** Route by path so the /me call and the meeting call can't be swapped by accident. */
function routeGraph(handlers: { me?: unknown; onlineMeetings?: unknown }) {
  mockJson.mockImplementation(async (_user: string, path: string) => {
    if (path.startsWith('/me?')) return (handlers.me ?? { id: 'me-oid' }) as never;
    return (handlers.onlineMeetings ?? { value: [] }) as never;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveJoinUrl', () => {
  it('rejects a non-URL before touching Graph', async () => {
    await expect(resolveJoinUrl(USER, 'ikke en url')).rejects.toMatchObject({
      name: 'ResolveError',
      code: 'invalid-url',
    });
    expect(mockJson).not.toHaveBeenCalled();
  });

  it('rejects a non-Teams host', async () => {
    await expect(resolveJoinUrl(USER, 'https://evil.example.com/meet/1')).rejects.toMatchObject({
      code: 'wrong-host',
    });
    expect(mockJson).not.toHaveBeenCalled();
  });

  it('percent-encodes the filter and doubles single quotes in the literal', async () => {
    const tricky = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_o'brien%40thread.v2/0";
    routeGraph({ onlineMeetings: { value: [meeting({ joinWebUrl: tricky })] } });

    await resolveJoinUrl(USER, tricky);

    const path = mockJson.mock.calls.find((c) => c[1].includes('onlineMeetings'))![1];
    // % from the join link survives as %25, the quote is doubled, spaces are %20.
    expect(path).toBe(
      "/me/onlineMeetings?$filter=JoinWebUrl%20eq%20'https%3A%2F%2Fteams.microsoft.com%2Fl%2Fmeetup-join%2F19%253ameeting_o''brien%2540thread.v2%2F0'",
    );
    expect(decodeURIComponent(path.split('$filter=')[1])).toBe(
      `JoinWebUrl eq '${tricky.replace(/'/g, "''")}'`,
    );
  });

  it('throws not_invited when Graph returns no match', async () => {
    routeGraph({ onlineMeetings: { value: [] } });
    await expect(resolveJoinUrl(USER, JOIN)).rejects.toMatchObject({ code: 'not_invited' });
  });

  it('throws not_invited when Graph omits value entirely', async () => {
    routeGraph({ onlineMeetings: {} });
    await expect(resolveJoinUrl(USER, JOIN)).rejects.toBeInstanceOf(ResolveError);
  });

  it('maps the meeting and detects the organizer', async () => {
    routeGraph({ me: { id: 'me-oid' }, onlineMeetings: { value: [meeting()] } });

    const resolved = await resolveJoinUrl(USER, JOIN);

    expect(resolved).toEqual({
      graphMeetingId: 'GRAPH-1',
      joinUrl: JOIN,
      subject: 'Bestyrelsesmøde',
      organizerId: 'me-oid',
      isOrganizer: true,
      scheduledStart: '2026-09-10T09:00:00.000Z',
      scheduledEnd: '2026-09-10T10:00:00.000Z',
      meetingType: 'meetNow',
      options: {
        allowRecording: true,
        allowTranscription: true,
        recordAutomatically: false,
        meetingSpokenLanguageTag: 'da-DK',
      },
    });
  });

  // An instant ("Mød nu") meeting has no schedule, and Graph says so with the
  // .NET zero value rather than by omitting the field. Stored as a real date it
  // makes the meeting look two thousand years overdue, and the poller abandons it
  // before ever asking Graph for artifacts.
  it("treats Graph's zero date as no schedule at all", async () => {
    routeGraph({
      onlineMeetings: {
        value: [
          meeting({
            startDateTime: '0001-01-01T00:00:00Z',
            endDateTime: '0001-01-01T00:00:00Z',
          }),
        ],
      },
    });

    const resolved = await resolveJoinUrl('u1', JOIN);

    expect(resolved.scheduledStart).toBeNull();
    expect(resolved.scheduledEnd).toBeNull();
  });

  it('is not organizer when the organizer oid differs', async () => {
    routeGraph({ me: { id: 'me-oid' }, onlineMeetings: { value: [meeting()] } });
    const mine = await resolveJoinUrl(USER, JOIN);
    expect(mine.isOrganizer).toBe(true);

    routeGraph({
      me: { id: 'someone-else' },
      onlineMeetings: { value: [meeting()] },
    });
    const theirs = await resolveJoinUrl(USER, JOIN);
    expect(theirs.isOrganizer).toBe(false);
    expect(theirs.organizerId).toBe('me-oid');
  });

  it('is not organizer when either id is missing', async () => {
    routeGraph({
      me: {},
      onlineMeetings: { value: [meeting({ participants: {} })] },
    });
    const resolved = await resolveJoinUrl(USER, JOIN);
    expect(resolved.isOrganizer).toBe(false);
    expect(resolved.organizerId).toBeNull();
  });

  it('falls back to the pasted URL when Graph returns no joinWebUrl', async () => {
    routeGraph({ onlineMeetings: { value: [meeting({ joinWebUrl: null })] } });
    const resolved = await resolveJoinUrl(USER, JOIN);
    expect(resolved.joinUrl).toBe(JOIN);
  });

  it('asks Graph for /me exactly once', async () => {
    routeGraph({ onlineMeetings: { value: [meeting()] } });
    await resolveJoinUrl(USER, JOIN);
    expect(mockJson.mock.calls.filter((c) => c[1].startsWith('/me?'))).toHaveLength(1);
  });
});

describe('getMeeting', () => {
  it('encodes the meeting id in the path', async () => {
    routeGraph({ onlineMeetings: meeting({ id: 'MSo0#/2' }) });
    await getMeeting(USER, 'MSo0#/2');
    const path = mockJson.mock.calls.find((c) => c[1].includes('onlineMeetings'))![1];
    expect(path).toBe('/me/onlineMeetings/MSo0%23%2F2');
  });

  it('maps null options when Graph omits them', async () => {
    routeGraph({ onlineMeetings: { id: 'GRAPH-1' } });
    const resolved = await getMeeting(USER, 'GRAPH-1');
    expect(resolved.options).toEqual({
      allowRecording: null,
      allowTranscription: null,
      recordAutomatically: null,
      meetingSpokenLanguageTag: null,
    });
    expect(resolved.subject).toBeNull();
    expect(resolved.isOrganizer).toBe(false);
  });
});

describe('getGraphMe', () => {
  it('selects id, mail and userPrincipalName and null-fills', async () => {
    mockJson.mockResolvedValue({ id: 'me-oid' } as never);
    await expect(getGraphMe(USER)).resolves.toEqual({
      id: 'me-oid',
      mail: null,
      userPrincipalName: null,
    });
    expect(mockJson).toHaveBeenCalledWith(USER, '/me?$select=id,mail,userPrincipalName');
  });
});
