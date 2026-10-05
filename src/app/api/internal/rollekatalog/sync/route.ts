import { NextRequest } from 'next/server';
import { withHandler } from '@/lib/api-handler';
import { cronGuard } from '@/lib/audit/feed-auth';
import { runSync } from '@/lib/rollekatalog/sync';
import { syncResultResponse } from '@/lib/rollekatalog/sync-http';

// Called by the operator's scheduler with INTERNAL_CRON_SECRET (the app has no
// in-process timers: they break with several replicas). The sync records its own
// sync_runs row and the directory.sync audit event. Never forced: only the admin
// button may bypass the removal threshold.
export const POST = withHandler('internal/rollekatalog/sync POST', async (req: NextRequest) => {
  const denied = cronGuard(req);
  if (denied) return denied;

  const result = await runSync({ trigger: 'cron' });
  return syncResultResponse(result, false);
});
