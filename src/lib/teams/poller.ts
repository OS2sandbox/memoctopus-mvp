import type { PoolClient } from 'pg';
import { pool } from '@/lib/db';
import { teamsGraphEnabled } from '@/lib/auth/providers';
import { queryUserSchema } from '@/lib/db/user-schema';
import { GraphError } from './graph-client';
import { processTeamsMeeting } from './pipeline';
import {
  POLL_GIVE_UP_MS,
  giveUpAnchor,
  getTeamsMeeting,
  listDueTeamsMeetings,
  listUserSchemaIds,
  markPollAttempt,
  setTeamsMeetingState,
  type TeamsMeetingRow,
  type TeamsMeetingState,
} from './store';

/**
 * The background half of the Teams integration: after a meeting's scheduled end
 * we ask Graph for its transcript/recording until they show up (or we give up).
 *
 * Everything here is failure-tolerant by design — a poll that throws would
 * otherwise take down the interval for every user.
 */

/** Plan mode 4: nothing ever arrived. */
export const GIVE_UP_MESSAGE =
  'Ingen transskription blev fundet. Transskription blev muligvis ikke startet i Teams.';

export const TRANSCRIPTS_DISABLED_MESSAGE =
  'Teams-administratoren har slået Graph-adgang til transskriptioner fra. ' +
  'Se docs/setup-microsoft-teams.md trin 3.';

const DEFAULT_POLL_INTERVAL_MS = 120_000;

/** Constant key for pg_try_advisory_lock, so only one instance polls at a time. */
export const POLL_LOCK_KEY = 728_411_903;

/** Users polled in parallel; each user's own meetings are polled in sequence. */
const USER_CONCURRENCY = 3;

/** States that will never change again on their own. */
function isTerminal(state: TeamsMeetingRow['state']): boolean {
  return state === 'ready' || state === 'failed';
}

/**
 * `markPollAttempt` without the `attempts = attempts + 1`. That counter is what
 * ends the wait for a recording (RECORDING_GRACE_ATTEMPTS) and moves a meeting
 * from the 2-minute to the 15-minute backoff, so it has to count polls that
 * actually asked Teams something — not a throttle, an outage, or a user pressing
 * "Tjek nu". `last_polled_at` is still stamped, or a throttled meeting would be
 * due again on the very next tick. (Local rather than in store.ts, which this
 * change leaves alone; it belongs there as an option on markPollAttempt.)
 */
async function markPollWithoutAttempt(
  userId: string,
  id: string,
  state: TeamsMeetingState,
  failureReason: string | null,
): Promise<void> {
  await queryUserSchema(
    userId,
    `UPDATE teams_meetings
        SET state = $2, failure_reason = $3, last_polled_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [id, state, failureReason],
  );
}

export interface PollOptions {
  /**
   * The user pressed "Prøv igen": a `failed` row is put back into
   * `awaiting_teams` and re-run, instead of being treated as settled. Without
   * this the retry button is inert — `failed` is terminal, so no Graph call is
   * ever made and the same failure is shown forever.
   */
  force?: boolean;
}

/**
 * Polls one meeting. Never throws for a Graph/pipeline failure — the outcome is
 * written to the row instead. (It does throw if `id` is not a row of `userId`,
 * which is a programming error: callers own the row.)
 */
export async function pollMeeting(
  userId: string,
  id: string,
  now: Date,
  options: PollOptions = {},
): Promise<TeamsMeetingRow> {
  let row = await getTeamsMeeting(userId, id);
  if (!row) throw new Error(`Teams meeting not found: ${id}`);

  // The Graph scopes were never requested, so a poll can only fail — as
  // reauth_required, which would park the row in needs_reauth and ask for a
  // sign-in that cannot help. Leave the row as it is; it resumes if the flag is
  // switched on later.
  if (!teamsGraphEnabled()) return row;

  // The give-up window is measured from the scheduled end, or — for an ad-hoc
  // meeting Graph gave us no window for — from when we were asked to watch it.
  // Without the fallback such a row polls Graph forever and never gives up.
  const anchor = giveUpAnchor(row);
  const gaveUp = anchor != null && anchor.getTime() < now.getTime() - POLL_GIVE_UP_MS;

  if (options.force && row.state === 'failed' && !gaveUp) {
    await setTeamsMeetingState(userId, id, 'awaiting_teams', null);
    row = (await getTeamsMeeting(userId, id)) ?? { ...row, state: 'awaiting_teams', failureReason: null };
  }

  // Already settled, or the meeting has not happened yet: do not touch Graph
  // and do not burn an attempt.
  if (isTerminal(row.state)) return row;
  if (anchor && anchor.getTime() > now.getTime()) return row;

  if (gaveUp) {
    await markPollAttempt(userId, id, { state: 'failed', failureReason: GIVE_UP_MESSAGE });
    return (await getTeamsMeeting(userId, id)) ?? row;
  }

  await setTeamsMeetingState(userId, id, 'fetching');

  // Writes a poll that leaves the meeting waiting (or asks for a new sign-in).
  // It counts as an attempt unless Graph was merely throttled or unreachable
  // (`transient`) or the user forced it: neither says anything about how long
  // Teams has had to publish.
  const waiting = (
    state: TeamsMeetingState,
    failureReason: string | null,
    transient = false,
  ): Promise<void> =>
    transient || options.force
      ? markPollWithoutAttempt(userId, id, state, failureReason)
      : markPollAttempt(userId, id, { state, failureReason });

  try {
    const outcome = await processTeamsMeeting(
      userId,
      {
        id: row.id,
        graphMeetingId: row.graphMeetingId,
        scheduledStart: row.scheduledStart,
        scheduledEnd: row.scheduledEnd,
        attempts: row.attempts,
      },
      now,
    );

    if (outcome.status === 'ready') {
      await markPollAttempt(userId, id, {
        state: 'ready',
        failureReason: null,
        transcriptId: outcome.transcriptId,
        recordingId: outcome.recordingId,
      });
    } else if (outcome.status === 'failed') {
      await markPollAttempt(userId, id, { state: 'failed', failureReason: outcome.reason });
    } else {
      // Nothing yet — back to waiting, and try again after the backoff.
      await waiting('awaiting_teams', null, outcome.transient);
    }
  } catch (err) {
    if (err instanceof GraphError && err.code === 'reauth_required') {
      await waiting('needs_reauth', err.message);
    } else if (err instanceof GraphError && err.retryable) {
      // Graph throttles /transcripts routinely; a 429, a 503 or a timeout is "not yet".
      await waiting('awaiting_teams', err.message, true);
    } else if (err instanceof GraphError && err.code === 'transcripts_disabled') {
      await markPollAttempt(userId, id, {
        state: 'failed',
        failureReason: TRANSCRIPTS_DISABLED_MESSAGE,
      });
    } else if (err instanceof GraphError) {
      await markPollAttempt(userId, id, { state: 'failed', failureReason: err.message });
    } else {
      // A bug or a transient network error: keep waiting, record why.
      console.error('[teams/poller] unexpected error polling', id, err);
      const reason = err instanceof Error ? err.message : String(err);
      await waiting('awaiting_teams', reason);
    }
  }

  return (await getTeamsMeeting(userId, id)) ?? row;
}

async function pollUser(userId: string, now: Date): Promise<number> {
  let polled = 0;
  let due: TeamsMeetingRow[];
  try {
    due = await listDueTeamsMeetings(userId, now);
  } catch (err) {
    console.error('[teams/poller] could not list due meetings for', userId, err);
    return 0;
  }

  for (const row of due) {
    try {
      await pollMeeting(userId, row.id, now);
    } catch (err) {
      console.error('[teams/poller] poll failed for', userId, row.id, err);
    }
    polled += 1;
  }
  return polled;
}

/** Runs `workers` tasks at a time over `items`, in order. */
async function mapConcurrent<T>(
  items: T[],
  workers: number,
  fn: (item: T) => Promise<number>,
): Promise<number> {
  let index = 0;
  let total = 0;
  const run = async () => {
    for (;;) {
      const i = index++;
      if (i >= items.length) return;
      // Read-modify-write must happen after the await, or concurrent workers
      // clobber each other's increments.
      const n = await fn(items[i]);
      total += n;
    }
  };
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, run));
  return total;
}

/**
 * Polls every due meeting of every user. Guarded by a Postgres advisory lock so
 * that running several app instances does not mean polling Graph N times.
 */
export async function pollDueMeetings(now: Date): Promise<{ polled: number }> {
  if (!teamsGraphEnabled()) return { polled: 0 };

  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    console.error('[teams/poller] could not acquire a connection:', err);
    return { polled: 0 };
  }

  try {
    const locked = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [POLL_LOCK_KEY],
    );
    if (!locked.rows[0]?.locked) return { polled: 0 };

    try {
      const userIds = await listUserSchemaIds();
      const polled = await mapConcurrent(userIds, USER_CONCURRENCY, (userId) =>
        pollUser(userId, now),
      );
      return { polled };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [POLL_LOCK_KEY]);
    }
  } catch (err) {
    console.error('[teams/poller] run failed:', err);
    return { polled: 0 };
  } finally {
    client.release();
  }
}

function pollIntervalMs(): number {
  const raw = process.env.TEAMS_POLL_INTERVAL_MS?.trim() || undefined;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_POLL_INTERVAL_MS;
}

function pollerDisabled(): boolean {
  if (process.env.TEAMS_POLLER_DISABLED?.trim() === 'true') return true;
  if (process.env.NODE_ENV === 'test') return true;
  return Boolean(process.env.VITEST);
}

/**
 * Starts the interval. Returns a stop function; calling it twice is harmless.
 * Wired from `src/instrumentation.ts` on the nodejs runtime only.
 */
export function startPoller(): () => void {
  // Off unless the operator opted in: without the Graph scopes there is nothing
  // to collect, and the scan would only open a connection every interval.
  if (!teamsGraphEnabled()) {
    console.log('[teams/poller] TEAMS_GRAPH_ENABLED is not set, not starting');
    return () => {};
  }
  if (pollerDisabled()) {
    console.log('[teams/poller] disabled, not starting');
    return () => {};
  }
  console.log(`[teams/poller] started, polling Graph every ${pollIntervalMs()} ms`);

  let running = false;
  const timer = setInterval(async () => {
    if (running) return; // a slow run must not overlap with the next tick
    running = true;
    try {
      await pollDueMeetings(new Date());
    } catch (err) {
      console.error('[teams/poller] tick failed:', err);
    } finally {
      running = false;
    }
  }, pollIntervalMs());

  // Do not hold the process open for the sake of the timer.
  (timer as unknown as { unref?: () => void }).unref?.();

  return () => clearInterval(timer);
}
