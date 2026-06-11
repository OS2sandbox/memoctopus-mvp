import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { queryUserSchemaOne } from '@/lib/db/user-schema';
import { getBotServiceConfig, botFetch } from '@/lib/bot-service';
import { z } from 'zod';

const bodySchema = z.object({
  action: z.enum(['pause', 'resume', 'stop', 'abort']),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { meetingId } = await params;
  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: 'Invalid action' }, { status: 400 });

  const { action } = parsed.data;

  const meeting = await queryUserSchemaOne<{
    id: string;
    bot_session: string | null;
  }>(
    session.user.id,
    'SELECT id, bot_session FROM meetings WHERE id = $1',
    [meetingId],
  );

  if (!meeting) return NextResponse.json({ error: 'Meeting not found' }, { status: 404 });

  const bot = getBotServiceConfig();
  if (!bot) {
    return NextResponse.json({ error: 'Bot service not configured' }, { status: 503 });
  }

  if (action === 'abort') {
    if (meeting.bot_session) {
      await botFetch(bot, `/sessions/${meeting.bot_session}`, { method: 'DELETE' }).catch(() => {});
    }
    // Mark meeting as recording so the UI can gracefully handle the abort
    await queryUserSchemaOne(
      session.user.id,
      `UPDATE meetings SET status = 'recording', bot_session = NULL, updated_at = NOW() WHERE id = $1`,
      [meetingId],
    );
    return NextResponse.json({ ok: true });
  }

  if (!meeting.bot_session) {
    return NextResponse.json({ error: 'No active bot session' }, { status: 400 });
  }

  const botPath = action === 'stop'
    ? `/sessions/${meeting.bot_session}/stop`
    : `/sessions/${meeting.bot_session}/${action}`;

  const res = await botFetch(bot, botPath, { method: 'POST' });

  if (!res.ok) {
    return NextResponse.json({ error: 'Bot control failed' }, { status: 502 });
  }

  if (action === 'stop') {
    await queryUserSchemaOne(
      session.user.id,
      `UPDATE meetings SET status = 'processing', updated_at = NOW() WHERE id = $1`,
      [meetingId],
    );
  }

  return NextResponse.json({ ok: true });
}
