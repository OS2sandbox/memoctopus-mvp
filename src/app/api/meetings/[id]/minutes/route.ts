import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { queryUserSchemaOne } from '@/lib/db/user-schema';
import { z } from 'zod';

interface Params {
  params: Promise<{ id: string }>;
}

const patchSchema = z.object({
  minutesId: z.string(),
  content: z.object({ sections: z.array(z.any()) }),
});

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { minutesId, content } = parsed.data;

  // Verify ownership
  const current = await queryUserSchemaOne<{ id: string; version: number; content: unknown }>(
    session.user.id,
    'SELECT id, version, content FROM minutes WHERE id = $1 AND meeting_id = $2',
    [minutesId, id],
  );
  if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const newVersion = current.version + 1;

  // Archive current version
  await queryUserSchemaOne(
    session.user.id,
    'INSERT INTO minute_versions (meeting_id, minutes_id, content) VALUES ($1, $2, $3)',
    [id, current.id, JSON.stringify(current.content)],
  );

  // Update
  await queryUserSchemaOne(
    session.user.id,
    'UPDATE minutes SET content = $1, version = $2 WHERE id = $3',
    [JSON.stringify(content), newVersion, current.id],
  );

  const latestVersion = await queryUserSchemaOne<{
    id: string;
    content: unknown;
    created_at: string;
  }>(
    session.user.id,
    'SELECT id, content, created_at FROM minute_versions WHERE minutes_id = $1 ORDER BY created_at DESC LIMIT 1',
    [current.id],
  );

  return NextResponse.json({ version: newVersion, newVersion: latestVersion });
}
