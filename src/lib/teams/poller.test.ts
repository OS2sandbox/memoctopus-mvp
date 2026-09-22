import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockConnect = vi.fn();
vi.mock('@/lib/db', () => ({ pool: { connect: (...a: unknown[]) => mockConnect(...a) }, db: {} }));

// graph-client (for GraphError) pulls in better-auth, which needs a real DB.
vi.mock('@/lib/auth', () => ({ auth: { api: {} } }));

vi.mock('./pipeline', () => ({ processTeamsMeeting: vi.fn() }));

const mockQuery = vi.fn();
vi.mock('@/lib/db/user-schema', () => ({
  queryUserSchema: (...a: unknown[]) => mockQuery(...a),
}));

vi.mock('./store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./store')>();
  return {
    ...actual,
    getTeamsMeeting: vi.fn(),
    listDueTeamsMeetings: vi.fn(),
    listUserSchemaIds: vi.fn(),
    markPollAttempt: vi.fn().mockResolvedValue(undefined),
    setTeamsMeetingState: vi.fn().mockResolvedValue(undefined),
  };
});

import {
  GIVE_UP_MESSAGE,
  POLL_LOCK_KEY,
  TRANSCRIPTS_DISABLED_MESSAGE,
  pollDueMeetings,
  pollMeeting,
  startPoller,
} from './poller';
import { GraphError } from './graph-client';
import { processTeamsMeeting } from './pipeline';
import {
  POLL_GIVE_UP_MS,
  getTeamsMeeting,
  listDueTeamsMeetings,
  listUserSchemaIds,
  markPollAttempt,
  setTeamsMeetingState,
  type TeamsMeetingRow,
} from './store';

const mockProcess = vi.mocked(processTeamsMeeting);
const mockGet = vi.mocked(getTeamsMeeting);
const mockListDue = vi.mocked(listDueTeamsMeetings);
const mockListUsers = vi.mocked(listUserSchemaIds);
const mockMark = vi.mocked(markPollAttempt);
const mockSetState = vi.mocked(setTeamsMeetingState);

const NOW = new Date('2026-09-08T12:00:00Z');

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

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TEAMS_GRAPH_ENABLED = 'true';
  mockMark.mockResolvedValue(row());
  mockQuery.mockResolvedValue([]);
  mockSetState.mockResolvedValue(row());
});

afterEach(() => {
  delete process.env.TEAMS_GRAPH_ENABLED;
});

/**
 * A poll recorded with `incrementAttempts: false` — `attempts` is left alone,
 * but `last_polled_at` is still stamped by markPollAttempt so the backoff
 * keeps working.
 */
function expectNoAttemptPoll(state: string, failureReason: string | null) {
  expect(mockMark).toHaveBeenCalledWith('u1', 'm1', { state, failureReason }, { incrementAttempts: false });
}

describe('pollMeeting', () => {
  it('leaves the row alone and never touches Graph while TEAMS_GRAPH_ENABLED is off', async () => {
    // Without the scopes every poll would fail as reauth_required and park the
    // row in needs_reauth, asking for a sign-in that cannot help.
    delete process.env.TEAMS_GRAPH_ENABLED;
    const r = row();
    mockGet.mockResolvedValue(r);

    expect(await pollMeeting('u1', 'm1', NOW)).toBe(r);
    expect(await pollMeeting('u1', 'm1', NOW, { force: true })).toBe(r);

    expect(mockProcess).not.toHaveBeenCalled();
    expect(mockMark).not.toHaveBeenCalled();
    expect(mockSetState).not.toHaveBeenCalled();
  });

  it('throws when the row does not exist (caller owns the row)', async () => {
    mockGet.mockResolvedValueOnce(null);
    await expect(pollMeeting('u1', 'nope', NOW)).rejects.toThrow(/not found/i);
  });

  it('is a no-op while the meeting has not ended yet', async () => {
    const r = row({ scheduledEnd: new Date('2026-09-08T13:00:00Z') });
    mockGet.mockResolvedValueOnce(r);

    const result = await pollMeeting('u1', 'm1', NOW);

    expect(result).toBe(r);
    expect(mockProcess).not.toHaveBeenCalled();
    expect(mockMark).not.toHaveBeenCalled();
    expect(mockSetState).not.toHaveBeenCalled();
  });

  it('is a no-op for a terminal state', async () => {
    const r = row({ state: 'ready' });
    mockGet.mockResolvedValueOnce(r);
    expect(await pollMeeting('u1', 'm1', NOW)).toBe(r);
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it('still polls a needs_reauth row (the user may have signed in again)', async () => {
    mockGet.mockResolvedValue(row({ state: 'needs_reauth' }));
    mockProcess.mockResolvedValueOnce({ status: 'pending' });
    await pollMeeting('u1', 'm1', NOW);
    expect(mockProcess).toHaveBeenCalled();
  });

  it('gives up 24h after creation when the meeting has no schedule', async () => {
    // An ad-hoc meeting Graph gave us no window for used to poll Graph forever.
    mockGet.mockResolvedValue(
      row({ scheduledEnd: null, createdAt: new Date(NOW.getTime() - POLL_GIVE_UP_MS - 1000) }),
    );

    await pollMeeting('u1', 'm1', NOW);

    expect(mockProcess).not.toHaveBeenCalled();
    expect(mockMark).toHaveBeenCalledWith('u1', 'm1', {
      state: 'failed',
      failureReason: GIVE_UP_MESSAGE,
    });
  });

  it('revives a failed row when the user presses "Prøv igen"', async () => {
    // `failed` is terminal, so without force the retry button never reaches Graph.
    mockGet
      .mockResolvedValueOnce(row({ state: 'failed', failureReason: 'Ingen lyd' }))
      .mockResolvedValue(row({ state: 'awaiting_teams' }));
    mockProcess.mockResolvedValueOnce({ status: 'pending' });

    await pollMeeting('u1', 'm1', NOW, { force: true });

    expect(mockSetState).toHaveBeenCalledWith('u1', 'm1', 'awaiting_teams', null);
    expect(mockProcess).toHaveBeenCalled();
  });

  it('does not revive a failed row that is past the give-up window', async () => {
    mockGet.mockResolvedValue(
      row({ state: 'failed', scheduledEnd: new Date(NOW.getTime() - POLL_GIVE_UP_MS - 1000) }),
    );

    const result = await pollMeeting('u1', 'm1', NOW, { force: true });

    expect(result.state).toBe('failed');
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it('leaves a failed row alone without force', async () => {
    mockGet.mockResolvedValue(row({ state: 'failed' }));
    await pollMeeting('u1', 'm1', NOW);
    expect(mockSetState).not.toHaveBeenCalled();
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it('gives up 24h after the scheduled end', async () => {
    const end = new Date(NOW.getTime() - POLL_GIVE_UP_MS - 1000);
    mockGet.mockResolvedValue(row({ scheduledEnd: end }));

    await pollMeeting('u1', 'm1', NOW);

    expect(mockProcess).not.toHaveBeenCalled();
    expect(mockMark).toHaveBeenCalledWith('u1', 'm1', {
      state: 'failed',
      failureReason: GIVE_UP_MESSAGE,
    });
  });

  it('sets fetching, then ready with the artifact ids', async () => {
    mockGet.mockResolvedValue(row());
    mockProcess.mockResolvedValueOnce({
      status: 'ready',
      mode: 'recording+transcript',
      speakers: ['Mette Hansen'],
      transcriptId: 't1',
      recordingId: 'r1',
    });

    await pollMeeting('u1', 'm1', NOW);

    expect(mockSetState).toHaveBeenCalledWith('u1', 'm1', 'fetching');
    expect(mockProcess).toHaveBeenCalledWith(
      'u1',
      {
        id: 'm1',
        graphMeetingId: 'graph-1',
        scheduledStart: new Date('2026-09-08T10:00:00Z'),
        scheduledEnd: new Date('2026-09-08T11:00:00Z'),
        attempts: 0,
      },
      NOW,
    );
    expect(mockMark).toHaveBeenCalledWith('u1', 'm1', {
      state: 'ready',
      failureReason: null,
      transcriptId: 't1',
      recordingId: 'r1',
    });
  });

  it('returns to awaiting_teams when nothing has arrived yet', async () => {
    mockGet.mockResolvedValue(row());
    mockProcess.mockResolvedValueOnce({ status: 'pending' });

    await pollMeeting('u1', 'm1', NOW);

    expect(mockMark).toHaveBeenCalledWith(
      'u1',
      'm1',
      { state: 'awaiting_teams', failureReason: null },
      { incrementAttempts: true },
    );
  });

  it('records a pipeline failure', async () => {
    mockGet.mockResolvedValue(row());
    mockProcess.mockResolvedValueOnce({ status: 'failed', reason: 'Ingen lyd' });

    await pollMeeting('u1', 'm1', NOW);

    expect(mockMark).toHaveBeenCalledWith('u1', 'm1', {
      state: 'failed',
      failureReason: 'Ingen lyd',
    });
  });

  it('keeps waiting when Graph throttles or is unavailable', async () => {
    // 429/5xx are routine on /onlineMeetings/*/transcripts; failing the meeting
    // for one of them means the user never gets a referat and cannot retry.
    const errors = [
      new GraphError('unavailable', 'Microsoft Graph svarede 429', { status: 429 }),
      new GraphError('unavailable', 'Microsoft Graph svarede 503', { status: 503 }),
      new GraphError('unavailable', 'Microsoft svarede ikke i tide.'),
    ];
    for (const err of errors) {
      vi.clearAllMocks();
      mockGet.mockResolvedValue(row());
      mockQuery.mockResolvedValue([]);
      mockProcess.mockRejectedValueOnce(err);

      await pollMeeting('u1', 'm1', NOW);

      expectNoAttemptPoll('awaiting_teams', err.message);
    }
  });

  it('does not count a throttled poll toward the attempts that end the recording grace', async () => {
    mockGet.mockResolvedValue(row({ attempts: 14 }));
    mockProcess.mockResolvedValueOnce({ status: 'pending', transient: true });

    await pollMeeting('u1', 'm1', NOW);

    // Still 14: markPollAttempt is the only writer that adds one.
    expectNoAttemptPoll('awaiting_teams', null);
  });

  it('still counts an ordinary "nothing yet" poll', async () => {
    mockGet.mockResolvedValue(row({ attempts: 14 }));
    mockProcess.mockResolvedValueOnce({ status: 'pending' });

    await pollMeeting('u1', 'm1', NOW);

    expect(mockMark).toHaveBeenCalledWith(
      'u1',
      'm1',
      { state: 'awaiting_teams', failureReason: null },
      { incrementAttempts: true },
    );
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('does not count a forced poll ("Tjek nu") that finds nothing yet', async () => {
    mockGet.mockResolvedValue(row());
    mockProcess.mockResolvedValueOnce({ status: 'pending' });

    await pollMeeting('u1', 'm1', NOW, { force: true });

    expectNoAttemptPoll('awaiting_teams', null);
  });

  it('does not count a forced poll that needs a new sign-in', async () => {
    mockGet.mockResolvedValue(row());
    mockProcess.mockRejectedValueOnce(new GraphError('reauth_required', 'Log ind igen.'));

    await pollMeeting('u1', 'm1', NOW, { force: true });

    expectNoAttemptPoll('needs_reauth', 'Log ind igen.');
  });

  it('records the outcome of a forced poll that finishes the meeting as usual', async () => {
    mockGet.mockResolvedValue(row());
    mockProcess.mockResolvedValueOnce({
      status: 'ready',
      mode: 'transcript-only',
      speakers: [],
      transcriptId: 't1',
      recordingId: null,
    });

    await pollMeeting('u1', 'm1', NOW, { force: true });

    expect(mockMark).toHaveBeenCalledWith('u1', 'm1', expect.objectContaining({ state: 'ready' }));
  });

  it('maps reauth_required to needs_reauth', async () => {
    mockGet.mockResolvedValue(row());
    mockProcess.mockRejectedValueOnce(new GraphError('reauth_required', 'Log ind igen.'));

    await pollMeeting('u1', 'm1', NOW);

    expect(mockMark).toHaveBeenCalledWith(
      'u1',
      'm1',
      { state: 'needs_reauth', failureReason: 'Log ind igen.' },
      { incrementAttempts: true },
    );
  });

  it('maps transcripts_disabled to failed with the admin-guide message', async () => {
    mockGet.mockResolvedValue(row());
    mockProcess.mockRejectedValueOnce(new GraphError('transcripts_disabled', 'nej'));

    await pollMeeting('u1', 'm1', NOW);

    expect(mockMark).toHaveBeenCalledWith('u1', 'm1', {
      state: 'failed',
      failureReason: TRANSCRIPTS_DISABLED_MESSAGE,
    });
    expect(TRANSCRIPTS_DISABLED_MESSAGE).toContain('docs/setup-microsoft-teams.md');
  });

  it('keeps waiting after an unexpected (non-Graph) error', async () => {
    mockGet.mockResolvedValue(row());
    mockProcess.mockRejectedValueOnce(new Error('socket hang up'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(pollMeeting('u1', 'm1', NOW)).resolves.toBeTruthy();

    expect(mockMark).toHaveBeenCalledWith(
      'u1',
      'm1',
      { state: 'awaiting_teams', failureReason: 'socket hang up' },
      { incrementAttempts: true },
    );
    spy.mockRestore();
  });

  it('returns the row markPollAttempt just wrote, via RETURNING, without a re-SELECT', async () => {
    const after = row({ state: 'ready' });
    mockGet.mockResolvedValueOnce(row());
    mockMark.mockResolvedValueOnce(after);
    mockProcess.mockResolvedValueOnce({
      status: 'ready', mode: 'transcript-only', speakers: [], transcriptId: null, recordingId: null,
    });

    expect(await pollMeeting('u1', 'm1', NOW)).toBe(after);
    // getTeamsMeeting is called once, to load the row at the top — never again.
    expect(mockGet).toHaveBeenCalledTimes(1);
  });
});

describe('pollDueMeetings', () => {
  it('does not even take the lock while TEAMS_GRAPH_ENABLED is off', async () => {
    delete process.env.TEAMS_GRAPH_ENABLED;
    expect(await pollDueMeetings(NOW)).toEqual({ polled: 0 });
    expect(mockConnect).not.toHaveBeenCalled();
  });

  function client(locked: boolean) {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked }] };
      return { rows: [] };
    });
    return { query, release: vi.fn() };
  }

  it('skips the run when another instance holds the advisory lock', async () => {
    const c = client(false);
    mockConnect.mockResolvedValueOnce(c);

    expect(await pollDueMeetings(NOW)).toEqual({ polled: 0 });
    expect(mockListUsers).not.toHaveBeenCalled();
    expect(c.query).toHaveBeenCalledWith('SELECT pg_try_advisory_lock($1) AS locked', [
      POLL_LOCK_KEY,
    ]);
    expect(c.release).toHaveBeenCalled();
  });

  it('polls every due meeting of every user and releases the lock', async () => {
    const c = client(true);
    mockConnect.mockResolvedValueOnce(c);
    mockListUsers.mockResolvedValueOnce(['u1', 'u2']);
    mockListDue.mockImplementation(async (userId: string) =>
      userId === 'u1' ? [row({ id: 'a' }), row({ id: 'b' })] : [row({ id: 'c' })],
    );
    mockGet.mockImplementation(async (_u: string, id: string) => row({ id }));
    mockProcess.mockResolvedValue({ status: 'pending' });

    expect(await pollDueMeetings(NOW)).toEqual({ polled: 3 });
    expect(c.query).toHaveBeenCalledWith('SELECT pg_advisory_unlock($1)', [POLL_LOCK_KEY]);
    expect(c.release).toHaveBeenCalled();
  });

  it('keeps going when one user fails', async () => {
    const c = client(true);
    mockConnect.mockResolvedValueOnce(c);
    mockListUsers.mockResolvedValueOnce(['u1', 'u2']);
    mockListDue.mockImplementation(async (userId: string) => {
      if (userId === 'u1') throw new Error('schema gone');
      return [row({ id: 'c' })];
    });
    mockGet.mockImplementation(async (_u: string, id: string) => row({ id }));
    mockProcess.mockResolvedValue({ status: 'pending' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await pollDueMeetings(NOW)).toEqual({ polled: 1 });
    spy.mockRestore();
  });

  it('returns 0 rather than throwing when the pool is unavailable', async () => {
    mockConnect.mockRejectedValueOnce(new Error('no db'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await pollDueMeetings(NOW)).toEqual({ polled: 0 });
    spy.mockRestore();
  });
});

describe('startPoller', () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('does nothing in the test environment', () => {
    const spy = vi.spyOn(global, 'setInterval');
    const stop = startPoller();
    expect(spy).not.toHaveBeenCalled();
    stop();
    spy.mockRestore();
  });

  it('does nothing when TEAMS_POLLER_DISABLED is true', () => {
    process.env.TEAMS_POLLER_DISABLED = 'true';
    const spy = vi.spyOn(global, 'setInterval');
    startPoller()();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('does nothing while TEAMS_GRAPH_ENABLED is off, even outside the test environment', () => {
    delete process.env.TEAMS_GRAPH_ENABLED;
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'production');
    const spy = vi.spyOn(global, 'setInterval');
    startPoller()();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('runs on the configured interval and stops when told to', async () => {
    vi.useFakeTimers();
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TEAMS_POLL_INTERVAL_MS', '1000');

    const c = { query: vi.fn().mockResolvedValue({ rows: [{ locked: false }] }), release: vi.fn() };
    mockConnect.mockResolvedValue(c);

    const stop = startPoller();
    await vi.advanceTimersByTimeAsync(2500);
    expect(mockConnect).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockConnect).toHaveBeenCalledTimes(2);
  });
});
