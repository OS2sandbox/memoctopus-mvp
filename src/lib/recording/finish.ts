import { getRecordingSummary, finalizeRecordingToTranscript } from '@/lib/storage/recording';
import { updateMeeting, deleteMeeting } from '@/lib/storage/meetings';
import { getTranscript } from '@/lib/storage/transcripts';
import { getBatchQueue } from './batch-queue';

/**
 * Settles a stopped recording. `saved`: every batch has its text and the transcript
 * is written (status `review`, speakers pending). `waiting`: some batch is still
 * untranscribed, so the meeting is marked `processing` and its ledger kept until the
 * queue has sent everything; call again then. `empty`: no speech at all, and the
 * meeting is deleted, as a silent recording was before the ledger existed. A ledger
 * someone else already finalised counts as `saved`.
 */
export async function finishRecording(meetingId: string): Promise<'saved' | 'waiting' | 'empty'> {
  // The queue also counts batches IndexedDB refused, which exist only in its memory.
  const queued = getBatchQueue(meetingId).getState().waiting;
  const summary = await getRecordingSummary(meetingId);
  if (queued > 0 || (summary?.waiting ?? 0) > 0) {
    await updateMeeting(meetingId, { status: 'processing' });
    return 'waiting';
  }

  const segments = await finalizeRecordingToTranscript(meetingId, { diarizationStatus: 'pending' });
  // null means the ledger was already empty: RecordingRecovery may have finalised it
  // first (on reconnect). Its transcript is the result, not a silent recording.
  if (segments === null && (await getTranscript(meetingId))?.segments.length) return 'saved';
  if (!segments || segments.length === 0) {
    await deleteMeeting(meetingId);
    return 'empty';
  }
  return 'saved';
}
