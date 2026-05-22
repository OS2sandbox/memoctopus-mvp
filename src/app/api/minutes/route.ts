import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { queryUserSchemaOne, queryUserSchema } from '@/lib/db/user-schema';
import { suggestTemplate, generateMinutes } from '@/lib/ai/minutes';
import { TranscriptSegment, TemplateStructure } from '@/types';

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { meetingId, transcriptId, segments } = body as {
    meetingId: string;
    transcriptId: string;
    segments: TranscriptSegment[];
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

  // Update segments if provided
  if (segments && segments.length > 0) {
    const rawText = segments.map((s: TranscriptSegment) => s.text).join(' ');
    await queryUserSchemaOne(
      session.user.id,
      'UPDATE transcripts SET raw_text = $1, segments = $2 WHERE id = $3',
      [rawText, JSON.stringify(segments), transcriptId],
    );
  }

  // Get transcript
  const transcript = await queryUserSchemaOne<{ segments: unknown }>(
    session.user.id,
    'SELECT segments FROM transcripts WHERE id = $1',
    [transcriptId],
  );
  if (!transcript) return NextResponse.json({ error: 'Transcript not found' }, { status: 404 });

  const transcriptSegments = (transcript.segments as TranscriptSegment[]) ?? [];

  // Load available templates
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

  // Suggest template
  const suggestion = await suggestTemplate(
    transcriptSegments,
    templates.map((t) => ({ id: t.id, name: t.name, description: t.description })),
  );

  // Find template structure
  let templateId = suggestion.templateId;
  let templateStructure: TemplateStructure;

  const chosenTemplate = templates.find((t) => t.id === templateId) ?? templates.find((t) => t.is_default) ?? templates[0];
  if (!chosenTemplate) {
    return NextResponse.json({ error: 'No templates available' }, { status: 500 });
  }

  templateId = chosenTemplate.id;
  templateStructure = chosenTemplate.structure as TemplateStructure;

  // Generate minutes
  const minutesContent = await generateMinutes(transcriptSegments, templateStructure.sections);

  // Save minutes
  const minutesRow = await queryUserSchemaOne<{ id: string }>(
    session.user.id,
    `INSERT INTO minutes (meeting_id, template_id, content, version)
     VALUES ($1, $2, $3, 1)
     RETURNING id`,
    [meetingId, templateId, JSON.stringify(minutesContent)],
  );

  // Update meeting status
  await queryUserSchemaOne(
    session.user.id,
    `UPDATE meetings SET status = 'minutes', updated_at = NOW() WHERE id = $1`,
    [meetingId],
  );

  return NextResponse.json({
    minutesId: minutesRow!.id,
    templateSuggestion: suggestion,
  });
}
