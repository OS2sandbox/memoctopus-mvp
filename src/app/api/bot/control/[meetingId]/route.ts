import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { getBotServiceConfig, botFetch } from '@/lib/bot-service';
import { assertBotMeetingOwner } from '@/lib/bot-pending-audio';
import { z } from 'zod';

const bodySchema = z.object({
  action: z.enum(['pause', 'resume', 'stop', 'abort']),
  sessionId: z.string().optional(),
});

// Pause/resume/stop/abort a Teams bot session. Stateless: the client supplies the
// sessionId (from its IndexedDB meeting record). No DB.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { meetingId } = await params;

  // Only the user who started this meeting's session may control it. Without this,
  // any authenticated user could stop/pause/abort another user's live recording by
  // supplying their (client-held) sessionId. Deny by default on an unbound meetingId.
  if (!(await assertBotMeetingOwner(meetingId, session.user.id))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: 'Invalid action' }, { status: 400 });

  const { action, sessionId } = parsed.data;

  const bot = getBotServiceConfig();
  if (!bot) {
    return NextResponse.json({ error: 'Bot service not configured' }, { status: 503 });
  }

  // Abort: tear down the session if one exists. Idempotent — ok even with no session.
  if (action === 'abort') {
    if (sessionId) {
      await botFetch(bot, `/sessions/${sessionId}`, { method: 'DELETE' }).catch((err) => {
        console.warn('[bot/control] abort DELETE failed (ignored — idempotent):', err);
      });
    }
    return NextResponse.json({ ok: true });
  }

  if (!sessionId) {
    return NextResponse.json({ error: 'No active bot session' }, { status: 400 });
  }

  const botPath = action === 'stop'
    ? `/sessions/${sessionId}/stop`
    : `/sessions/${sessionId}/${action}`;

  let res: Response;
  try {
    res = await botFetch(bot, botPath, { method: 'POST' });
  } catch (err) {
    console.error(`[bot/control] network error sending action="${action}" to bot:`, err);
    return NextResponse.json({ error: 'Bot control failed' }, { status: 502 });
  }
  if (!res.ok) {
    console.error(`[bot/control] bot rejected action="${action}" with status ${res.status}`);
    return NextResponse.json({ error: 'Bot control failed' }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
