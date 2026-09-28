import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreateDbClient = vi.fn();
vi.mock('@/lib/db', () => ({ createDbClient: (...a: unknown[]) => mockCreateDbClient(...a), db: {} }));

import { meetingLockKey, withMeetingLock, MEETING_LOCK_NAMESPACE } from './meeting-lock';

function fakeClient(locked: boolean, connectImpl: () => Promise<void> = async () => {}) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked }] };
    return { rows: [] };
  });
  return { connect: vi.fn(connectImpl), query, end: vi.fn(async () => {}) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('withMeetingLock', () => {
  it('runs the work and releases the lock and the connection, on a standalone client outside the pool', async () => {
    const client = fakeClient(true);
    mockCreateDbClient.mockReturnValue(client);

    const result = await withMeetingLock('u1:m1', async () => 'done', () => 'busy');

    expect(result).toBe('done');
    expect(client.connect).toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith('SELECT pg_try_advisory_lock($1, $2) AS locked', [
      MEETING_LOCK_NAMESPACE,
      meetingLockKey('u1:m1'),
    ]);
    expect(client.query).toHaveBeenCalledWith('SELECT pg_advisory_unlock($1, $2)', [
      MEETING_LOCK_NAMESPACE,
      meetingLockKey('u1:m1'),
    ]);
    expect(client.end).toHaveBeenCalled();
  });

  it('does not run the work when another run holds the lock', async () => {
    // The "Tjek nu" route and the background poller both reach the pipeline; two
    // concurrent runs would download the same recording twice and delete each
    // other's scratch files mid-transcode.
    mockCreateDbClient.mockReturnValue(fakeClient(false));
    const work = vi.fn();

    expect(await withMeetingLock('u1:m1', work, () => 'busy')).toBe('busy');
    expect(work).not.toHaveBeenCalled();
  });

  it('releases the lock even when the work throws', async () => {
    const client = fakeClient(true);
    mockCreateDbClient.mockReturnValue(client);

    await expect(
      withMeetingLock('u1:m1', async () => { throw new Error('boom'); }, () => 'busy'),
    ).rejects.toThrow('boom');

    expect(client.query).toHaveBeenCalledWith('SELECT pg_advisory_unlock($1, $2)', expect.anything());
    expect(client.end).toHaveBeenCalled();
  });

  it('fails open when Postgres is unreachable', async () => {
    // A duplicated download beats a meeting that never produces a referat.
    mockCreateDbClient.mockReturnValue(
      fakeClient(true, async () => {
        throw new Error('no connection');
      }),
    );
    expect(await withMeetingLock('u1:m1', async () => 'done', () => 'busy')).toBe('done');
  });

  it('gives different meetings different keys, and the same meeting a stable one', () => {
    expect(meetingLockKey('u1:m1')).toBe(meetingLockKey('u1:m1'));
    expect(meetingLockKey('u1:m1')).not.toBe(meetingLockKey('u1:m2'));
    expect(meetingLockKey('u1:m1')).not.toBe(meetingLockKey('u2:m1'));
    // Must fit a Postgres int4.
    expect(Number.isInteger(meetingLockKey('u1:m1'))).toBe(true);
    expect(Math.abs(meetingLockKey('u1:m1'))).toBeLessThanOrEqual(2 ** 31);
  });
});
