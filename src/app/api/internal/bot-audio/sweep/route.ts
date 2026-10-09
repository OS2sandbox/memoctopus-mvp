import { NextRequest, NextResponse } from 'next/server';
import { withHandler } from '@/lib/api-handler';
import { cronGuard } from '@/lib/audit/feed-auth';
import { sweepPendingBotData } from '@/lib/bot-pending-audio';

// Called by the operator's scheduler with INTERNAL_CRON_SECRET (same guard as
// /api/internal/audit/prune: 404 while the secret is unset, 401 for a wrong one). Deletes the
// server-held bot recordings and transcripts nobody collected within the TTL (1 hour) and each
// deletion is recorded as bot.audio_delete (trigger ttl), so the retention promise is provable
// even when no further recording arrives to trigger the opportunistic sweep. Owner bindings
// are removed only after 24 hours and when nothing is left for the meeting. Safe to run at any
// time and any number of times; unlike the Rollekatalog sync there is no setup to be missing, so
// there is no 409: a scheduler that outlives the bot still cleans up what it left behind.
export const POST = withHandler('internal/bot-audio/sweep POST', async (req: NextRequest) => {
  const denied = cronGuard(req);
  if (denied) return denied;

  const result = await sweepPendingBotData();
  return NextResponse.json(result);
});
