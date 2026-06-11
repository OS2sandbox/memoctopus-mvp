import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { queryUserSchemaOne } from '@/lib/db/user-schema';
import { z } from 'zod';

interface Params {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const schema = z.object({ from: z.string(), to: z.string().min(1) });
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const transcript = await queryUserSchemaOne<{ id: string; segments: unknown }>(
    session.user.id,
    'SELECT id, segments FROM transcripts WHERE meeting_id = $1 ORDER BY id DESC LIMIT 1',
    [id],
  );
  if (!transcript) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const segments = Array.isArray(transcript.segments)
    ? (transcript.segments as Array<{ speaker: string } & Record<string, unknown>>)
    : [];

  const updated = segments.map((seg) =>
    seg.speaker === parsed.data.from ? { ...seg, speaker: parsed.data.to } : seg,
  );

  await queryUserSchemaOne(
    session.user.id,
    'UPDATE transcripts SET segments = $1 WHERE id = $2',
    [JSON.stringify(updated), transcript.id],
  );

  return NextResponse.json({ segments: updated });
}
