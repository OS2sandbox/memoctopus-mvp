import { createDbClient } from '@/lib/db';

/**
 * Per-meeting mutual exclusion for the Graph pipeline.
 *
 * Two callers race for the same meeting: the background poller (guarded only by
 * one global advisory lock, so a second app instance is excluded but the same
 * instance's own routes are not) and `GET /api/teams/meetings/[id]?poll=1` —
 * the "Tjek nu" button plus the automatic forced poll the meeting screen fires
 * after the scheduled end. Both run `processTeamsMeeting`, whose stash guard is
 * check-then-act, so without this both would download the same hundreds-of-MB
 * recording into the same scratch files and delete each other's mid-transcode.
 *
 * A Postgres advisory lock is used rather than an in-process mutex because the
 * two callers can genuinely land on different app instances. It is session-
 * scoped — held (and later released) on the exact connection that took it, not
 * portable to another one — which is why this uses its own standalone
 * connection via {@link createDbClient} rather than one borrowed from `pool`:
 * `fn` can run for up to `GRAPH_DOWNLOAD_TIMEOUT_MS` (20 min), and holding a
 * pooled connection idle for that long would starve every other request of a
 * connection under concurrent Teams meetings.
 */

/** Namespace half of the two-int advisory key; the meeting hash is the other. */
export const MEETING_LOCK_NAMESPACE = 728_411_904;

/** FNV-1a, folded into a signed 32-bit int — the shape pg advisory keys want. */
export function meetingLockKey(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

/**
 * Runs `fn` while holding the lock for `key`. When the lock is already held,
 * `onBusy()` is returned instead and `fn` never runs.
 *
 * Fails open: if Postgres cannot be reached at all, the work still happens —
 * a duplicated download is better than a meeting that never produces a referat.
 */
export async function withMeetingLock<T>(
  key: string,
  fn: () => Promise<T>,
  onBusy: () => T,
): Promise<T> {
  const client = createDbClient();
  try {
    await client.connect();
  } catch (err) {
    console.error('[teams/meeting-lock] no connection, running unguarded:', err);
    return await fn();
  }

  const lockKey = meetingLockKey(key);
  try {
    const locked = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS locked',
      [MEETING_LOCK_NAMESPACE, lockKey],
    );
    if (!locked.rows[0]?.locked) return onBusy();

    try {
      return await fn();
    } finally {
      await client
        .query('SELECT pg_advisory_unlock($1, $2)', [MEETING_LOCK_NAMESPACE, lockKey])
        .catch((err) => console.error('[teams/meeting-lock] unlock failed:', err));
    }
  } finally {
    await client.end().catch((err) => console.error('[teams/meeting-lock] close failed:', err));
  }
}
