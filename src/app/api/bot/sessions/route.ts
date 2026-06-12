import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { getBotServiceConfig, botFetch } from '@/lib/bot-service';

// Starts a Teams bot-service session. Stateless: meetings live in the client's
// IndexedDB, so the meeting URL is supplied by the client and the returned
// sessionId is stored client-side (not in any server DB).
export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let meetingId: string | undefined;
  let meetingUrl: string | undefined;
  try {
    ({ meetingId, meetingUrl } = await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  if (!meetingId) return NextResponse.json({ error: 'Missing meetingId' }, { status: 400 });
  if (!meetingUrl) return NextResponse.json({ error: 'Missing meetingUrl' }, { status: 400 });

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
        meetingUrl,
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
    return NextResponse.json({ error: errMsg }, { status: res.status === 400 ? 400 : 502 });
  }

  const { sessionId } = await res.json();
  return NextResponse.json({ sessionId });
}
