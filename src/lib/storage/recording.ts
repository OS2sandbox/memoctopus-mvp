import { getDB, StoredRecordingBatch, StoredTranscript } from './db';
import type { TranscriptSegment } from '@/types';
import { DEFAULT_SPEAKER_LABEL } from '@/lib/audio/speaker-labels';
import { formatDuration } from '@/lib/utils';

// The recording ledger (`recordingBatches`) and the audio still waiting for
// transcription (`pendingAudio`). Every write to either store goes through this
// module, and every function here is one IndexedDB transaction, so a batch's text
// and its audio can never disagree.

// How long untranscribed audio may rest in the browser before it is given up.
export const PENDING_AUDIO_TTL_MS = 24 * 60 * 60 * 1000;

type BatchKey = [string, number];

// Writes a batch row: an `open` checkpoint (rewritten as the batch fills) or the
// sealed `pending` batch, with its WAV when there is one. Attempts and createdAt
// carry over from an earlier write of the same batch.
export async function putBatch(
  batch: Pick<StoredRecordingBatch, 'meetingId' | 'seq' | 'session' | 'intervals' | 'totalWavDuration'> & {
    status: 'open' | 'pending';
  },
  wav?: ArrayBuffer,
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['recordingBatches', 'pendingAudio'], 'readwrite');
  const key: BatchKey = [batch.meetingId, batch.seq];
  const existing = await tx.objectStore('recordingBatches').get(key);
  const now = new Date();
  const createdAt = existing?.createdAt ?? now.toISOString();
  await tx.objectStore('recordingBatches').put({
    ...batch,
    segments: null,
    attempts: existing?.attempts ?? 0,
    createdAt,
    updatedAt: now.toISOString(),
  });
  if (wav) {
    await tx.objectStore('pendingAudio').put({
      meetingId: batch.meetingId,
      seq: batch.seq,
      wav,
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + PENDING_AUDIO_TTL_MS).toISOString(),
    });
  }
  await tx.done;
}

// Stores a batch's transcription and deletes its audio in the same transaction, so
// transcribed audio never outlives its text. A batch IndexedDB refused to store when
// it was sealed has no row yet and gets one here, so its text is not lost; a batch
// whose meeting was deleted while the request was in flight stays deleted.
export async function completeBatch(
  batch: Pick<StoredRecordingBatch, 'meetingId' | 'seq' | 'session' | 'intervals' | 'totalWavDuration'>,
  segments: TranscriptSegment[],
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['recordingBatches', 'pendingAudio', 'meetings'], 'readwrite');
  const key: BatchKey = [batch.meetingId, batch.seq];
  const existing = await tx.objectStore('recordingBatches').get(key);
  const now = new Date().toISOString();
  if (existing) {
    await tx.objectStore('recordingBatches').put({ ...existing, status: 'done', segments, updatedAt: now });
  } else if (await tx.objectStore('meetings').get(batch.meetingId)) {
    const { meetingId, seq, session, intervals, totalWavDuration } = batch;
    await tx.objectStore('recordingBatches').put({
      meetingId, seq, session, intervals, totalWavDuration, status: 'done', segments, attempts: 0, createdAt: now, updatedAt: now,
    });
  }
  await tx.objectStore('pendingAudio').delete(key);
  await tx.done;
}

export async function markAttempt(meetingId: string, seq: number): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('recordingBatches', 'readwrite');
  const existing = await tx.store.get([meetingId, seq]);
  if (existing) {
    await tx.store.put({ ...existing, attempts: existing.attempts + 1, updatedAt: new Date().toISOString() });
  }
  await tx.done;
}

// A meeting's batches in seq order.
export async function listBatches(meetingId: string): Promise<StoredRecordingBatch[]> {
  const db = await getDB();
  return db.getAllFromIndex('recordingBatches', 'by-meeting', meetingId);
}

export async function getPendingAudio(meetingId: string, seq: number): Promise<ArrayBuffer | null> {
  const db = await getDB();
  return (await db.get('pendingAudio', [meetingId, seq]))?.wav ?? null;
}

// Where the next session of a recording continues. The numbers are derived from the
// rows rather than stored, so they cannot drift from them.
export async function getRecordingSummary(meetingId: string): Promise<{
  nextSeq: number;
  nextSession: number;
  timelineEnd: number;
} | null> {
  const rows = await listBatches(meetingId);
  if (rows.length === 0) return null;
  return {
    nextSeq: Math.max(...rows.map((r) => r.seq)) + 1,
    nextSession: Math.max(...rows.map((r) => r.session)) + 1,
    timelineEnd: Math.max(0, ...rows.flatMap((r) => r.intervals.map((i) => i.originalEnd))),
  };
}

export async function listMeetingIdsWithRecordingState(): Promise<string[]> {
  const db = await getDB();
  const keys = await db.getAllKeys('recordingBatches');
  return [...new Set(keys.map(([meetingId]) => meetingId))];
}

// Gives up on audio that has waited longer than PENDING_AUDIO_TTL_MS: the audio is
// deleted and its batch becomes `lost`, which the transcript shows as a marker line.
export async function sweepExpiredPendingAudio(): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['recordingBatches', 'pendingAudio'], 'readwrite');
  const audio = tx.objectStore('pendingAudio');
  const expiredKeys = await audio.index('by-expiry').getAllKeys(IDBKeyRange.upperBound(new Date().toISOString()));
  for (const key of expiredKeys) {
    const row = await tx.objectStore('recordingBatches').get(key);
    if (row && row.status !== 'done') {
      await tx.objectStore('recordingBatches').put({ ...row, status: 'lost', updatedAt: new Date().toISOString() });
    }
    await audio.delete(key);
  }
  await tx.done;
}

function batchSpan(batch: StoredRecordingBatch): { start: number; end: number } {
  return {
    start: batch.intervals[0]?.originalStart ?? 0,
    end: batch.intervals[batch.intervals.length - 1]?.originalEnd ?? 0,
  };
}

// Turns the ledger into the meeting's transcript: writes the transcript and the
// `review` status and deletes the ledger rows and any audio, all in one transaction.
// A batch without text (lost, or never transcribed) becomes a visible marker line
// instead of a silent gap. A ledger without a single segment is deleted without
// touching the transcript or the status, so a silent re-recording cannot replace
// the transcript a meeting already has. Returns the segments written ([] for no
// speech), or null when there was no ledger, which makes a second call a no-op.
export async function finalizeRecordingToTranscript(
  meetingId: string,
  { diarizationStatus }: { diarizationStatus: NonNullable<StoredTranscript['diarizationStatus']> },
): Promise<TranscriptSegment[] | null> {
  const db = await getDB();
  const tx = db.transaction(['recordingBatches', 'pendingAudio', 'transcripts', 'meetings'], 'readwrite');
  const batches = tx.objectStore('recordingBatches');
  const rows = await batches.index('by-meeting').getAll(meetingId);
  if (rows.length === 0) {
    await tx.done;
    return null;
  }

  const segments = rows.flatMap((row): TranscriptSegment[] => {
    if (row.status === 'done') return row.segments ?? [];
    const { start, end } = batchSpan(row);
    return [{
      speaker: DEFAULT_SPEAKER_LABEL,
      start,
      end,
      text: `[Lyden fra ${formatDuration(start)} til ${formatDuration(end)} kunne ikke transskriberes]`,
    }];
  });

  for (const row of rows) {
    const key: BatchKey = [row.meetingId, row.seq];
    await batches.delete(key);
    await tx.objectStore('pendingAudio').delete(key);
  }
  if (segments.length === 0) {
    await tx.done;
    return [];
  }

  const transcripts = tx.objectStore('transcripts');
  const existing = (await transcripts.index('by-meeting').getAll(meetingId))[0];
  await transcripts.put({
    id: existing?.id ?? crypto.randomUUID(),
    meetingId,
    rawText: segments.map((s) => s.text).join(' '),
    segments,
    chapters: [],
    piiReplacements: [],
    piiRemovedAt: existing?.piiRemovedAt ?? null,
    diarizationStatus,
  });

  const meeting = await tx.objectStore('meetings').get(meetingId);
  if (meeting) {
    await tx.objectStore('meetings').put({ ...meeting, status: 'review', updatedAt: new Date().toISOString() });
  }
  await tx.done;
  return segments;
}
