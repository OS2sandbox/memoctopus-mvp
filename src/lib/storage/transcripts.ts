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

// Audit reporting: only a change of WHO SPOKE (a voice linked, unlinked, renamed or removed)
// is reported, as meeting.speakers_edit with the number of distinct speakers. Text edits,
// chapters and the machine writes (the diarization pass, which passes a diarizationStatus)
// are not reported, and a write that repeats the stored speakers reports nothing. Never
// the names or the text.
export async function saveTranscriptChapters(
  meetingId: string,
  chapters: TranscriptChapter[],
): Promise<void> {
  const db = await getDB();
  const existing = (await db.getAllFromIndex('transcripts', 'by-meeting', meetingId))[0];
  if (!existing) return;
  await db.put('transcripts', { ...existing, chapters });
}

export async function saveTranscriptSegments(
  meetingId: string,
  segments: TranscriptSegment[],
  diarizationStatus?: 'pending' | 'done' | 'failed',
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
  try {
    const before = existing.segments ?? [];
    const speakersChanged = before.length === segments.length && segments.some((seg, i) => seg.speaker !== before[i].speaker);
    if (diarizationStatus === undefined && speakersChanged) {
      reportAuditEvent('meeting.speakers_edit', meetingId, { speakerCount: new Set(segments.map((s) => s.speaker)).size });
    }
  } catch {
    // Reporting is best effort and must never turn a successful write into an error.
  }
}
