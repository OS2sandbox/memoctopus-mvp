import { NextResponse } from 'next/server';
import { withAuthz } from '@/lib/authz/guard';
import { defaultRunner } from '@/lib/authz/pg-runner';
import { runRollekatalogCheck } from '@/lib/rollekatalog/check';

/** The admin's own Rollekatalog user id for the rolesAsList probe; null when they are not linked. */
async function ownRollekatalogUserId(directoryUserUuid: string | null): Promise<string | null> {
  if (!directoryUserUuid) return null;
  try {
    const r = await defaultRunner().query<{ ext_user_id: string | null; ext_uuid: string | null }>(
      `SELECT ext_user_id, ext_uuid FROM public.directory_users WHERE uuid = $1 AND source = 'rollekatalog'`,
      [directoryUserUuid],
    );
    const row = r.rows[0];
    return row?.ext_user_id || row?.ext_uuid || null;
  } catch {
    return null;
  }
}

// "Test forbindelse". Deliberately not tied to ACCESS_SOURCE: an operator should be
// able to verify the configuration BEFORE switching modes. The report holds status
// codes, short error codes, counts and flags only (see check.ts). The rolesAsList probe
// uses the caller's own user, because every successful call leaves an audit row in
// Rollekatalog and it should be the person pressing the button.
export const POST = withAuthz('admin/access/rollekatalog/check POST', 'sync.run', async (_req, { principal }) => {
  const rolesAsListUserId = await ownRollekatalogUserId(principal.directoryUserUuid);
  const report = await runRollekatalogCheck({ rolesAsListUserId });
  return NextResponse.json(report, { headers: { 'Cache-Control': 'no-store' } });
});
