import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/user-schema', () => ({
  queryUserSchema: vi.fn(async () => []),
  queryUserSchemaOne: vi.fn(async () => null),
}));

vi.mock('@/lib/db', () => ({
  pool: { query: vi.fn(async () => ({ rows: [] })) },
}));

import { pool } from '@/lib/db';
import { queryUserSchema, queryUserSchemaOne } from '@/lib/db/user-schema';
import {
  pollBackoffMs,
  isTeamsMeetingDue,
  upsertTeamsMeeting,
  getTeamsMeeting,
  getTeamsMeetingByGraphId,
  listTeamsMeetings,
  listDueTeamsMeetings,
  markPollAttempt,
  setTeamsMeetingState,
  deleteTeamsMeeting,
  listUserSchemaIds,
  userIdFromSchemaName,
  POLL_GIVE_UP_MS,
  STALE_FETCHING_MS,
  giveUpAnchor,
  type TeamsMeetingRow,
} from './store';

const mockQuery = vi.mocked(queryUserSchema);
const mockQueryOne = vi.mocked(queryUserSchemaOne);
const mockPoolQuery = vi.mocked(pool.query as unknown as (sql: string) => Promise<unknown>);

const USER = 'user-1';

const CREATED = new Date('2026-09-08T08:00:00Z');

const RAW = {
  id: 'm1',
  graph_meeting_id: 'GRAPH1',
  event_id: null,
  join_url: 'https://teams.microsoft.com/l/meetup-join/x',
  subject: 'Bestyrelsesmøde',
  organizer_id: 'org-1',
  is_organizer: true,
  armed: true,
  arm_result: 'armed',
  scheduled_start: new Date('2026-09-08T09:00:00Z'),
  scheduled_end: new Date('2026-09-08T10:00:00Z'),
  state: 'awaiting_teams',
  last_polled_at: null,
  attempts: 3,
  failure_reason: null,
  transcript_id: null,
  recording_id: null,
  created_at: CREATED,
};

function row(overrides: Partial<TeamsMeetingRow> = {}): TeamsMeetingRow {
  return {
    id: 'm1',
    graphMeetingId: 'GRAPH1',
    eventId: null,
    joinUrl: 'https://teams.microsoft.com/l/meetup-join/x',
    subject: null,
    organizerId: null,
    isOrganizer: false,
    armed: true,
    armResult: 'armed',
    scheduledStart: null,
    scheduledEnd: null,
    state: 'awaiting_teams',
    lastPolledAt: null,
    attempts: 0,
    failureReason: null,
    transcriptId: null,
    recordingId: null,
    createdAt: new Date('2026-09-08T08:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockQuery.mockResolvedValue([]);
  mockQueryOne.mockResolvedValue(null);
  mockPoolQuery.mockResolvedValue({ rows: [] } as never);
});

describe('pollBackoffMs', () => {
  it('polls every 2 minutes for the first 15 attempts', () => {
    expect(pollBackoffMs(0)).toBe(120_000);
    expect(pollBackoffMs(14)).toBe(120_000);
  });

  it('backs off to 15 minutes afterwards', () => {
    expect(pollBackoffMs(15)).toBe(900_000);
    expect(pollBackoffMs(200)).toBe(900_000);
  });
});

describe('isTeamsMeetingDue', () => {
  const now = new Date('2026-09-08T12:00:00Z');
  const ms = now.getTime();

  it('is due when the meeting has ended and was never polled', () => {
    expect(isTeamsMeetingDue(row({ scheduledEnd: new Date(ms - 60_000) }), now)).toBe(true);
  });

  it('is due when the schedule is unknown', () => {
    expect(isTeamsMeetingDue(row({ scheduledEnd: null }), now)).toBe(true);
  });

  it('retries a meeting parked in needs_reauth', () => {
    // The user re-consents in another tab; nothing else resets the row, so the
    // poller has to pick it back up on its own.
    expect(
      isTeamsMeetingDue(row({ state: 'needs_reauth', scheduledEnd: new Date(ms - 60_000) }), now),
    ).toBe(true);
  });

  it('picks up a row abandoned mid-fetch, but not one that just started', () => {
    const base = { state: 'fetching' as const, scheduledEnd: new Date(ms - 3_600_000) };
    expect(isTeamsMeetingDue(row({ ...base, lastPolledAt: new Date(ms - 60_000) }), now)).toBe(false);
    expect(
      isTeamsMeetingDue(
        row({ ...base, attempts: 20, lastPolledAt: new Date(ms - STALE_FETCHING_MS - 1000) }),
        now,
      ),
    ).toBe(true);
  });

  it('gives up on a meeting with no schedule, measured from when it was created', () => {
    // An ad-hoc "Mød nu" link Graph gives no window for used to poll forever.
    expect(
      isTeamsMeetingDue(
        row({ scheduledEnd: null, createdAt: new Date(ms - POLL_GIVE_UP_MS - 1000) }),
        now,
      ),
    ).toBe(false);
    expect(giveUpAnchor({ scheduledEnd: null, createdAt: CREATED })).toBe(CREATED);
  });

  // Graph expresses "this meeting has no schedule" as 0001-01-01T00:00:00Z rather
  // than by omitting the field, and every instant ("Mød nu") meeting carries it.
  // Read as a real scheduled end it sits two thousand years past the give-up
  // window, so the meeting was abandoned on its first poll and the background
  // poller skipped it forever. That is what broke instant meetings in production.
  it("ignores Graph's zero date and falls back to createdAt", () => {
    expect(
      giveUpAnchor({ scheduledEnd: new Date('0001-01-01T00:00:00Z'), createdAt: CREATED }),
    ).toBe(CREATED);
  });

  it('polls an instant meeting instead of abandoning it', () => {
    expect(
      isTeamsMeetingDue(
        row({ scheduledEnd: new Date('0001-01-01T00:00:00Z'), createdAt: new Date(ms - 60_000) }),
        now,
      ),
    ).toBe(true);
  });

  it('still gives up on an instant meeting once its own window has passed', () => {
    expect(
      isTeamsMeetingDue(
        row({
          scheduledEnd: new Date('0001-01-01T00:00:00Z'),
          createdAt: new Date(ms - POLL_GIVE_UP_MS - 1000),
        }),
        now,
      ),
    ).toBe(false);
  });

  it('is not due before the meeting ends', () => {
    expect(isTeamsMeetingDue(row({ scheduledEnd: new Date(ms + 60_000) }), now)).toBe(false);
  });

  it('is not due in another state', () => {
    expect(isTeamsMeetingDue(row({ state: 'ready' }), now)).toBe(false);
    expect(isTeamsMeetingDue(row({ state: 'failed' }), now)).toBe(false);
  });

  it('respects the fast backoff', () => {
    const base = { scheduledEnd: new Date(ms - 3_600_000), attempts: 2 };
    expect(isTeamsMeetingDue(row({ ...base, lastPolledAt: new Date(ms - 60_000) }), now)).toBe(
      false,
    );
    expect(isTeamsMeetingDue(row({ ...base, lastPolledAt: new Date(ms - 180_000) }), now)).toBe(
      true,
    );
  });

  it('respects the slow backoff after 15 attempts', () => {
    const base = { scheduledEnd: new Date(ms - 3_600_000), attempts: 20 };
    expect(isTeamsMeetingDue(row({ ...base, lastPolledAt: new Date(ms - 300_000) }), now)).toBe(
      false,
    );
    expect(
      isTeamsMeetingDue(row({ ...base, lastPolledAt: new Date(ms - 16 * 60_000) }), now),
    ).toBe(true);
  });

  it('gives up 24 hours after the scheduled end', () => {
    expect(
      isTeamsMeetingDue(row({ scheduledEnd: new Date(ms - POLL_GIVE_UP_MS - 1000) }), now),
    ).toBe(false);
    expect(
      isTeamsMeetingDue(row({ scheduledEnd: new Date(ms - POLL_GIVE_UP_MS + 1000) }), now),
    ).toBe(true);
  });
});

describe('upsertTeamsMeeting', () => {
  it('inserts with defaults and maps the returned row', async () => {
    mockQueryOne.mockResolvedValue(RAW as never);

    const result = await upsertTeamsMeeting(USER, {
      id: 'm1',
      graphMeetingId: 'GRAPH1',
      joinUrl: 'https://teams.microsoft.com/l/meetup-join/x',
      subject: 'Bestyrelsesmøde',
      organizerId: 'org-1',
      isOrganizer: true,
      armed: true,
      scheduledStart: new Date('2026-09-08T09:00:00Z'),
      scheduledEnd: new Date('2026-09-08T10:00:00Z'),
    });

    const [userId, sql, params] = mockQueryOne.mock.calls[0];
    expect(userId).toBe(USER);
    expect(sql).toMatch(/INSERT INTO teams_meetings/);
    expect(sql).toMatch(/ON CONFLICT \(id\) DO UPDATE SET/);
    expect(sql).toMatch(/COALESCE\(\$12::text, 'awaiting_teams'\)/);
    expect(params).toEqual([
      'm1',
      'GRAPH1',
      null,
      'https://teams.microsoft.com/l/meetup-join/x',
      'Bestyrelsesmøde',
      'org-1',
      true,
      true,
      null,
      new Date('2026-09-08T09:00:00Z'),
      new Date('2026-09-08T10:00:00Z'),
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);

    expect(result).toEqual({
      id: 'm1',
      graphMeetingId: 'GRAPH1',
      eventId: null,
      joinUrl: 'https://teams.microsoft.com/l/meetup-join/x',
      subject: 'Bestyrelsesmøde',
      organizerId: 'org-1',
      isOrganizer: true,
      armed: true,
      armResult: 'armed',
      scheduledStart: new Date('2026-09-08T09:00:00Z'),
      scheduledEnd: new Date('2026-09-08T10:00:00Z'),
      state: 'awaiting_teams',
      lastPolledAt: null,
      attempts: 3,
      failureReason: null,
      transcriptId: null,
      recordingId: null,
      originalOptions: null,
      createdAt: CREATED,
    });
  });

  it('passes through explicitly supplied poller fields', async () => {
    mockQueryOne.mockResolvedValue({ ...RAW, state: 'ready' } as never);

    await upsertTeamsMeeting(USER, {
      ...row({ state: 'ready', attempts: 7, transcriptId: 'T1' }),
    });

    const params = mockQueryOne.mock.calls[0][2] as unknown[];
    expect(params[11]).toBe('ready');
    expect(params[13]).toBe(7);
    expect(params[15]).toBe('T1');
  });

  it('stores the occurrence and the arm outcome', async () => {
    // policy_blocked used to be thrown away after the POST response, so a
    // reload told a blocked organizer they were "not the organizer".
    mockQueryOne.mockResolvedValue({ ...RAW, arm_result: 'policy_blocked', event_id: 'evt-2' } as never);

    const result = await upsertTeamsMeeting(USER, {
      ...row({ eventId: 'evt-2', armResult: 'policy_blocked' }),
    });

    const params = mockQueryOne.mock.calls[0][2] as unknown[];
    expect(params[2]).toBe('evt-2');
    expect(params[8]).toBe('policy_blocked');
    expect(result.armResult).toBe('policy_blocked');
    expect(result.eventId).toBe('evt-2');
  });

  it('stores the options as they were before arming as JSON, and keeps an earlier snapshot when none is supplied', async () => {
    const original = {
      allowRecording: false,
      allowTranscription: false,
      recordAutomatically: false,
      meetingSpokenLanguageTag: 'en-GB',
    };
    mockQueryOne.mockResolvedValue({ ...RAW, original_options: original } as never);

    const result = await upsertTeamsMeeting(USER, { ...row(), originalOptions: original });

    const [, sql, params] = mockQueryOne.mock.calls[0] as [string, string, unknown[]];
    expect(params[17]).toBe(JSON.stringify(original));
    // Re-registering an armed meeting reads the ALREADY armed values; the first
    // snapshot must survive it, even against a later non-null one (two registrations
    // racing, or a second local id for the same Graph meeting), so the stored value comes first.
    expect(sql).toMatch(/original_options\s*=\s*COALESCE\(teams_meetings\.original_options, \$18::jsonb\)/);
    expect(result.originalOptions).toEqual(original);
  });

  it('passes null when no snapshot is supplied', async () => {
    mockQueryOne.mockResolvedValue(RAW as never);
    await upsertTeamsMeeting(USER, row());
    expect((mockQueryOne.mock.calls[0][2] as unknown[])[17]).toBeNull();
  });

  it('coerces string timestamps and numeric strings from the driver', async () => {
    mockQueryOne.mockResolvedValue({
      ...RAW,
      scheduled_start: '2026-09-08T09:00:00Z',
      last_polled_at: '2026-09-08T11:00:00Z',
      attempts: '4',
      is_organizer: false,
    } as never);

    const result = await upsertTeamsMeeting(USER, row());
    expect(result.scheduledStart).toEqual(new Date('2026-09-08T09:00:00Z'));
    expect(result.lastPolledAt).toEqual(new Date('2026-09-08T11:00:00Z'));
    expect(result.attempts).toBe(4);
    expect(result.isOrganizer).toBe(false);
  });

  it('throws if the upsert returns nothing', async () => {
    mockQueryOne.mockResolvedValue(null);
    await expect(upsertTeamsMeeting(USER, row())).rejects.toThrow(/no row/);
  });
});

describe('reads', () => {
  it('getTeamsMeeting selects by id and returns null when missing', async () => {
    expect(await getTeamsMeeting(USER, 'm1')).toBeNull();
    const [, sql, params] = mockQueryOne.mock.calls[0];
    expect(sql).toMatch(/FROM teams_meetings\s+WHERE id = \$1/);
    expect(params).toEqual(['m1']);
  });

  it('getTeamsMeeting maps a found row', async () => {
    mockQueryOne.mockResolvedValue(RAW as never);
    const found = await getTeamsMeeting(USER, 'm1');
    expect(found?.graphMeetingId).toBe('GRAPH1');
    expect(found?.attempts).toBe(3);
  });

  it('getTeamsMeetingByGraphId selects the newest row for a graph id', async () => {
    mockQueryOne.mockResolvedValue(RAW as never);
    const found = await getTeamsMeetingByGraphId(USER, 'GRAPH1');
    const [, sql, params] = mockQueryOne.mock.calls[0];
    expect(sql).toMatch(/WHERE graph_meeting_id = \$1/);
    expect(sql).toMatch(/ORDER BY created_at DESC/);
    expect(params).toEqual(['GRAPH1']);
    expect(found?.id).toBe('m1');
  });

  it('listTeamsMeetings maps every row', async () => {
    mockQuery.mockResolvedValue([RAW, { ...RAW, id: 'm2' }] as never);
    const rows = await listTeamsMeetings(USER);
    expect(rows.map((r) => r.id)).toEqual(['m1', 'm2']);
    expect(mockQuery.mock.calls[0][1]).toMatch(/ORDER BY created_at DESC/);
  });
});

describe('listDueTeamsMeetings', () => {
  it('filters on state, schedule, give-up window and backoff', async () => {
    const now = new Date('2026-09-08T12:00:00Z');
    mockQuery.mockResolvedValue([RAW] as never);

    const rows = await listDueTeamsMeetings(USER, now);

    const [, sql, params] = mockQuery.mock.calls[0];
    // Mirrors isTeamsMeetingDue: needs_reauth is retried, a stale fetching row is
    // rescued, and a row with no schedule is bounded by created_at.
    expect(sql).toMatch(/state IN \('awaiting_teams', 'needs_reauth'\)/);
    expect(sql).toMatch(/state = 'fetching'/);
    expect(sql).toMatch(/COALESCE\(scheduled_end, created_at\) <= \$1::timestamptz/);
    expect(sql).toMatch(/COALESCE\(scheduled_end, created_at\)\s*\n?\s*>= \$1::timestamptz -/);
    expect(sql).toMatch(/CASE WHEN attempts < \$3::int THEN \$4::int ELSE \$5::int END/);
    expect(params).toEqual([now, POLL_GIVE_UP_MS, 15, 120_000, 900_000, STALE_FETCHING_MS]);
    expect(rows).toHaveLength(1);
  });
});

describe('markPollAttempt', () => {
  it('bumps attempts and stamps last_polled_at with no patch', async () => {
    await markPollAttempt(USER, 'm1');
    const [, sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/attempts = attempts \+ 1/);
    expect(sql).toMatch(/last_polled_at = NOW\(\)/);
    expect(sql).toMatch(/WHERE id = \$1/);
    expect(sql).not.toMatch(/state =/);
    expect(params).toEqual(['m1']);
  });

  it('only writes the patched columns', async () => {
    await markPollAttempt(USER, 'm1', { state: 'fetching', transcriptId: 'T1' });
    const [, sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/state = \$2/);
    expect(sql).toMatch(/transcript_id = \$3/);
    expect(sql).not.toMatch(/failure_reason =/);
    expect(params).toEqual(['m1', 'fetching', 'T1']);
  });

  it('writes an explicit null to clear a column', async () => {
    await markPollAttempt(USER, 'm1', { failureReason: null });
    const [, sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/failure_reason = \$2/);
    expect(params).toEqual(['m1', null]);
  });
});

describe('setTeamsMeetingState', () => {
  it('sets state and clears the failure reason by default', async () => {
    await setTeamsMeetingState(USER, 'm1', 'ready');
    const [, sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/SET state = \$2, failure_reason = \$3/);
    expect(params).toEqual(['m1', 'ready', null]);
  });

  it('stores a failure reason', async () => {
    await setTeamsMeetingState(USER, 'm1', 'failed', 'Ingen transskription i Teams');
    expect(mockQuery.mock.calls[0][2]).toEqual([
      'm1',
      'failed',
      'Ingen transskription i Teams',
    ]);
  });
});

describe('deleteTeamsMeeting', () => {
  it('deletes by id', async () => {
    await deleteTeamsMeeting(USER, 'm1');
    const [, sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM teams_meetings WHERE id = \$1/);
    expect(params).toEqual(['m1']);
  });
});

describe('userIdFromSchemaName', () => {
  it('restores a uuid user id', () => {
    expect(userIdFromSchemaName('u_1e3f9a0b_2c4d_4e5f_8a9b_0c1d2e3f4a5b')).toBe(
      '1e3f9a0b-2c4d-4e5f-8a9b-0c1d2e3f4a5b',
    );
  });

  it('leaves a dashless id untouched', () => {
    expect(userIdFromSchemaName('u_abc123XYZ')).toBe('abc123XYZ');
  });

  it('ignores schemas that are not per-user', () => {
    expect(userIdFromSchemaName('public')).toBeNull();
    expect(userIdFromSchemaName('u_')).toBeNull();
  });
});

describe('listUserSchemaIds', () => {
  it('queries information_schema and inverts the schema names', async () => {
    mockPoolQuery.mockResolvedValue({
      rows: [
        { schema_name: 'u_1e3f9a0b_2c4d_4e5f_8a9b_0c1d2e3f4a5b' },
        { schema_name: 'u_abc123' },
      ],
    } as never);

    const ids = await listUserSchemaIds();

    expect(mockPoolQuery.mock.calls[0][0]).toMatch(/information_schema\.schemata/);
    expect(mockPoolQuery.mock.calls[0][0]).toContain("LIKE 'u\\_%'");
    expect(ids).toEqual(['1e3f9a0b-2c4d-4e5f-8a9b-0c1d2e3f4a5b', 'abc123']);
  });

  it('returns an empty list when there are no user schemas', async () => {
    expect(await listUserSchemaIds()).toEqual([]);
  });
});
