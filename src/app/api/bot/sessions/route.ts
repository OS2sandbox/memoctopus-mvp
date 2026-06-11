import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { queryUserSchemaOne } from '@/lib/db/user-schema';
import { getBotServiceConfig, botFetch } from '@/lib/bot-service';

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let meetingId: string | undefined;
  try {
    ({ meetingId } = await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
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
  // Prevent starting a new bot session while the previous recording is still being transcribed.
  if (meeting.status === 'processing') {
    return NextResponse.json({ error: 'Transkription er i gang — prøv igen om lidt' }, { status: 409 });
  }

  // Atomically claim the slot — only one concurrent request can proceed.
  // Also clears a 'creating' sentinel that's been stuck for >2 min (indicates
  // the previous attempt crashed before it could reset bot_session to NULL).
  const claimed = await queryUserSchemaOne<{ id: string }>(
    session.user.id,
    `UPDATE meetings SET bot_session = 'creating', updated_at = NOW()
     WHERE id = $1
       AND (
         bot_session IS NULL OR bot_session = ''
         OR (bot_session = 'creating' AND updated_at < NOW() - INTERVAL '2 minutes')
       )
     RETURNING id`,
    [meetingId],
  );

  if (!claimed) {
    // Another request already claimed it — wait briefly and return whatever was set
    await new Promise((r) => setTimeout(r, 500));
    const existing = await queryUserSchemaOne<{ bot_session: string }>(
      session.user.id,
      'SELECT bot_session FROM meetings WHERE id = $1',
      [meetingId],
    );
    return NextResponse.json({ sessionId: existing?.bot_session ?? '' });
  }

  const bot = getBotServiceConfig();
  if (!bot) {
    return NextResponse.json({ error: 'Bot service not configured' }, { status: 503 });
  }

  let res: Response;
  try {
    res = await botFetch(bot, '/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        meetingUrl: meeting.meeting_url,
        meetingId,
        userId: session.user.id,
        botName: 'Memoctopus',
      }),
    });
  } catch (err) {
    console.error('Bot service unreachable:', err);
    return NextResponse.json({ error: 'Bot service unreachable' }, { status: 503 });
  }

  if (!res.ok) {
    let errBody: { error?: string } = {};
    try { errBody = await res.json(); } catch { /* ignore */ }
    const errMsg = errBody.error ?? 'Failed to start bot session';
    console.error('Bot service error:', errMsg);
    // Undo the bot_session claim so the user can retry
    await queryUserSchemaOne(
      session.user.id,
      `UPDATE meetings SET bot_session = NULL, updated_at = NOW() WHERE id = $1`,
      [meetingId],
    ).catch(() => {});
    return NextResponse.json({ error: errMsg }, { status: res.status === 400 ? 400 : 502 });
  }

  const { sessionId } = await res.json();

  await queryUserSchemaOne(
    session.user.id,
    'UPDATE meetings SET bot_session = $1, updated_at = NOW() WHERE id = $2',
    [sessionId, meetingId],
  );

  return NextResponse.json({ sessionId });
}
