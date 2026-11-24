import { finalizeRecordingToTranscript } from '@/lib/storage/recording';
import { getMeeting, updateMeeting, deleteMeeting } from '@/lib/storage/meetings';
import { getTranscript } from '@/lib/storage/transcripts';
import { getAudio, deleteAudio } from '@/lib/storage/audio';
import { getBatchQueue } from './batch-queue';

/**
 * Settles a stopped recording; the only code that turns its ledger into the
 * transcript. The recording screen, RecordingRecovery and the queue draining all
 * come through here, so they cannot disagree about the result.
 *
 * - `saved`: every batch has its text and the transcript is written (status
 *   `review`). With the recording's audio stored the speakers are left `pending`
 *   for diarization; otherwise there is nothing to play back, so the meeting is
 *   marked `audioDeleted` and diarization `done` (a caller that holds audio it did
 *   not store, a resumed session's, may still patch the speakers in).
 * - `waiting`: some batch is still untranscribed. The meeting is marked
 *   `processing`, and it is settled again by itself once the queue has sent
 *   everything, also when nobody has the meeting open.
 * - `empty`: no speech at all. A meeting with no earlier transcript is deleted; a
 *   re-recorded one goes back to `review` with the transcript it had, and the
 *   silent take's audio is dropped.
 *
 * Calling it again for a meeting someone else already settled reports `saved`.
 * Calls for one meeting run one after another: the screen and the drain watcher
 * often settle the same meeting at once, and updateMeeting's read-then-write would
 * otherwise put back the status the other call had just moved on.
 */
export function finishRecording(meetingId: string): Promise<Outcome> {
  const next = (settling.get(meetingId) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => settle(meetingId));
  settling.set(meetingId, next);
  void next.catch(() => undefined).finally(() => {
    if (settling.get(meetingId) === next) settling.delete(meetingId);
  });
  return next;
}

type Outcome = 'saved' | 'waiting' | 'empty';
const settling = new Map<string, Promise<Outcome>>();

async function settle(meetingId: string): Promise<Outcome> {
  const queue = getBatchQueue(meetingId);
  // Picks up what the ledger holds that this tab's queue does not (a closed tab's
  // batches); rows whose audio is gone are not waited for and become marker lines.
  await queue.adoptPersisted();
  if (queue.getState().waiting > 0) {
    await updateMeeting(meetingId, { status: 'processing' });
    finishWhenDrained(meetingId);
    return 'waiting';
  }

  const hasAudio = (await getAudio(meetingId)) !== null;
  // Written before the transcript moves the meeting to `review`.
  if (!hasAudio) await updateMeeting(meetingId, { audioDeleted: true });
  const segments = await finalizeRecordingToTranscript(meetingId, {
    diarizationStatus: hasAudio ? 'pending' : 'done',
  });
  if (segments?.length) return 'saved';
  // No ledger at all: settled already (it is in `review` then), or a take without
  // a single batch.
  if (segments === null && (await getMeeting(meetingId))?.status === 'review') return 'saved';
  if (!(await getTranscript(meetingId))?.segments.length) {
    await deleteMeeting(meetingId);
    return 'empty';
  }
  await deleteAudio(meetingId);
  await updateMeeting(meetingId, { status: 'review', audioDeleted: true });
  return 'empty';
}

const draining = new Set<string>();

// Settles the meeting once its queue has sent everything. One watcher per meeting.
// The queue may have drained while the caller was marking the meeting `processing`,
// so the state is checked once right after subscribing too.
function finishWhenDrained(meetingId: string): void {
  if (draining.has(meetingId)) return;
  draining.add(meetingId);
  const queue = getBatchQueue(meetingId);
  const settleIfDrained = () => {
    if (queue.getState().waiting > 0) return;
    unsubscribe();
    draining.delete(meetingId);
    finishRecording(meetingId).catch((err: unknown) => {
      console.error(`[finish] settling ${meetingId} failed, RecordingRecovery retries it:`, err);
    });
  };
  const unsubscribe = queue.subscribe(settleIfDrained);
  settleIfDrained();
}
