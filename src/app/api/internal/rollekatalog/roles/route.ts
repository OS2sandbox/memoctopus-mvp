import { NextRequest, NextResponse } from 'next/server';
import { withHandler } from '@/lib/api-handler';
import { cronGuard } from '@/lib/audit/internal-auth';
import { runCatalogueRefresh } from '@/lib/rollekatalog/catalogue-sync';
import { catalogueResultResponse } from '@/lib/rollekatalog/catalogue-http';
import { catalogueConfigIssue } from '@/lib/rollekatalog/config';
import { recordIntegrationRun } from '@/lib/rollekatalog/run-audit';

// Refreshes the role/group CATALOGUE (the list a superuser picks from when making a shared
// prompt available to roles) from Rollekatalog. Called by the operator's scheduler with
// INTERNAL_CRON_SECRET, like the user/organisation sync, but independent of ACCESS_SOURCE:
// in claims mode the roles reach the app through the IdP and Rollekatalog is only the list.
// Never forced: only the admin button may bypass the removal threshold. A scheduler that
// outlives its setup (no URL or READ key) gets 409 and nothing runs. A run that ran is one
// integration.sync_run audit event (counts and a code only).
export const POST = withHandler('internal/rollekatalog/roles POST', async (req: NextRequest) => {
  const denied = cronGuard(req);
  if (denied) return denied;

  const issue = catalogueConfigIssue();
  if (issue) return NextResponse.json({ error: 'not_configured', code: issue }, { status: 409 });

  const result = await runCatalogueRefresh({ trigger: 'cron' });
  await recordIntegrationRun({ kind: 'role_catalogue', trigger: 'cron', result });
  return catalogueResultResponse(result, false);
});
