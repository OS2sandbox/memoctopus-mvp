import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { queryUserSchemaOne } from '@/lib/db/user-schema';
import { TranscriptSegment } from '@/types';

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: Params) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: meetingId } = await params;

  const meeting = await queryUserSchemaOne<{ id: string }>(
    session.user.id,
    'SELECT id FROM meetings WHERE id = $1',
    [meetingId],
  );
  if (!meeting) return NextResponse.json({ error: 'Meeting not found' }, { status: 404 });

  const body = await req.json();
  const segments: TranscriptSegment[] = body.segments ?? [];

  const rawText = segments.map((s) => s.text).join(' ');

  const transcript = await queryUserSchemaOne<{ id: string }>(
    session.user.id,
    `INSERT INTO transcripts (meeting_id, raw_text, segments, pii_removed_at, pii_replacements)
     VALUES ($1, $2, $3, NULL, $4)
     RETURNING id`,
    [meetingId, rawText, JSON.stringify(segments), JSON.stringify([])],
  );

  await queryUserSchemaOne(
    session.user.id,
    `UPDATE meetings SET status = 'review', updated_at = NOW() WHERE id = $1`,
    [meetingId],
  );

  return NextResponse.json({ transcriptId: transcript!.id });
}
