import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { queryUserSchema, queryUserSchemaOne } from '@/lib/db/user-schema';
import { z } from 'zod';

const createSchema = z.object({
  title: z.string().min(1).max(200),
  participants: z.array(z.string()).optional().default([]),
  source: z.enum(['local', 'teams']).default('local'),
  meetingUrl: z.string().url().optional(),
});

export async function GET(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const countOnly = new URL(req.url).searchParams.get('count') === '1';
  if (countOnly) {
    const rows = await queryUserSchema<{ count: string }>(
      session.user.id,
      'SELECT COUNT(*)::text AS count FROM meetings',
    );
    return NextResponse.json({ count: parseInt(rows[0]?.count ?? '0', 10) });
  }

  const meetings = await queryUserSchema(
    session.user.id,
    'SELECT id, title, participants, status, created_at, updated_at FROM meetings ORDER BY created_at DESC',
  );

  return NextResponse.json(meetings);
}

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { title, participants, source, meetingUrl } = parsed.data;

  const initialStatus = source === 'teams' ? 'joining' : 'recording';

  const meeting = await queryUserSchemaOne<{ id: string }>(
    session.user.id,
    `INSERT INTO meetings (title, participants, status, source, meeting_url)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [title, participants, initialStatus, source, meetingUrl ?? null],
  );

  return NextResponse.json({ id: meeting!.id }, { status: 201 });
}
