import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { directoryUsers, roleAssignments } from '@/lib/db/schema';
import { buildPrincipalFromAssignments } from './capabilities';
import { accessSource, requireRoleToLogin } from './config';
import type { Principal, RoleAssignmentRow } from './types';

type AssignmentSourceRow = RoleAssignmentRow & { source: string };

// TODO(phase3): this is the one place where rollekatalog-sourced rows that are
// older than the staleness limit must be dropped (elevated capabilities go,
// baseline template.use stays). Until then every source is trusted as-is.
function dropStaleAssignments(rows: AssignmentSourceRow[]): AssignmentSourceRow[] {
  // In rollekatalog mode Rollekatalog is the only authority and every local
  // write endpoint answers 409, so a leftover source='local' grant (e.g. an
  // admin from before the switch) could never be revoked in the app. Ignore it
  // instead of letting it keep granting access.
  if (accessSource() === 'rollekatalog') return rows.filter((r) => r.source !== 'local');
  return rows;
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
    })
    .from(directoryUsers)
    .leftJoin(roleAssignments, eq(roleAssignments.directoryUserUuid, directoryUsers.uuid))
    .where(eq(directoryUsers.appUserId, userId));

  const directoryUserUuid = rows[0]?.directoryUserUuid ?? null;
  const disabled = rows.some((r) => r.disabled);

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
            },
          ],
    ),
  );

  return buildPrincipalFromAssignments({
    userId,
    directoryUserUuid,
    disabled,
    assignments,
    now: new Date(),
    requireRoleToLogin: requireRoleToLogin(),
    source: assignments.some((a) => a.source === 'rollekatalog') ? 'rollekatalog' : 'local',
  });
}
