import { NextResponse } from 'next/server';
import { hasCapability, requireCapability, withAuthz } from '@/lib/authz/guard';
import { accessSource } from '@/lib/authz/config';
import { forceBodySchema, parseWith, readOptionalJsonBody } from '@/lib/authz/access-http';
import { itSystemId, rollekatalogConfigIssue } from '@/lib/rollekatalog/config';
import { runSync } from '@/lib/rollekatalog/sync';
import { getLatestSyncRun } from '@/lib/rollekatalog/sync-run';
import { syncResultResponse } from '@/lib/rollekatalog/sync-http';

const NOT_ROLLEKATALOG_MODE = 'Synkronisering er kun tilgængelig, når roller og organisation styres af Rollekatalog.';

// Latest run summary. sync.run for the admin panel, access.manage so the read-only
// user/organisation views can show "last synchronised". Counts and codes only.
export const GET = withAuthz('admin/access/sync GET', null, async (_req, { principal }) => {
  if (!hasCapability(principal, 'access.manage')) {
    const denied = requireCapability(principal, 'sync.run');
    if (denied) return denied;
  }
  const run = await getLatestSyncRun();
  const source = accessSource();
  return NextResponse.json(
    // itSystem is the identifier of the IT system the roles live under in Rollekatalog (shown to
    // administrators so they know where to assign roles). Not a secret; null outside Rollekatalog mode.
    { run, source, configIssue: rollekatalogConfigIssue(), itSystem: source === 'rollekatalog' ? itSystemId() : null },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});

// The admin button ("Synkroniser nu"). Only meaningful when Rollekatalog owns the
// data (the mirror is ignored in local mode). The mode is checked after the
// capability, so a caller without access learns nothing about it.
export const POST = withAuthz('admin/access/sync POST', 'sync.run', async (req, { principal }) => {
  if (accessSource() !== 'rollekatalog') {
    return NextResponse.json({ error: NOT_ROLLEKATALOG_MODE, code: 'not_rollekatalog_mode' }, { status: 409 });
  }
  const raw = await readOptionalJsonBody(req);
  if (!raw.ok) return raw.response;
  const parsed = parseWith(forceBodySchema, raw.value);
  if (!parsed.ok) return parsed.response;

  const result = await runSync({ trigger: 'manual', force: parsed.data.force === true, actorUserId: principal.userId });
  return syncResultResponse(result, true);
});
