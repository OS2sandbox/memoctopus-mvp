import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { getBotServiceConfig, botFetch } from '@/lib/bot-service';

// Polls the live bot-service session status. Stateless: the client supplies the
// sessionId (stored in its IndexedDB meeting record) as a query param. No DB.
//
// Returns a neutral 'forbinder' (connecting) state when no session is known yet
// or the bot-service can't be reached, so the client keeps polling cleanly.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await params; // meetingId is part of the path but the lookup is by sessionId
  const sessionId = req.nextUrl.searchParams.get('sessionId');

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
    res = await botFetch(bot, `/sessions/${sessionId}`);
  } catch {
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
}
