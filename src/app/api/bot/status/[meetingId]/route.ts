import { NextRequest, NextResponse } from 'next/server';
import { getBotServiceConfig, botFetch } from '@/lib/bot-service';
import { withHandler } from '@/lib/api-handler';
import { safeLogError } from '@/lib/audit/safe-log';
import { z } from 'zod';
import { requireAppAccess } from '@/lib/authz/app-access';

// Polls the live bot-service session status. Stateless: the client supplies the
// sessionId (stored in its IndexedDB meeting record) as a query param. No DB.
//
// Returns a neutral 'forbinder' (connecting) state when no session is known yet
// or the bot-service can't be reached, so the client keeps polling cleanly.
export const GET = withHandler('bot/status', async (
  req: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> },
) => {
  const access = await requireAppAccess();
  if (access instanceof NextResponse) return access;
  const { session } = access;

  await params; // meetingId is part of the path but the lookup is by sessionId
  const sessionId = req.nextUrl.searchParams.get('sessionId');
  // The bot-service issues UUID session ids; anything else never reaches it.
  if (sessionId && !z.string().uuid().safeParse(sessionId).success) {
    return NextResponse.json({ error: 'Invalid sessionId' }, { status: 400 });
  }

  const connecting = (botStatus = 'idle') =>
    NextResponse.json({ status: 'forbinder', botStatus, participants: [], elapsed: 0 });

  // No session yet (pre-join or page reload before the session was created).
  if (!sessionId) return connecting();

  const bot = getBotServiceConfig();
  if (!bot) {
    return NextResponse.json({ error: 'Bot service not configured' }, { status: 503 });
  }

  // botFetch THROWS on connection-refused/DNS failure, so guard it — a bot-service
  // restart mid-poll should report 'forbinder', not 500.
  let res: Response;
  try {
    res = await botFetch(bot, `/sessions/${encodeURIComponent(sessionId)}`);
  } catch (err) {
    safeLogError('bot/status unreachable, returning forbinder', err);
    return connecting();
  }
  if (!res.ok) return connecting();

  const botState = await res.json();

  // Map bot-service status → UI status.
  const statusMap: Record<string, string> = {
    joining: 'forbinder',
    recording: 'optager',
    paused: 'pause',
    ended: 'processing',
    error: 'error',
  };
  const uiStatus = statusMap[botState.status as string] ?? 'forbinder';

  const rawParticipants: string[] = botState.participants?.length ? botState.participants : [];
  const participants = rawParticipants.filter((p: string) => p !== '__audio_detected__');

  return NextResponse.json({
    status: uiStatus,
    botStatus: botState.status ?? 'idle',
    participants,
    elapsed: botState.elapsed ?? 0,
  });
});
