import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', async () => (await import('@/test/pglite')).pgliteDbModule());
// graph-client (for GraphError) pulls in better-auth, which needs a real database.
vi.mock('@/lib/auth', () => ({ auth: { api: {} } }));
vi.mock('./meeting-arm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./meeting-arm')>()),
  armMeeting: vi.fn(),
  disarmMeeting: vi.fn(),
}));
vi.mock('./meeting-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./meeting-resolver')>()),
  resolveJoinUrl: vi.fn(),
}));
vi.mock('./recording-cleanup', () => ({ deleteRecordingFromDrive: vi.fn() }));
vi.mock('./pipeline', () => ({ processTeamsMeeting: vi.fn() }));
vi.mock('@/lib/pending-artifacts', () => ({
  getMeetingOwner: vi.fn().mockResolvedValue(null),
  setMeetingOwner: vi.fn().mockResolvedValue(undefined),
}));

import { queryUserSchema } from '@/lib/db/user-schema';
import { usePgliteDb } from '@/test/pglite';
import { GraphError } from './graph-client';
import { disarmMeeting } from './meeting-arm';
import { deleteRecordingFromDrive } from './recording-cleanup';
import { pollDueMeetings } from './poller';
import { unregisterTeamsMeeting } from './register';
import {
  claimMeetingSnapshot,
  getTeamsMeeting,
  listPendingRecordingCleanups,
  listTeamsMeetings,
  listTeamsMeetingsByGraphId,
  upsertTeamsMeeting,
  type TeamsMeetingState,
} from './store';

usePgliteDb();

const USER = 'user-1';
const mockDisarm = vi.mocked(disarmMeeting);
const mockDeleteRecording = vi.mocked(deleteRecordingFromDrive);

const ORIGINAL = {
  allowRecording: false,
  allowTranscription: false,
  recordAutomatically: false,
  meetingSpokenLanguageTag: 'en-GB',
};

async function register(id: string, state: TeamsMeetingState = 'awaiting_teams', graphMeetingId = 'series-1') {
  return upsertTeamsMeeting(USER, {
    id,
    graphMeetingId,
    joinUrl: 'https://teams.microsoft.com/l/meetup-join/x',
    subject: 'Ugentligt møde',
    organizerId: 'org-1',
    isOrganizer: true,
    armed: true,
    armResult: 'armed',
    scheduledStart: new Date('2026-09-08T10:00:00Z'),
    scheduledEnd: new Date('2026-09-08T11:00:00Z'),
    state,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.TEAMS_DELETE_RECORDING;
  delete process.env.TEAMS_ARTIFACT_MODE;
  mockDisarm.mockResolvedValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('unregisterTeamsMeeting — a series shares one Teams meeting', () => {
  // A weekly series is one onlineMeeting; each occurrence armed here is its own
  // row. Switching one occurrence off used to disarm the whole series in Teams,
  // so the occurrences still waiting were never recorded.
  it('leaves Teams armed while another occurrence is still waiting for it', async () => {
    await claimMeetingSnapshot(USER, 'series-1', ORIGINAL);
    const off = await register('occ-1');
    await register('occ-2');

    const result = await unregisterTeamsMeeting(USER, off);

    expect(mockDisarm).not.toHaveBeenCalled();
    expect(result).toEqual({ disarmed: true, keptForOtherOccurrences: true });
    expect(await getTeamsMeeting(USER, 'occ-1')).toBeNull();
    expect(await getTeamsMeeting(USER, 'occ-2')).not.toBeNull();
  });

  it('disarms once the other occurrences are settled', async () => {
    await claimMeetingSnapshot(USER, 'series-1', ORIGINAL);
    const off = await register('occ-3');
    await register('occ-1', 'ready');
    await register('occ-2', 'failed');

    const result = await unregisterTeamsMeeting(USER, off);

    expect(mockDisarm).toHaveBeenCalledWith(USER, 'series-1', ORIGINAL);
    expect(result).toEqual({ disarmed: true, keptForOtherOccurrences: false });
  });

  it('is not held back by a different Teams meeting', async () => {
    const off = await register('a');
    await register('b', 'awaiting_teams', 'other-meeting');

    await unregisterTeamsMeeting(USER, off);

    expect(mockDisarm).toHaveBeenCalledWith(USER, 'series-1', null);
  });

  it('reports a disarm Graph refused', async () => {
    const off = await register('a');
    mockDisarm.mockRejectedValueOnce(new GraphError('http', 'nej', { status: 500 }));

    expect(await unregisterTeamsMeeting(USER, off)).toEqual({ disarmed: false, keptForOtherOccurrences: false });
    expect(await getTeamsMeeting(USER, 'a')).toBeNull();
  });
});

describe('unregisterTeamsMeeting — a recording still to be deleted from OneDrive', () => {
  async function readyWithPendingCleanup(id = 'm1') {
    await register(id, 'ready');
    await queryUserSchema(
      USER,
      `UPDATE teams_meetings
          SET recording_cleanup = 'pending', recording_bytes = 4242, last_polled_at = NOW()
        WHERE id = $1`,
      [id],
    );
    return (await getTeamsMeeting(USER, id))!;
  }

  // The row is the only record of which file to delete. Deleting it with the
  // delete still queued left the recording in OneDrive for good.
  it('deletes the recording before it forgets the meeting', async () => {
    const row = await readyWithPendingCleanup();
    mockDeleteRecording.mockResolvedValueOnce('deleted');

    await unregisterTeamsMeeting(USER, row);

    expect(mockDeleteRecording).toHaveBeenCalledWith(USER, 4242);
    expect(await getTeamsMeeting(USER, 'm1')).toBeNull();
    expect(await listPendingRecordingCleanups(USER)).toEqual([]);
  });

  it('keeps the queued delete, out of sight, when OneDrive cannot be reached now', async () => {
    const row = await readyWithPendingCleanup();
    mockDeleteRecording.mockRejectedValueOnce(new GraphError('unavailable', 'nede'));

    await unregisterTeamsMeeting(USER, row);

    // Gone for the user …
    expect(await getTeamsMeeting(USER, 'm1')).toBeNull();
    expect(await listTeamsMeetings(USER)).toEqual([]);
    expect(await listTeamsMeetingsByGraphId(USER, 'series-1')).toEqual([]);
    // … but the poller still has the delete to do.
    expect((await listPendingRecordingCleanups(USER)).map((r) => r.id)).toEqual(['m1']);

    // The next poller pass deletes the recording, and with it the last of the row.
    process.env.TEAMS_GRAPH_ENABLED = 'true';
    mockDeleteRecording.mockResolvedValueOnce('deleted');
    try {
      await pollDueMeetings(new Date());
    } finally {
      delete process.env.TEAMS_GRAPH_ENABLED;
    }
    expect(mockDeleteRecording).toHaveBeenCalledTimes(2);
    expect(await listPendingRecordingCleanups(USER)).toEqual([]);
    const left = await queryUserSchema(USER, `SELECT id FROM teams_meetings`);
    expect(left).toEqual([]);
  });

  it('just forgets the meeting when recordings are not deleted on this deployment', async () => {
    const row = await readyWithPendingCleanup();
    process.env.TEAMS_DELETE_RECORDING = 'false';

    await unregisterTeamsMeeting(USER, row);

    expect(mockDeleteRecording).not.toHaveBeenCalled();
    expect(await queryUserSchema(USER, `SELECT id FROM teams_meetings`)).toEqual([]);
  });
});
