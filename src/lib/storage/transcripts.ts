import { getDB, StoredTranscript } from './db';
import type { TranscriptSegment, PiiReplacement } from '@/types';
import type { TranscriptChapter } from '@/lib/ai/chapters';

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
  };
  await db.put('transcripts', transcript);
  return transcript;
}

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
): Promise<void> {
  const db = await getDB();
  const existing = (await db.getAllFromIndex('transcripts', 'by-meeting', meetingId))[0];
  if (!existing) return;
  const rawText = segments.map((s) => s.text).join(' ');
  await db.put('transcripts', { ...existing, segments, rawText });
}
