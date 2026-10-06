import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { directoryUsers, roleAssignments } from '@/lib/db/schema';
import { buildPrincipalFromAssignments } from './capabilities';
import { roleStaleMaxSeconds } from '@/lib/rollekatalog/config';
import { accessSource, requireRoleToLogin, type AccessSource } from './config';
import type { Principal, RoleAssignmentRow } from './types';

export type AssignmentSourceRow = RoleAssignmentRow & { source: string; syncedAt?: Date | null };

interface StaleOptions {
  now: Date;
  mode: AccessSource;
  maxAgeSeconds: number;
}

/**
 * The one place that decides which stored grants may count. Pure.
 *
 * - rollekatalog mode: Rollekatalog is the only authority and every local write
 *   endpoint answers 409, so a leftover source='local' grant (e.g. an admin from
 *   before the switch) could never be revoked in the app: ignored.
 * - local mode, the mirror image: a source='rollekatalog' row cannot be edited or
 *   revoked there, so it must not keep granting access: ignored.
 * - rollekatalog rows whose synced_at is older than the limit (or missing or
 *   unreadable) are ignored: if the sync stops, elevated capabilities vanish
 *   instead of lingering forever. The baseline tt-bruger is implicit and stays.
 *   Exactly at the limit still counts.
 */
export function dropStaleAssignments(rows: AssignmentSourceRow[], opts: StaleOptions): AssignmentSourceRow[] {
  // Fail closed: a source other than the two the DB CHECK allows counts as nothing.
  if (opts.mode === 'local') return rows.filter((r) => r.source === 'local');
  const limitMs = opts.maxAgeSeconds * 1000;
  return rows.filter((r) => {
    if (r.source !== 'rollekatalog' || !r.syncedAt) return false;
    // Negated <= so that an invalid date (NaN) counts as stale.
    return opts.now.getTime() - r.syncedAt.getTime() <= limitMs;
  });
}

/**
 * Loads the caller's directory row (linked directly via app_user_id, never by
 * email) and its role assignments, then resolves them with the pure resolver.
 *
 * Deliberately NO in-process cache: roles are read live on every call so a
 * revoked role or a disabled user takes effect on the very next request.
 *
 * A user without a directory row still gets the baseline principal.
 */
export async function resolvePrincipal(userId: string): Promise<Principal> {
  const rows = await db
    .select({
      directoryUserUuid: directoryUsers.uuid,
      disabled: directoryUsers.disabled,
      roleKey: roleAssignments.roleKey,
      scopeOrgUnitUuid: roleAssignments.scopeOrgUnitUuid,
      includeDescendants: roleAssignments.includeDescendants,
      startDate: roleAssignments.startDate,
      stopDate: roleAssignments.stopDate,
      source: roleAssignments.source,
      syncedAt: roleAssignments.syncedAt,
    })
    .from(directoryUsers)
    .leftJoin(roleAssignments, eq(roleAssignments.directoryUserUuid, directoryUsers.uuid))
    .where(eq(directoryUsers.appUserId, userId));

  const directoryUserUuid = rows[0]?.directoryUserUuid ?? null;
  const disabled = rows.some((r) => r.disabled);

  const now = new Date();
  const assignments = dropStaleAssignments(
    rows.flatMap((r) =>
      r.roleKey === null || r.includeDescendants === null || r.source === null
        ? []
        : [
            {
              roleKey: r.roleKey,
              scopeOrgUnitUuid: r.scopeOrgUnitUuid,
              includeDescendants: r.includeDescendants,
              startDate: r.startDate,
              stopDate: r.stopDate,
              source: r.source,
              syncedAt: r.syncedAt,
            },
          ],
    ),
    { now, mode: accessSource(), maxAgeSeconds: roleStaleMaxSeconds() },
  );

  return buildPrincipalFromAssignments({
    userId,
    directoryUserUuid,
    disabled,
    assignments,
    now,
    requireRoleToLogin: requireRoleToLogin(),
    source: assignments.some((a) => a.source === 'rollekatalog') ? 'rollekatalog' : 'local',
  });
}
