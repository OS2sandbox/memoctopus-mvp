import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { queryUserSchema, queryUserSchemaOne } from '@/lib/db/user-schema';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_req: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const meeting = await queryUserSchemaOne<{ id: string; status: string }>(
    session.user.id,
    `SELECT id, status FROM meetings WHERE id = $1`,
    [id],
  );
  if (!meeting) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (meeting.status === 'redacted') {
    return NextResponse.json({ error: 'Already redacted' }, { status: 409 });
  }

  await queryUserSchema(
    session.user.id,
    `UPDATE transcripts
     SET raw_text = '',
         segments = '[]'::jsonb,
         pii_removed_at = now()
     WHERE meeting_id = $1`,
    [id],
  );
  await queryUserSchema(
    session.user.id,
    `UPDATE audio_files SET deleted_at = now() WHERE meeting_id = $1 AND deleted_at IS NULL`,
    [id],
  );
  await queryUserSchema(
    session.user.id,
    `UPDATE meetings SET status = 'redacted', redacted_at = now(), redacted_by = 'user' WHERE id = $1`,
    [id],
  );

  return NextResponse.json({ redactedAt: new Date().toISOString() });
}
