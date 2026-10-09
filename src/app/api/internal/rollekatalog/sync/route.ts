import { NextRequest, NextResponse } from 'next/server';
import { withHandler } from '@/lib/api-handler';
import { cronGuard } from '@/lib/audit/feed-auth';
import { accessSource } from '@/lib/authz/config';
import { rollekatalogConfigIssue } from '@/lib/rollekatalog/config';
import { runSync } from '@/lib/rollekatalog/sync';
import { syncResultResponse } from '@/lib/rollekatalog/sync-http';

// Called by the operator's scheduler with INTERNAL_CRON_SECRET (the app has no
// in-process timers: they break with several replicas). The sync records its own
// sync_runs row (no audit event). Never forced: only the admin
// button may bypass the removal threshold. A scheduler that outlives its setup
// (local mode, or no URL/keys) gets 409 and leaves no sync_runs row.
export const POST = withHandler('internal/rollekatalog/sync POST', async (req: NextRequest) => {
  const denied = cronGuard(req);
  if (denied) return denied;

  if (accessSource() !== 'rollekatalog') {
    return NextResponse.json({ error: 'not_rollekatalog_mode', code: 'not_rollekatalog_mode' }, { status: 409 });
  }
  const issue = rollekatalogConfigIssue();
  if (issue) return NextResponse.json({ error: 'not_configured', code: issue }, { status: 409 });

  const result = await runSync({ trigger: 'cron' });
  return syncResultResponse(result, false);
});
