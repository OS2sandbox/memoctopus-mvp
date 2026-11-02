import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db', async () => (await import('@/test/pglite')).pgliteDbModule());

import { queryUserSchema } from '@/lib/db/user-schema';
import { usePgliteDb } from '@/test/pglite';
import {
  FAST_POLL_ATTEMPTS,
  OUTLOOK_UNOPENED_GIVE_UP_MS,
  POLL_GIVE_UP_MS,
  STALE_FETCHING_MS,
  getTeamsMeeting,
  listDueTeamsMeetings,
  listPendingRecordingCleanups,
  queueRecordingCleanup,
  upsertTeamsMeeting,
  type TeamsMeetingState,
} from './store';

// listDueTeamsMeetings decides which meetings the background poller ever looks
// at, so its SQL is run here against a real Postgres rather than mirrored in JS.

usePgliteDb();

const USER = 'user-1';
const NOW = new Date('2026-09-08T12:00:00Z');
const ms = NOW.getTime();
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

interface Fixture {
  id?: string;
  state?: TeamsMeetingState;
  scheduledEnd?: Date | null;
  createdAt?: Date;
  lastPolledAt?: Date | null;
  attempts?: number;
  origin?: 'outlook' | null;
  openedAt?: Date | null;
}

let seq = 0;

/** A row as the poller would find it: ended an hour ago, never polled, unless told otherwise. */
async function insert(f: Fixture = {}): Promise<string> {
  const id = f.id ?? `m${++seq}`;
  await queryUserSchema(
    USER,
    `INSERT INTO teams_meetings (
       id, graph_meeting_id, join_url, scheduled_end, state, last_polled_at,
       attempts, origin, opened_at, created_at
     ) VALUES ($1, 'graph-1', 'https://teams.microsoft.com/l/meetup-join/x',
               $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      f.scheduledEnd === undefined ? new Date(ms - 60 * MIN) : f.scheduledEnd,
      f.state ?? 'awaiting_teams',
      f.lastPolledAt ?? null,
      f.attempts ?? 0,
      f.origin ?? null,
      f.openedAt ?? null,
      f.createdAt ?? new Date(ms - 2 * 60 * MIN),
    ],
  );
  return id;
}

async function due(now: Date = NOW): Promise<string[]> {
  return (await listDueTeamsMeetings(USER, now)).map((r) => r.id);
}

describe('listDueTeamsMeetings', () => {
  it('lists a meeting that has ended and was never polled, mapped to a row', async () => {
    const id = await insert();
    const [row] = await listDueTeamsMeetings(USER, NOW);
    expect(row).toMatchObject({ id, state: 'awaiting_teams', attempts: 0, lastPolledAt: null });
    expect(row.scheduledEnd).toEqual(new Date(ms - 60 * MIN));
  });

  it('lists a meeting with no schedule, bounded by when it was registered', async () => {
    const id = await insert({ scheduledEnd: null, createdAt: new Date(ms - MIN) });
    await insert({ scheduledEnd: null, createdAt: new Date(ms + MIN) });
    expect(await due()).toEqual([id]);
  });

  it("treats Graph's year-1 zero date as no schedule, so an instant meeting is polled", async () => {
    const id = await insert({ scheduledEnd: new Date('0001-01-01T00:00:00Z'), createdAt: new Date(ms - MIN) });
    expect(await due()).toEqual([id]);
  });

  it('retries a meeting parked in needs_reauth', async () => {
    const id = await insert({ state: 'needs_reauth' });
    expect(await due()).toEqual([id]);
  });

  it('picks up a row abandoned mid-fetch, but not one that just started', async () => {
    await insert({ state: 'fetching', lastPolledAt: new Date(ms - MIN) });
    const stale = await insert({
      state: 'fetching',
      attempts: 20,
      lastPolledAt: new Date(ms - STALE_FETCHING_MS - 1000),
    });
    expect(await due()).toEqual([stale]);
  });

  it('leaves settled meetings alone', async () => {
    await insert({ state: 'ready' });
    await insert({ state: 'failed' });
    expect(await due()).toEqual([]);
  });

  it('is not due before the meeting ends', async () => {
    await insert({ scheduledEnd: new Date(ms + MIN) });
    expect(await due()).toEqual([]);
  });

  it('polls every 2 minutes for the first attempts', async () => {
    await insert({ attempts: FAST_POLL_ATTEMPTS - 1, lastPolledAt: new Date(ms - MIN) });
    const id = await insert({ attempts: FAST_POLL_ATTEMPTS - 1, lastPolledAt: new Date(ms - 3 * MIN) });
    expect(await due()).toEqual([id]);
  });

  it('backs off to 15 minutes afterwards', async () => {
    await insert({ attempts: FAST_POLL_ATTEMPTS, lastPolledAt: new Date(ms - 5 * MIN) });
    const id = await insert({ attempts: FAST_POLL_ATTEMPTS, lastPolledAt: new Date(ms - 16 * MIN) });
    expect(await due()).toEqual([id]);
  });

  // Giving up is a write pollMeeting makes, and it can only make it on a row it is
  // handed. Leaving rows past their window out of this list kept them in
  // awaiting_teams for good: every stuck row in production had been last polled
  // just inside its window, after ~100 attempts.
  it('keeps returning a polled row past its give-up window until it is settled', async () => {
    const past = { attempts: 101, lastPolledAt: new Date(ms - 60 * MIN) };
    const waiting = await insert({
      ...past,
      scheduledEnd: new Date(ms - POLL_GIVE_UP_MS - 1000),
      createdAt: new Date(ms - POLL_GIVE_UP_MS - 2000),
    });
    const reauth = await insert({
      ...past,
      state: 'needs_reauth',
      scheduledEnd: new Date(ms - POLL_GIVE_UP_MS - 1000),
      createdAt: new Date(ms - POLL_GIVE_UP_MS - 2000),
    });
    const instant = await insert({
      ...past,
      scheduledEnd: new Date('0001-01-01T00:00:00Z'),
      createdAt: new Date(ms - POLL_GIVE_UP_MS - 1000),
    });
    expect((await due()).sort()).toEqual([waiting, reauth, instant].sort());

    // Settled, it drops out.
    await queryUserSchema(USER, `UPDATE teams_meetings SET state = 'failed'`);
    expect(await due()).toEqual([]);
  });

  it('still respects the backoff past the window', async () => {
    await insert({
      attempts: 101,
      lastPolledAt: new Date(ms - MIN),
      scheduledEnd: new Date(ms - POLL_GIVE_UP_MS - 1000),
      createdAt: new Date(ms - POLL_GIVE_UP_MS - 2000),
    });
    expect(await due()).toEqual([]);
  });

  it('lists a link pasted long after its meeting, and one never polled past its window', async () => {
    const pastedNow = await insert({ scheduledEnd: new Date(ms - 5 * POLL_GIVE_UP_MS), createdAt: new Date(ms - MIN) });
    const neverPolled = await insert({
      scheduledEnd: new Date(ms - POLL_GIVE_UP_MS - 1000),
      createdAt: new Date(ms - POLL_GIVE_UP_MS - 2000),
    });
    expect((await due()).sort()).toEqual([pastedNow, neverPolled].sort());
  });

  it('orders by how long a meeting has been waiting, oldest first', async () => {
    const newer = await insert({ scheduledEnd: new Date(ms - 10 * MIN) });
    const older = await insert({ scheduledEnd: new Date(ms - 50 * MIN) });
    expect(await due()).toEqual([older, newer]);
  });

  describe('upsertTeamsMeeting', () => {
    const input = {
      id: 'occ-1',
      graphMeetingId: 'graph-1',
      joinUrl: 'https://teams.microsoft.com/l/meetup-join/x',
      subject: 'Ugentligt møde',
      organizerId: null,
      isOrganizer: true,
      armed: true,
      scheduledStart: new Date('2026-09-15T10:00:00Z'),
      scheduledEnd: new Date('2026-09-15T11:00:00Z'),
    };

    it('stores whether the window belongs to one occurrence, and lets a re-registration change it', async () => {
      expect((await upsertTeamsMeeting(USER, { ...input, occurrenceWindow: true })).occurrenceWindow).toBe(true);
      expect((await getTeamsMeeting(USER, 'occ-1'))?.occurrenceWindow).toBe(true);
      expect((await upsertTeamsMeeting(USER, input)).occurrenceWindow).toBe(false);
    });
  });

  describe('queueRecordingCleanup', () => {
    async function collected(id: string, set: string) {
      await insert({ id, state: 'ready' });
      await queryUserSchema(USER, `UPDATE teams_meetings SET ${set} WHERE id = $1`, [id]);
    }

    it("queues the delete of a collected meeting's recording, once, and stamps when", async () => {
      await collected('m1', 'recording_bytes = 4242');

      expect(await queueRecordingCleanup(USER, 'm1')).toBe(true);
      const [row] = await listPendingRecordingCleanups(USER);
      expect(row).toMatchObject({ id: 'm1', recordingCleanup: 'pending', recordingBytes: 4242 });
      expect(row.recordingCleanupAt).toBeInstanceOf(Date);

      // A second acknowledgement does not restart the day of retries.
      expect(await queueRecordingCleanup(USER, 'm1')).toBe(false);
    });

    it('queues nothing without a recording of ours behind the transcript, or before it is collected', async () => {
      await collected('vtt', 'recording_bytes = NULL');
      await insert({ id: 'waiting' });
      await queryUserSchema(USER, `UPDATE teams_meetings SET recording_bytes = 1 WHERE id = 'waiting'`);
      await collected('done', `recording_bytes = 7, recording_cleanup = 'deleted'`);

      for (const id of ['vtt', 'waiting', 'done', 'nonexistent']) {
        expect(await queueRecordingCleanup(USER, id)).toBe(false);
      }
      expect(await listPendingRecordingCleanups(USER)).toEqual([]);
    });
  });

  describe('Outlook-armed meetings (storage rule)', () => {
    const outlook = { origin: 'outlook' as const };

    it('leaves an unopened meeting to its user, even a week later', async () => {
      await insert({ ...outlook });
      await insert({ ...outlook, scheduledEnd: new Date(ms - 7 * DAY), createdAt: new Date(ms - 8 * DAY) });
      expect(await due()).toEqual([]);
    });

    it('lists it once the 30-day cap has passed, so it can be settled', async () => {
      const id = await insert({
        ...outlook,
        scheduledEnd: new Date(ms - OUTLOOK_UNOPENED_GIVE_UP_MS - 1000),
        createdAt: new Date(ms - OUTLOOK_UNOPENED_GIVE_UP_MS - 2000),
      });
      expect(await due()).toEqual([id]);
    });

    it('polls it like any other once opened', async () => {
      const id = await insert({
        ...outlook,
        scheduledEnd: new Date(ms - 10 * DAY),
        createdAt: new Date(ms - 11 * DAY),
        openedAt: new Date(ms - MIN),
      });
      expect(await due()).toEqual([id]);
    });
  });
});
