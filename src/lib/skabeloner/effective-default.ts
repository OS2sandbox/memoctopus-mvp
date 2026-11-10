// The person's ONE default template, as every response reports it. setCentralDefault leaves the
// personal is_default flag set (the fallback once the central template is withdrawn), so the stored
// rows can carry two defaults: an AVAILABLE central default wins and the personal flags read false;
// an unavailable one is ignored (the personal flag applies again). GET and POST /api/skabeloner and
// PUT /api/skabeloner/[id] answer through here, so no client has to recompute the rule.
import { safeLogError } from '@/lib/audit/safe-log';
import type { Skabelon } from '@/types';
import type { CentralSkabelonSummary } from './central-types';
import { listCentralForUser } from './resolve';
import { getCentralDefaultId } from './server';

/** `central` = the central templates available to the person. The pointer read is fail-soft (logged). */
export async function effectiveDefaults(
  userId: string,
  personal: Skabelon[],
  central: CentralSkabelonSummary[],
): Promise<{ skabeloner: Skabelon[]; centralSkabeloner: CentralSkabelonSummary[] }> {
  let centralDefaultId: string | null = null;
  try {
    centralDefaultId = await getCentralDefaultId(userId);
  } catch (err) {
    safeLogError('skabeloner central default', err);
  }
  const centralDefault = centralDefaultId ? central.find((c) => c.id === centralDefaultId) : undefined;
  return {
    skabeloner: centralDefault ? personal.map((s) => ({ ...s, isDefault: false })) : personal,
    centralSkabeloner: central.map((c) => ({ ...c, isDefault: c.id === centralDefault?.id })),
  };
}

/**
 * One just-saved personal template as the list reports it. Only a flagged row can be masked, so an
 * unflagged one costs no query; a central list that cannot be resolved leaves the flag (as GET does).
 */
export async function effectiveSkabelon(userId: string, skabelon: Skabelon): Promise<Skabelon> {
  if (!skabelon.isDefault) return skabelon;
  let central: CentralSkabelonSummary[] = [];
  try {
    central = await listCentralForUser(userId);
  } catch (err) {
    safeLogError('skabeloner central list', err);
  }
  return (await effectiveDefaults(userId, [skabelon], central)).skabeloner[0];
}
