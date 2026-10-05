// First-administrator bootstrap for LOCAL mode: a way to get the very first
// tt-administrator without touching the database by hand. It is deliberately
// narrow: only while no active administrator exists, only for an allow-listed
// address, and only when the address was asserted by a trusted SSO provider.
import { recordAdminAction } from '@/lib/audit/seam';
import { USABLE_LOCAL_ADMIN_SQL } from './admin-sql';
import { accessSource, bootstrapAdminEmails } from './config';
import type { IdentityClaims } from './identity';
import { defaultRunner, type SqlQueryable, type SqlRunner } from './pg-runner';

export type BootstrapReason =
  | 'granted'
  | 'not_local_mode'
  | 'no_allowlist'
  | 'no_qualifying_identity'
  | 'admin_exists'
  | 'directory_user_disabled';

export interface BootstrapResult {
  granted: boolean;
  reason: BootstrapReason;
}

const ADMIN_ROLE = 'tt-administrator';
// Any constant: it only has to be the same for every bootstrap attempt.
const LOCK_NAME = 'referat:bootstrap-admin';
// Multi-tenant aliases are not a single tenant: any Entra tenant can sign in.
const MULTI_TENANT_ALIASES = new Set(['common', 'organizations', 'consumers']);

function singleTenantId(): string | null {
  const tenant = (process.env.MICROSOFT_TENANT_ID ?? '').trim().toLowerCase();
  return tenant && !MULTI_TENANT_ALIASES.has(tenant) ? tenant : null;
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

  return runner.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [LOCK_NAME]);
    // Re-check under the lock: two concurrent first logins both passed the
    // pre-check above, only the first to get the lock may grant.
    if ((await tx.query(ACTIVE_ADMIN_SQL)).rows.length > 0) return no('admin_exists');

    const directoryUuid = await ensureDirectoryUser(tx, userId);
    if (directoryUuid === null) return no('directory_user_disabled');

    const assignmentId = await grantAdmin(tx, directoryUuid);
    await recordAdminAction(tx, {
      type: 'access.role_assign',
      actorUserId: userId,
      entityType: 'role_assignment',
      entityId: assignmentId,
      secondaryEntityType: 'directory_user',
      secondaryEntityId: directoryUuid,
      details: { roleKey: ADMIN_ROLE, bootstrap: true },
    });
    return { granted: true, reason: 'granted' as const };
  });
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
