import { NextRequest, NextResponse } from 'next/server';
import { getBotServiceConfig, botFetch } from '@/lib/bot-service';
import { setBotMeetingOwner } from '@/lib/bot-pending-audio';
import { withHandler } from '@/lib/api-handler';
import { recordServerEvent } from '@/lib/audit/record';
import { safeLogError } from '@/lib/audit/safe-log';
import { asEntityUuid } from '@/app/api/meetings/ai-audit';
import { requireAppAccess } from '@/lib/authz/app-access';

// Starts a Teams bot-service session. Stateless: meetings live in the client's
// IndexedDB, so the meeting URL is supplied by the client and the returned
// sessionId is stored client-side (not in any server DB).
export const POST = withHandler('bot/sessions', async (req: NextRequest) => {
  const access = await requireAppAccess();
  if (access instanceof NextResponse) return access;
  const { session } = access;

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
    safeLogError('bot/sessions unreachable', err);
    await recordServerEvent(req, { type: 'bot.session_start', outcome: 'error', actorUserId: session.user.id, entityId: asEntityUuid(meetingId) });
    return NextResponse.json({ error: 'Bot service unreachable' }, { status: 503 });
  }

  if (!res.ok) {
    let errBody: { error?: string } = {};
    try { errBody = await res.json(); } catch { /* ignore */ }
    const errMsg = errBody.error ?? 'Failed to start bot session';
    console.error(`[bot/sessions] bot service rejected start status=${res.status}`);
    await recordServerEvent(req, { type: 'bot.session_start', outcome: 'error', actorUserId: session.user.id, entityId: asEntityUuid(meetingId) });
    return NextResponse.json({ error: errMsg }, { status: res.status === 400 ? 400 : 502 });
  }

  // Bind this meetingId to the authenticated user so the bot read/control routes
  // can reject any other user who later supplies this meetingId. This is the only
  // server-side record of ownership (meetings themselves live in IndexedDB).
  try {
    await setBotMeetingOwner(meetingId, session.user.id);
  } catch (err) {
    safeLogError('bot/sessions owner', err);
  }

  const { sessionId } = await res.json();
  await recordServerEvent(req, { type: 'bot.session_start', actorUserId: session.user.id, entityId: asEntityUuid(meetingId) });
  return NextResponse.json({ sessionId });
});
