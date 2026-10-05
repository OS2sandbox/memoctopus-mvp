import { NextRequest, NextResponse } from 'next/server';
import { withHandler } from '@/lib/api-handler';
import { auditRetentionDays } from '@/lib/audit/config';
import { cronGuard } from '@/lib/audit/feed-auth';
import { pruneAuditEvents } from '@/lib/audit/prune';

// Called by the operator's scheduler (cron, k8s CronJob) with INTERNAL_CRON_SECRET.
// pruneAuditEvents records the audit.prune system event itself, so it is not
// recorded again here.
export const POST = withHandler('internal/audit/prune POST', async (req: NextRequest) => {
  const denied = cronGuard(req);
  if (denied) return denied;

  const retentionDays = auditRetentionDays();
  if (retentionDays === null) return NextResponse.json({ pruned: 0, disabled: true });

  const pruned = await pruneAuditEvents({ olderThanDays: retentionDays });
  return NextResponse.json({ pruned, retentionDays });
});
