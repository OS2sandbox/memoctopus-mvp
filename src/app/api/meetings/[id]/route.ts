import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { queryUserSchemaOne, queryUserSchema } from '@/lib/db/user-schema';
import { z } from 'zod';

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const meeting = await queryUserSchemaOne(
    session.user.id,
    'SELECT * FROM meetings WHERE id = $1',
    [id],
  );

  if (!meeting) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(meeting);
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();

  // Handle minutes save
  if (body.minutesId && body.content) {
    const minutesSchema = z.object({
      minutesId: z.string(),
      content: z.object({ sections: z.array(z.any()) }),
    });
    const parsed = minutesSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    // Get current version
    const current = await queryUserSchemaOne<{ id: string; version: number; content: unknown }>(
      session.user.id,
      'SELECT id, version, content FROM minutes WHERE id = $1 AND meeting_id = $2',
      [parsed.data.minutesId, id],
    );
    if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const newVersion = current.version + 1;

    // Save old version to history
    await queryUserSchemaOne(
      session.user.id,
      'INSERT INTO minute_versions (meeting_id, minutes_id, content) VALUES ($1, $2, $3)',
      [id, current.id, JSON.stringify(current.content)],
    );

    // Update minutes
    await queryUserSchemaOne(
      session.user.id,
      'UPDATE minutes SET content = $1, version = $2 WHERE id = $3',
      [JSON.stringify(parsed.data.content), newVersion, current.id],
    );

    const versionRow = await queryUserSchemaOne<{ id: string; content: unknown; created_at: string }>(
      session.user.id,
      'SELECT id, content, created_at FROM minute_versions WHERE minutes_id = $1 ORDER BY created_at DESC LIMIT 1',
      [current.id],
    );

    return NextResponse.json({ version: newVersion, newVersion: versionRow });
  }

  // Handle title rename
  if (body.title !== undefined) {
    const titleSchema = z.object({ title: z.string().min(1) });
    const parsed = titleSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    await queryUserSchemaOne(
      session.user.id,
      'UPDATE meetings SET title = $1, updated_at = NOW() WHERE id = $2',
      [parsed.data.title, id],
    );
    return NextResponse.json({ ok: true });
  }

  // Handle status update
  if (body.status) {
    const statusSchema = z.object({ status: z.enum(['recording', 'processing', 'review', 'minutes', 'done']) });
    const parsed = statusSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    await queryUserSchemaOne(
      session.user.id,
      'UPDATE meetings SET status = $1, updated_at = NOW() WHERE id = $2',
      [parsed.data.status, id],
    );
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Soft-delete audio files first (GDPR)
  await queryUserSchema(
    session.user.id,
    'UPDATE audio_files SET deleted_at = NOW() WHERE meeting_id = $1',
    [id],
  );

  // Hard delete meeting (cascades)
  await queryUserSchemaOne(
    session.user.id,
    'DELETE FROM meetings WHERE id = $1',
    [id],
  );

  return NextResponse.json({ ok: true });
}
