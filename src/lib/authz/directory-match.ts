// Links a logged-in SSO user to a Rollekatalog-synced directory_users row.
// ROLLEKATALOG MODE ONLY. In local mode links are made explicitly by an admin
// (directory_users.app_user_id) and must never be inferred from claims: an
// attacker could password-sign-up with a pre-assigned address.
import { recordAdminAction } from '@/lib/audit/seam';
import {
  accessSource,
  directoryMatchMode,
  directoryUserIdClaim,
  directoryUserIdTransform,
  singleTenantId,
  transformUserId,
  type DirectoryMatchMode,
} from './config';
import type { ExternalIdentity } from './identity';
import { defaultRunner, type SqlQueryable, type SqlRunner } from './pg-runner';

export type MatchStatus =
  | 'linked'
  | 'already_linked'
  | 'no_match'
  | 'ambiguous'
  | 'conflict'
  | 'refused'
  | 'skipped';

export interface MatchResult {
  status: MatchStatus;
  directoryUserUuid?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNIQUE_VIOLATION = '23505';

interface Candidate {
  uuid: string;
  app_user_id: string | null;
}

type Lookup = { sql: string; param: string } | null;

function lookupFor(identity: ExternalIdentity, mode: DirectoryMatchMode): Lookup | 'refused' {
  const claims = identity.claims as Record<string, unknown>;
  const clean = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

  // Only rows that Rollekatalog itself synced are link targets here. Disabled rows keep
  // their ext_user_id, so a reused userId would otherwise make the new person ambiguous.
  const base = `SELECT uuid, app_user_id FROM public.directory_users WHERE source = 'rollekatalog' AND disabled = false AND `;

  if (mode === 'userid-claim') {
    // e.g. a UPN claim "abc123@kommune.dk" against Rollekatalog's plain userId "abc123".
    const raw = clean(claims[directoryUserIdClaim()]);
    const value = raw ? clean(transformUserId(raw)) : null;
    return value ? { sql: `${base}lower(ext_user_id) = lower($1) LIMIT 2 FOR UPDATE`, param: value } : null;
  }
  if (mode === 'extuuid-claim') {
    const value = clean(claims[directoryUserIdClaim()]);
    // A non-uuid would make the ::uuid comparison throw; it cannot match anyway.
    return value && UUID_RE.test(value) ? { sql: `${base}ext_uuid = $1::uuid LIMIT 2 FOR UPDATE`, param: value } : null;
  }
  // 'email': an unverified address is attacker-chosen at many IdPs.
  if (claims.email_verified !== true) return 'refused';
  const email = clean(claims.email);
  return email ? { sql: `${base}lower(email) = lower($1) LIMIT 2 FOR UPDATE`, param: email } : null;
}

export async function matchDirectoryUser(
  identity: ExternalIdentity,
  mode: DirectoryMatchMode = directoryMatchMode(),
  runner: SqlRunner = defaultRunner(),
): Promise<MatchResult> {
  if (accessSource() !== 'rollekatalog') return { status: 'skipped' };
  // Email/password "identities" are self-asserted; only trusted SSO may link.
  if (!identity.providerId || identity.providerId === 'credential') return { status: 'refused' };

  // strip-upn-domain throws the tenant boundary away (alice@evil.example -> alice), so a
  // Microsoft login may only be matched that way when it provably comes from our one tenant.
  if (directoryUserIdTransform() === 'strip-upn-domain' && identity.providerId === 'microsoft') {
    const tenant = singleTenantId();
    const tid = (identity.claims as Record<string, unknown>).tid;
    if (tenant === null || typeof tid !== 'string' || tid.trim().toLowerCase() !== tenant) return { status: 'refused' };
  }

  const lookup = lookupFor(identity, mode);
  if (lookup === 'refused') return { status: 'refused' };
  if (!lookup) return { status: 'no_match' };

  try {
    return await runner.transaction(async (tx) => {
      const found = await tx.query<Candidate>(lookup.sql, [lookup.param]);
      // Ambiguity is never resolved by picking one: linking the wrong person
      // would hand them someone else's roles.
      if (found.rows.length > 1) return { status: 'ambiguous' as const };
      const target = found.rows[0];
      if (!target) return { status: 'no_match' as const };

      if (target.app_user_id === identity.userId) {
        return { status: 'already_linked' as const, directoryUserUuid: target.uuid };
      }
      if (target.app_user_id !== null) return conflict('target_linked_to_other_user');

      // app_user_id is unique, so a user can hold one link only. An existing link
      // to a source='local' row is a leftover from before the switch to
      // rollekatalog mode (those rows are ignored there): it is moved to the
      // Rollekatalog row in this one transaction. A link to anything else
      // (another Rollekatalog row, or one we cannot classify) is never touched.
      const own = await tx.query<{ uuid: string; source: string }>(
        'SELECT uuid, source FROM public.directory_users WHERE app_user_id = $1',
        [identity.userId],
      );
      const ownRow = own.rows[0];
      if (ownRow) {
        if (ownRow.source !== 'local') return conflict('user_linked_to_other_entry');
        // The guard repeats the ownership check on the row lock, so a concurrent
        // login that already moved this link makes this release a no-op => conflict.
        const released = await tx.query(
          `UPDATE public.directory_users SET app_user_id = NULL, updated_at = now()
            WHERE uuid = $1 AND source = 'local' AND app_user_id = $2
            RETURNING uuid`,
          [ownRow.uuid, identity.userId],
        );
        if (released.rows.length === 0) return conflict('user_linked_to_other_entry');
      }

      const updated = await linkRow(tx, target.uuid, identity.userId);
      if (updated.rows.length === 0) return conflict('target_linked_to_other_user');

      await recordAdminAction(tx, {
        type: 'access.user_link',
        actorUserId: identity.userId,
        entityType: 'directory_user',
        entityId: target.uuid,
        details: { via: mode, automatic: true },
      });
      return { status: 'linked' as const, directoryUserUuid: target.uuid };
    });
  } catch (err) {
    // A concurrent login of the same user can still trip the unique index.
    if ((err as { code?: unknown } | null)?.code === UNIQUE_VIOLATION) {
      return conflict('unique_violation');
    }
    throw err;
  }
}

function linkRow(tx: SqlQueryable, directoryUuid: string, userId: string) {
  return tx.query(
    `UPDATE public.directory_users SET app_user_id = $1, updated_at = now()
      WHERE uuid = $2 AND (app_user_id IS NULL OR app_user_id = $1)
      RETURNING uuid`,
    [userId, directoryUuid],
  );
}

function conflict(code: string): MatchResult {
  // Code only: never the claim value or either user id.
  console.warn(`[authz] directory link conflict (code ${code})`);
  return { status: 'conflict' };
}
