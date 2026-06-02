import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { queryUserSchemaOne } from '@/lib/db/user-schema';

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { meetingId } = await req.json();
  if (!meetingId) return NextResponse.json({ error: 'Missing meetingId' }, { status: 400 });

  const meeting = await queryUserSchemaOne<{
    id: string;
    status: string;
    source: string;
    meeting_url: string | null;
    bot_session: string | null;
  }>(
    session.user.id,
    'SELECT id, status, source, meeting_url, bot_session FROM meetings WHERE id = $1',
    [meetingId],
  );

  if (!meeting) return NextResponse.json({ error: 'Meeting not found' }, { status: 404 });
  if (meeting.source !== 'teams') return NextResponse.json({ error: 'Not a Teams meeting' }, { status: 400 });
  if (!meeting.meeting_url) return NextResponse.json({ error: 'No meeting URL' }, { status: 400 });

  // If a session already exists, return it
  if (meeting.bot_session) {
    return NextResponse.json({ sessionId: meeting.bot_session });
  }

  const botServiceUrl = process.env.BOT_SERVICE_URL;
  if (!botServiceUrl) {
    return NextResponse.json({ error: 'Bot service not configured' }, { status: 503 });
  }

  let res: Response;
  try {
    res = await fetch(`${botServiceUrl}/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.BOT_INTERNAL_SECRET ?? ''}`,
      },
      body: JSON.stringify({
        meetingUrl: meeting.meeting_url,
        meetingId,
        userId: session.user.id,
        botName: 'Memoctopus',
        callbackUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/api/bot/audio-upload`,
      }),
    });
  } catch (err) {
    console.error('Bot service unreachable:', err);
    return NextResponse.json({ error: 'Bot service unreachable' }, { status: 503 });
  }

  if (!res.ok) {
    const err = await res.text();
    console.error('Bot service error:', err);
    return NextResponse.json({ error: 'Failed to start bot session' }, { status: 502 });
  }

  const { sessionId } = await res.json();

  await queryUserSchemaOne(
    session.user.id,
    'UPDATE meetings SET bot_session = $1, updated_at = NOW() WHERE id = $2',
    [sessionId, meetingId],
  );

  return NextResponse.json({ sessionId });
}
