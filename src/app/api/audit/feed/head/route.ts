import { NextRequest, NextResponse } from 'next/server';
import { withHandler } from '@/lib/api-handler';
import { auditFeedDelaySeconds } from '@/lib/audit/config';
import { feedGuard } from '@/lib/audit/feed-auth';
import { getFeedHead } from '@/lib/audit/query';

// Machine endpoint: authenticated by the service key only, no session.
export const GET = withHandler('audit/feed/head GET', async (req: NextRequest) => {
  const denied = feedGuard(req);
  if (denied) return denied;
  const head = await getFeedHead(auditFeedDelaySeconds());
  return NextResponse.json({ head }, { headers: { 'Cache-Control': 'no-store' } });
});
