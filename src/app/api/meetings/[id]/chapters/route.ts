import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { queryUserSchemaOne } from '@/lib/db/user-schema';
import { groupIntoChapters, TranscriptChapter } from '@/lib/ai/chapters';
import { TranscriptSegment } from '@/types';

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { segments } = (await req.json()) as { segments?: TranscriptSegment[] };
  if (!segments?.length) return NextResponse.json({ chapters: [] });

  const transcript = await queryUserSchemaOne<{ id: string }>(
    session.user.id,
    'SELECT id FROM transcripts WHERE meeting_id = $1 ORDER BY id DESC LIMIT 1',
    [id],
  );

  try {
    const chapters = await groupIntoChapters(segments);

    if (transcript && chapters.length > 0) {
      await queryUserSchemaOne(
        session.user.id,
        'UPDATE transcripts SET chapters = $1 WHERE id = $2',
        [JSON.stringify(chapters), transcript.id],
      );
    }

    return NextResponse.json({ chapters });
  } catch {
    return NextResponse.json({ chapters: [] });
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { chapters } = (await req.json()) as { chapters?: TranscriptChapter[] };
  if (!Array.isArray(chapters)) return NextResponse.json({ error: 'Invalid' }, { status: 400 });

  await queryUserSchemaOne(
    session.user.id,
    'UPDATE transcripts SET chapters = $1 WHERE meeting_id = $2',
    [JSON.stringify(chapters), id],
  );

  return NextResponse.json({ ok: true });
}
