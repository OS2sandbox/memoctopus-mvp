import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { hasCapability, requireCapability, withAuthz } from '@/lib/authz/guard';
import { accessSource } from '@/lib/authz/config';
import { parseWith } from '@/lib/authz/access-http';
import { rollekatalogConfigIssue } from '@/lib/rollekatalog/config';
import { getLatestSyncRun, runSync } from '@/lib/rollekatalog/sync';
import { syncResultResponse } from '@/lib/rollekatalog/sync-http';

const bodySchema = z.object({ force: z.boolean().optional() }).strict();

const NOT_ROLLEKATALOG_MODE = 'Synkronisering er kun tilgængelig, når roller og organisation styres af Rollekatalog.';

/** An absent or blank body means {}; anything else must be JSON. */
async function readBody(req: NextRequest): Promise<{ ok: true; value: unknown } | { ok: false; response: NextResponse }> {
  const text = await req.text();
  if (text.trim() === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: NextResponse.json({ error: 'Ugyldig JSON', code: 'invalid_json' }, { status: 400 }) };
  }
}

// Latest run summary. sync.run for the admin panel, access.manage so the read-only
// user/organisation views can show "last synchronised". Counts and codes only.
export const GET = withAuthz('admin/access/sync GET', null, async (_req, { principal }) => {
  if (!hasCapability(principal, 'access.manage')) {
    const denied = requireCapability(principal, 'sync.run');
    if (denied) return denied;
  }
  const run = await getLatestSyncRun();
  return NextResponse.json(
    { run, source: accessSource(), configIssue: rollekatalogConfigIssue() },
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
  const raw = await readBody(req);
  if (!raw.ok) return raw.response;
  const parsed = parseWith(bodySchema, raw.value);
  if (!parsed.ok) return parsed.response;

  const result = await runSync({ trigger: 'manual', force: parsed.data.force === true, actorUserId: principal.userId });
  return syncResultResponse(result, true);
});
