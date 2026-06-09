import { queryUserSchemaOne, queryUserSchema } from '@/lib/db/user-schema';
import { TranscriptSegment, PiiReplacement, MinutesContent } from '@/types';
import type { ProcessPhase } from '@/components/layout/ProcessStrip';
import type { TranscriptChapter } from '@/lib/ai/chapters';

// Run once per user per process — adds columns that may be missing on existing schemas.
const migratedUsers = new Set<string>();
async function ensureColumns(userId: string) {
  if (migratedUsers.has(userId)) return;
  try {
    await queryUserSchema(
      userId,
      `ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS chapters JSONB NOT NULL DEFAULT '[]'`,
    );
  } catch {
    // Non-fatal — page still loads; client will generate chapters via API if column is absent
  }
  migratedUsers.add(userId);
}

export interface MeetingPageData {
  meeting: {
    id: string;
    status: string;
    title: string;
    source: string;
    meetingUrl: string | null;
    botSession: string | null;
    participants: string[];
  };
  audioFile: { durationSeconds: number | null; sizeBytes: number } | null;
  transcript: {
    id: string;
    rawText: string;
    segments: TranscriptSegment[];
    piiRemovedAt: string | null;
    piiReplacements: PiiReplacement[];
    chapters: TranscriptChapter[];
  } | null;
  minutes: {
    id: string;
    content: MinutesContent;
    version: number;
    createdAt: string;
    versions: { id: string; createdAt: string; content: MinutesContent }[];
  } | null;
}

export async function getMeetingPageData(
  userId: string,
  meetingId: string,
): Promise<MeetingPageData | null> {
  await ensureColumns(userId);

  const meeting = await queryUserSchemaOne<{
    id: string;
    status: string;
    title: string;
    source: string;
    meeting_url: string | null;
    bot_session: string | null;
    participants: string[];
  }>(
    userId,
    'SELECT id, status, title, source, meeting_url, bot_session, participants FROM meetings WHERE id = $1',
    [meetingId],
  );
  if (!meeting) return null;

  const [audioFileRow, transcriptRow] = await Promise.all([
    queryUserSchemaOne<{ duration_seconds: number | null; size_bytes: number }>(
      userId,
      'SELECT duration_seconds, size_bytes FROM audio_files WHERE meeting_id = $1 AND deleted_at IS NULL LIMIT 1',
      [meetingId],
    ),
    queryUserSchemaOne<{
      id: string;
      raw_text: string;
      segments: unknown;
      pii_removed_at: string | null;
      pii_replacements: unknown;
    }>(
      userId,
      'SELECT id, raw_text, segments, pii_removed_at, pii_replacements FROM transcripts WHERE meeting_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1',
      [meetingId],
    ),
  ]);

  const audioFile = audioFileRow
    ? { durationSeconds: audioFileRow.duration_seconds, sizeBytes: audioFileRow.size_bytes }
    : null;

  // Load chapters separately so a missing column (migration not yet applied) degrades gracefully.
  let savedChapters: TranscriptChapter[] = [];
  if (transcriptRow) {
    try {
      const chaptersRow = await queryUserSchemaOne<{ chapters: unknown }>(
        userId,
        'SELECT chapters FROM transcripts WHERE meeting_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1',
        [meetingId],
      );
      if (Array.isArray(chaptersRow?.chapters)) {
        savedChapters = chaptersRow.chapters as TranscriptChapter[];
      }
    } catch {
      // Column absent — client will generate chapters via API
    }
  }

  const transcript = transcriptRow
    ? {
        id: transcriptRow.id,
        rawText: transcriptRow.raw_text,
        segments: Array.isArray(transcriptRow.segments)
          ? (transcriptRow.segments as TranscriptSegment[])
          : [],
        piiRemovedAt: transcriptRow.pii_removed_at,
        piiReplacements: Array.isArray(transcriptRow.pii_replacements)
          ? (transcriptRow.pii_replacements as PiiReplacement[])
          : [],
        chapters: savedChapters,
      }
    : null;

  let minutes: MeetingPageData['minutes'] = null;
  if (transcript) {
    const minutesRow = await queryUserSchemaOne<{
      id: string;
      content: unknown;
      version: number;
      created_at: string;
    }>(
      userId,
      'SELECT id, content, version, created_at FROM minutes WHERE meeting_id = $1 ORDER BY version DESC LIMIT 1',
      [meetingId],
    );

    if (minutesRow) {
      const versions = await queryUserSchema<{ id: string; content: unknown; created_at: string }>(
        userId,
        'SELECT id, content, created_at FROM minute_versions WHERE minutes_id = $1 ORDER BY created_at DESC LIMIT 20',
        [minutesRow.id],
      );
      minutes = {
        id: minutesRow.id,
        content: minutesRow.content as MinutesContent,
        version: minutesRow.version,
        createdAt: minutesRow.created_at,
        versions: versions.map((v) => ({
          id: v.id,
          createdAt: v.created_at,
          content: v.content as MinutesContent,
        })),
      };
    }
  }

  return {
    meeting: {
      ...meeting,
      source: meeting.source ?? 'local',
      meetingUrl: meeting.meeting_url ?? null,
      botSession: meeting.bot_session ?? null,
      participants: meeting.participants ?? [],
    },
    audioFile,
    transcript,
    minutes,
  };
}

export function resolveInitialTab(status: string): ProcessPhase {
  if (status === 'minutes' || status === 'done') return 'minutes';
  if (status === 'review') return 'review';
  return 'recording'; // covers 'recording', 'joining', 'processing'
}
