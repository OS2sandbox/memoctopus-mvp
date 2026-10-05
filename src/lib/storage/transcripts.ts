import { getDB, StoredTranscript } from './db';
import type { TranscriptSegment, PiiReplacement } from '@/types';
import type { TranscriptChapter } from '@/lib/ai/chapters';
import { reportAuditEvent } from '@/lib/audit/client';

function newId(): string {
  return crypto.randomUUID();
}

export async function getTranscript(meetingId: string): Promise<StoredTranscript | null> {
  const db = await getDB();
  const results = await db.getAllFromIndex('transcripts', 'by-meeting', meetingId);
  return results[0] ?? null;
}

export async function saveTranscript(
  meetingId: string,
  data: {
    rawText: string;
    segments: TranscriptSegment[];
    chapters: TranscriptChapter[];
    piiReplacements: PiiReplacement[];
    piiRemovedAt?: string | null;
    diarizationStatus?: 'pending' | 'done' | 'failed';
  },
): Promise<StoredTranscript> {
  const db = await getDB();
  const existing = (await db.getAllFromIndex('transcripts', 'by-meeting', meetingId))[0];
  const transcript: StoredTranscript = {
    id: existing?.id ?? newId(),
    meetingId,
    rawText: data.rawText,
    segments: data.segments,
    chapters: data.chapters,
    piiReplacements: data.piiReplacements,
    piiRemovedAt: data.piiRemovedAt ?? existing?.piiRemovedAt ?? null,
    diarizationStatus: data.diarizationStatus ?? existing?.diarizationStatus,
  };
  await db.put('transcripts', transcript);
  return transcript;
}

// Audit reporting: saveTranscriptSegments / saveTranscriptChapters report
// meeting.transcript_edit only for USER edits that actually change the stored
// value. Machine writes pass `automatic: true` (saveTranscriptSegments also treats
// a given diarizationStatus as automatic: only the diarization pass sets it), and
// the initial transcription goes through saveTranscript, which never reports.
export async function saveTranscriptChapters(
  meetingId: string,
  chapters: TranscriptChapter[],
  opts: { automatic?: boolean } = {},
): Promise<void> {
  const db = await getDB();
  const existing = (await db.getAllFromIndex('transcripts', 'by-meeting', meetingId))[0];
  if (!existing) return;
  await db.put('transcripts', { ...existing, chapters });
  if (!opts.automatic && JSON.stringify(existing.chapters) !== JSON.stringify(chapters)) {
    reportAuditEvent('meeting.transcript_edit', meetingId);
  }
}

export async function saveTranscriptSegments(
  meetingId: string,
  segments: TranscriptSegment[],
  diarizationStatus?: 'pending' | 'done' | 'failed',
  opts: { automatic?: boolean } = {},
): Promise<void> {
  const db = await getDB();
  const existing = (await db.getAllFromIndex('transcripts', 'by-meeting', meetingId))[0];
  if (!existing) return;
  const rawText = segments.map((s) => s.text).join(' ');
  await db.put('transcripts', {
    ...existing,
    segments,
    rawText,
    ...(diarizationStatus ? { diarizationStatus } : {}),
  });
  const automatic = opts.automatic ?? diarizationStatus !== undefined;
  if (!automatic && JSON.stringify(existing.segments) !== JSON.stringify(segments)) {
    reportAuditEvent('meeting.transcript_edit', meetingId, { segmentCount: segments.length });
  }
}
