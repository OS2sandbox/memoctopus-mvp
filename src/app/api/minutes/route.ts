import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { queryUserSchemaOne, queryUserSchema } from '@/lib/db/user-schema';
import { suggestTemplate, generateMinutes, generateMinutesFreeform } from '@/lib/ai/minutes';
import { deleteAudioFile } from '@/lib/audio/storage';
import { TranscriptSegment, TemplateStructure } from '@/types';

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { meetingId, transcriptId, segments, customPrompt, participants } = body as {
    meetingId: string;
    transcriptId: string;
    segments: TranscriptSegment[];
    customPrompt?: string;
    participants?: string[];
  };

  if (!meetingId || !transcriptId) {
    return NextResponse.json({ error: 'Missing meetingId or transcriptId' }, { status: 400 });
  }

  // Verify ownership
  const meeting = await queryUserSchemaOne<{ id: string }>(
    session.user.id,
    'SELECT id FROM meetings WHERE id = $1',
    [meetingId],
  );
  if (!meeting) return NextResponse.json({ error: 'Meeting not found' }, { status: 404 });

  // Use the client-processed segments (with PII applied and manual edits) directly for generation.
  // Do NOT write them back to DB — the DB keeps the raw uncensored transcript so PII toggling
  // on the review page keeps working across navigations.
  const transcriptSegments: TranscriptSegment[] = segments && segments.length > 0
    ? segments
    : await (async () => {
        const transcript = await queryUserSchemaOne<{ segments: unknown }>(
          session.user.id,
          'SELECT segments FROM transcripts WHERE id = $1',
          [transcriptId],
        );
        return (transcript?.segments as TranscriptSegment[]) ?? [];
      })();

  if (transcriptSegments.length === 0) {
    return NextResponse.json({ error: 'Transcript not found' }, { status: 404 });
  }

  let minutesContent;
  let templateId: string | null = null;

  if (customPrompt) {
    // User gave instructions — let the AI decide sections and content freely
    minutesContent = await generateMinutesFreeform(transcriptSegments, customPrompt, participants);
  } else {
    // No prompt — pick a template and generate structured minutes
    const templates = await queryUserSchema<{
      id: string;
      name: string;
      description: string;
      structure: unknown;
      is_default: boolean;
    }>(
      session.user.id,
      'SELECT id, name, description, structure, is_default FROM templates',
    );

    const suggestion = await suggestTemplate(
      transcriptSegments,
      templates.map((t) => ({ id: t.id, name: t.name, description: t.description })),
    );

    const chosenTemplate =
      templates.find((t) => t.id === suggestion.templateId) ??
      templates.find((t) => t.is_default) ??
      templates[0];

    if (!chosenTemplate) {
      return NextResponse.json({ error: 'No templates available' }, { status: 500 });
    }

    templateId = chosenTemplate.id;
    minutesContent = await generateMinutes(
      transcriptSegments,
      (chosenTemplate.structure as TemplateStructure).sections,
      undefined,
      participants,
    );
  }

  // If minutes already exist, archive the current version and update in-place so history is preserved.
  const existingMinutes = await queryUserSchemaOne<{ id: string; version: number; content: unknown }>(
    session.user.id,
    'SELECT id, version, content FROM minutes WHERE meeting_id = $1',
    [meetingId],
  );

  let minutesRow: { id: string } | null;
  if (existingMinutes) {
    await queryUserSchemaOne(
      session.user.id,
      'INSERT INTO minute_versions (meeting_id, minutes_id, content) VALUES ($1, $2, $3)',
      [meetingId, existingMinutes.id, JSON.stringify(existingMinutes.content)],
    );
    const newVersion = existingMinutes.version + 1;
    await queryUserSchemaOne(
      session.user.id,
      'UPDATE minutes SET content = $1, version = $2, template_id = $3 WHERE id = $4',
      [JSON.stringify(minutesContent), newVersion, templateId, existingMinutes.id],
    );
    minutesRow = { id: existingMinutes.id };
  } else {
    minutesRow = await queryUserSchemaOne<{ id: string }>(
      session.user.id,
      `INSERT INTO minutes (meeting_id, template_id, content, version)
       VALUES ($1, $2, $3, 1)
       RETURNING id`,
      [meetingId, templateId, JSON.stringify(minutesContent)],
    );
  }

  // Update meeting status
  await queryUserSchemaOne(
    session.user.id,
    `UPDATE meetings SET status = 'minutes', updated_at = NOW() WHERE id = $1`,
    [meetingId],
  );

  // Delete audio files (GDPR — audio no longer needed once minutes are generated)
  try {
    const audioFiles = await queryUserSchema<{ filename: string }>(
      session.user.id,
      'SELECT filename FROM audio_files WHERE meeting_id = $1 AND deleted_at IS NULL',
      [meetingId],
    );
    await queryUserSchema(
      session.user.id,
      'UPDATE audio_files SET deleted_at = NOW() WHERE meeting_id = $1 AND deleted_at IS NULL',
      [meetingId],
    );
    await Promise.all(audioFiles.map((f) => deleteAudioFile(session.user.id, f.filename)));
  } catch {
    // Non-fatal — minutes are saved; audio cleanup can be retried later
  }

  return NextResponse.json({ minutesId: minutesRow!.id });
}
