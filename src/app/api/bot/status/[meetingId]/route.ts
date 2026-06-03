import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { queryUserSchemaOne } from '@/lib/db/user-schema';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { meetingId } = await params;

  const meeting = await queryUserSchemaOne<{
    id: string;
    status: string;
    source: string;
    bot_session: string | null;
    participants: string[];
  }>(
    session.user.id,
    'SELECT id, status, source, bot_session, participants FROM meetings WHERE id = $1',
    [meetingId],
  );

  if (!meeting) return NextResponse.json({ error: 'Meeting not found' }, { status: 404 });

  // Cancelled (no recording made) — tell client to go home
  if (meeting.status === 'cancelled') {
    return NextResponse.json({
      status: 'forbinder',
      meetingStatus: 'cancelled',
      participants: [],
      elapsed: 0,
    });
  }

  // If no bot session yet (still joining pre-bot-start) or already at review+
  if (!meeting.bot_session) {
    return NextResponse.json({
      status: 'forbinder',
      participants: meeting.participants ?? [],
      elapsed: 0,
    });
  }

  const botServiceUrl = process.env.BOT_SERVICE_URL;
  if (!botServiceUrl) {
    return NextResponse.json({ error: 'Bot service not configured' }, { status: 503 });
  }

  const res = await fetch(`${botServiceUrl}/sessions/${meeting.bot_session}`, {
    headers: { Authorization: `Bearer ${process.env.BOT_INTERNAL_SECRET ?? ''}` },
  });

  if (!res.ok) {
    // Bot session gone (service restart?) — return the DB-level meeting status so the
    // client can continue polling without a console 502 error.
    if (meeting.status === 'review') {
      return NextResponse.json({
        status: 'processing',
        meetingStatus: 'review',
        participants: meeting.participants ?? [],
        elapsed: 0,
      });
    }
    if (meeting.status === 'processing') {
      return NextResponse.json({
        status: 'processing',
        meetingStatus: 'processing',
        participants: meeting.participants ?? [],
        elapsed: 0,
      });
    }
    return NextResponse.json({ error: 'Bot service unreachable' }, { status: 502 });
  }

  const botState = await res.json();

  // Map bot service status to UI status
  const statusMap: Record<string, string> = {
    joining: 'forbinder',
    recording: 'optager',
    paused: 'pause',
    ended: 'processing',
    error: 'error',
  };
  const uiStatus = statusMap[botState.status as string] ?? 'forbinder';

  // When bot reports ended naturally, update DB status to processing
  if (botState.status === 'ended' && meeting.status !== 'processing' && meeting.status !== 'review') {
    await queryUserSchemaOne(
      session.user.id,
      `UPDATE meetings SET status = 'processing', updated_at = NOW() WHERE id = $1`,
      [meetingId],
    );
  }

  const rawParticipants: string[] = botState.participants ?? meeting.participants ?? [];
  const participants = rawParticipants.filter((p: string) => p !== '__audio_detected__');

  return NextResponse.json({
    status: uiStatus,
    participants,
    elapsed: botState.elapsed ?? 0,
    meetingStatus: meeting.status,
  });
}
