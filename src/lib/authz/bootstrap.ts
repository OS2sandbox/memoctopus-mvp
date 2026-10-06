// First-administrator bootstrap for LOCAL mode: a way to get the very first
// tt-administrator without touching the database by hand. It is deliberately
// narrow: ONE-SHOT, only while no active administrator exists, only for an
// allow-listed address, and only when the address was asserted by a trusted SSO
// provider.
//
// One-shot: a successful grant writes the flag 'bootstrap_admin_done' into
// public.system_flags in the SAME transaction and under the SAME advisory lock as
// the grant. While that flag exists nothing is ever granted, so
// BOOTSTRAP_ADMIN_EMAILS is not a standing backdoor that re-arms whenever the
// last administrator is removed. Two concurrent first logins still produce one
// grant and one flag.
//
// RECOVERY after locking everyone out (an operator, by SQL):
//   DELETE FROM system_flags WHERE key = 'bootstrap_admin_done';
// which re-arms the bootstrap for the next allow-listed SSO login, or insert a
// role_assignments row by hand.
import { recordEvent } from '@/lib/audit/record';
import { ADMIN_LOCK_NAME, ADMIN_ROLE, USABLE_LOCAL_ADMIN_SQL } from './admin-sql';
import { accessSource, bootstrapAdminEmails, singleTenantId } from './config';
import type { IdentityClaims } from './identity';
import { defaultRunner, type SqlQueryable, type SqlRunner } from './pg-runner';

type BootstrapReason =
  | 'granted'
  | 'not_local_mode'
  | 'no_allowlist'
  | 'no_qualifying_identity'
  | 'admin_exists'
  | 'already_bootstrapped'
  | 'directory_user_disabled';

interface BootstrapResult {
  granted: boolean;
  reason: BootstrapReason;
}

/** Pure rule table: does this SSO identity prove ownership of an allow-listed address? */
export function identityQualifies(
  providerId: string,
  claims: IdentityClaims,
  allowlist: readonly string[],
): boolean {
  if (providerId === 'credential') return false;
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!email || !allowlist.includes(email)) return false;

  if (providerId === 'microsoft') {
    // Entra rarely sets email_verified; trust comes from the tenant being ours.
    const tenant = singleTenantId();
    return tenant !== null && typeof claims.tid === 'string' && claims.tid.trim().toLowerCase() === tenant;
  }
  return claims.email_verified === true;
}

interface IdentityRow {
  provider_id: string;
  claims: IdentityClaims | string | null;
}

function parseClaims(raw: IdentityRow['claims']): IdentityClaims {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as IdentityClaims;
    } catch {
      return {};
    }
  }
  return raw;
}

const ACTIVE_ADMIN_SQL = `SELECT 1 FROM public.role_assignments ra
   JOIN public.directory_users du ON du.uuid = ra.directory_user_uuid
   WHERE ${USABLE_LOCAL_ADMIN_SQL}
   LIMIT 1`;

/** system_flags key: present once the one-shot bootstrap grant has happened. */
export const BOOTSTRAP_FLAG_KEY = 'bootstrap_admin_done';

const FLAG_EXISTS_SQL = 'SELECT 1 FROM public.system_flags WHERE key = $1';

/** Thrown inside the grant transaction to roll the grant back when the flag could not be claimed. */
class FlagTakenError extends Error {}

export async function maybeBootstrapAdmin(
  userId: string,
  runner: SqlRunner = defaultRunner(),
): Promise<BootstrapResult> {
  const no = (reason: BootstrapReason): BootstrapResult => ({ granted: false, reason });

  if (accessSource() !== 'local') return no('not_local_mode');
  const allowlist = bootstrapAdminEmails();
  if (allowlist.length === 0) return no('no_allowlist');

  // Cheap pre-check without the lock: the common case is "an admin exists".
  if ((await runner.query(ACTIVE_ADMIN_SQL)).rows.length > 0) return no('admin_exists');

  // One-shot: once the flag is set the bootstrap is spent, whatever the admin situation.
  if ((await runner.query(FLAG_EXISTS_SQL, [BOOTSTRAP_FLAG_KEY])).rows.length > 0) return no('already_bootstrapped');

  // Only identities whose provider account still exists count; the EXISTS keeps a
  // stale snapshot from outliving an unlinked SSO account.
  const identities = await runner.query<IdentityRow>(
    `SELECT ei.provider_id, ei.claims FROM public.external_identities ei
      WHERE ei.user_id = $1 AND ei.provider_id <> 'credential'
        AND EXISTS (SELECT 1 FROM public.accounts a
                     WHERE a.user_id = ei.user_id AND a.provider_id = ei.provider_id)`,
    [userId],
  );
  const qualifies = identities.rows.some((r) =>
    identityQualifies(r.provider_id, parseClaims(r.claims), allowlist),
  );
  if (!qualifies) return no('no_qualifying_identity');

  try {
    return await runner.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ADMIN_LOCK_NAME]);
      // Re-check under the lock: two concurrent first logins both passed the
      // pre-checks above, only the first to get the lock may grant.
      if ((await tx.query(ACTIVE_ADMIN_SQL)).rows.length > 0) return no('admin_exists');
      if ((await tx.query(FLAG_EXISTS_SQL, [BOOTSTRAP_FLAG_KEY])).rows.length > 0) return no('already_bootstrapped');

      const directoryUuid = await ensureDirectoryUser(tx, userId);
      if (directoryUuid === null) return no('directory_user_disabled');

      const assignmentId = await grantAdmin(tx, directoryUuid);

      // Same transaction, same lock as the grant: a failure here rolls the grant back.
      const flag = await tx.query(
        'INSERT INTO public.system_flags (key) VALUES ($1) ON CONFLICT (key) DO NOTHING RETURNING key',
        [BOOTSTRAP_FLAG_KEY],
      );
      if (flag.rows.length === 0) throw new FlagTakenError();

      await recordEvent({
        type: 'access.role_assign',
        actorUserId: userId,
        entityType: 'role_assignment',
        entityId: assignmentId,
        secondaryEntityType: 'directory_user',
        secondaryEntityId: directoryUuid,
        details: { roleKey: ADMIN_ROLE, bootstrap: true },
      }, { tx });
      return { granted: true, reason: 'granted' as const };
    });
  } catch (err) {
    // The flag appeared meanwhile (set without our lock): the grant was rolled back.
    if (err instanceof FlagTakenError) return no('already_bootstrapped');
    throw err;
  }
}

/** Returns the directory user uuid for the app user, creating a local row if missing; null if that user is disabled. */
async function ensureDirectoryUser(tx: SqlQueryable, userId: string): Promise<string | null> {
  const existing = await tx.query<{ uuid: string; disabled: boolean }>(
    'SELECT uuid, disabled FROM public.directory_users WHERE app_user_id = $1',
    [userId],
  );
  if (existing.rows[0]) return existing.rows[0].disabled ? null : existing.rows[0].uuid;

  const created = await tx.query<{ uuid: string }>(
    `INSERT INTO public.directory_users (name, email, source, app_user_id)
     SELECT name, email, 'local', id FROM public.users WHERE id = $1
     RETURNING uuid`,
    [userId],
  );
  const uuid = created.rows[0]?.uuid;
  if (!uuid) throw new Error('bootstrap: app user vanished');
  return uuid;
}

async function grantAdmin(tx: SqlQueryable, directoryUuid: string): Promise<string> {
  // An expired/future leftover row would collide with the unique key, so revive it
  // instead of inserting. Explicit lookup (not ON CONFLICT) keeps NULL-scope handling obvious.
  const old = await tx.query<{ id: string }>(
    `SELECT id FROM public.role_assignments
      WHERE directory_user_uuid = $1 AND role_key = '${ADMIN_ROLE}'
        AND scope_org_unit_uuid IS NULL AND source = 'local'`,
    [directoryUuid],
  );
  if (old.rows[0]) {
    await tx.query(
      'UPDATE public.role_assignments SET start_date = NULL, stop_date = NULL WHERE id = $1',
      [old.rows[0].id],
    );
    return old.rows[0].id;
  }
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO public.role_assignments
       (directory_user_uuid, role_key, scope_org_unit_uuid, include_descendants, source, created_by_user_id)
     VALUES ($1, '${ADMIN_ROLE}', NULL, true, 'local', NULL)
     RETURNING id`,
    [directoryUuid],
  );
  return inserted.rows[0].id;
}
