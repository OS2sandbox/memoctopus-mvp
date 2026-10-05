// Login-time refresh from Rollekatalog (ACCESS_SOURCE=rollekatalog only).
//
// rolesAsList carries NO org-unit scope, so this check can only take access AWAY:
// it may mark a directory user disabled or delete rollekatalog-sourced role rows
// that Rollekatalog no longer lists. It never inserts or re-enables anything; new
// or restored grants wait for the next bulk sync (which has the scope).
//
// Contract: NEVER throws and stays within a short budget, because it runs on the
// sign-in path. Logs only short codes: no key, URL, response body, name or id.
import { accessSource } from '@/lib/authz/config';
import { defaultRunner, errorLabel, type SqlRunner } from '@/lib/authz/pg-runner';
import { getRolesAsList, type ClientOptions } from './client';
import { loginRefreshTimeoutMs, readKey, rollekatalogUrl } from './config';
import { RollekatalogError, errorCodeOf, isRollekatalogError } from './errors';
import type { RkRolesAsList } from './schemas';

export type LoginRefreshSkipReason = 'not_rollekatalog_mode' | 'not_configured' | 'not_linked';

export type LoginRefreshResult =
  | { status: 'skipped'; reason: LoginRefreshSkipReason }
  /** Rollekatalog answered (or answered 404): `markedDisabled` and `revokedRoles` say what changed. */
  | { status: 'refreshed'; markedDisabled: boolean; revokedRoles: number }
  /** Nothing was changed: the call failed or timed out. `code` is a short code only. */
  | { status: 'error'; code: string };

export interface LoginRefreshDeps {
  runner?: SqlRunner;
  /** Test seam: client options (injected fetch/baseUrl/keys); production reads the env. */
  clientOptions?: ClientOptions;
}

interface LinkedRow {
  uuid: string;
  ext_uuid: string | null;
  ext_user_id: string | null;
  disabled: boolean;
}

/** Below this much remaining budget a second lookup is not worth starting. */
const MIN_SECOND_ATTEMPT_MS = 250;
/** Slack on top of the HTTP budget for the two small SQL statements. */
const DB_SLACK_MS = 1000;

/** The role identifiers a rolesAsList answer grants: SYSTEM role identifiers, what bulk assignments call roleIdentifier. */
export function grantedRoles(answer: Pick<RkRolesAsList, 'systemRoles'>): Set<string> {
  return new Set(answer.systemRoles.map((r) => r.trim().toLowerCase()).filter(Boolean));
}

async function fetchAnswer(
  row: LinkedRow,
  options: ClientOptions,
): Promise<{ answer: RkRolesAsList } | { gone: true }> {
  const started = Date.now();
  const budget = Math.min(options.timeoutMs ?? loginRefreshTimeoutMs(), loginRefreshTimeoutMs());
  const candidates = [row.ext_user_id, row.ext_uuid].filter((v, i, all): v is string => !!v && all.indexOf(v) === i);

  for (let i = 0; i < candidates.length; i++) {
    const remaining = budget - (Date.now() - started);
    if (i > 0 && remaining < MIN_SECOND_ATTEMPT_MS) break;
    try {
      const answer = await getRolesAsList(candidates[i]!, { ...options, timeoutMs: Math.max(remaining, 1), login: true });
      return { answer };
    } catch (err) {
      // A 404 for the userId may only mean it was renamed since the last sync:
      // the uuid is the stable key, so it gets the last word before "gone".
      if (isRollekatalogError(err) && err.code === 'not_found') {
        if (i < candidates.length - 1) continue;
        return { gone: true };
      }
      throw err;
    }
  }
  // Only reachable when a later candidate had no budget left: treat as a timeout.
  throw new RollekatalogError('timeout');
}

async function refresh(userId: string, deps: LoginRefreshDeps): Promise<LoginRefreshResult> {
  if (accessSource() !== 'rollekatalog') return { status: 'skipped', reason: 'not_rollekatalog_mode' };
  // Only the READ key is needed here (the bulk sync additionally needs the ORG key).
  if (rollekatalogUrl().issue !== null || !readKey()) return { status: 'skipped', reason: 'not_configured' };

  const runner = deps.runner ?? defaultRunner();
  const linked = await runner.query<LinkedRow>(
    `SELECT uuid, ext_uuid, ext_user_id, disabled FROM public.directory_users
      WHERE app_user_id = $1 AND source = 'rollekatalog'`,
    [userId],
  );
  const row = linked.rows[0];
  if (!row || (!row.ext_user_id && !row.ext_uuid)) return { status: 'skipped', reason: 'not_linked' };

  let outcome: Awaited<ReturnType<typeof fetchAnswer>>;
  try {
    outcome = await fetchAnswer(row, deps.clientOptions ?? {});
  } catch (err) {
    // Fail safe in the right direction: an outage never revokes (the staleness
    // limit bounds how long old data may keep granting) and never blocks login.
    return { status: 'error', code: errorCodeOf(err) };
  }

  // 404 = unknown or deleted user: Rollekatalog no longer vouches for them.
  // Disabled in Rollekatalog = same effect. Neither is distinguished from a removal.
  if ('gone' in outcome || outcome.answer.disabled) {
    const marked = await markDisabled(runner, row);
    return { status: 'refreshed', markedDisabled: marked, revokedRoles: 0 };
  }

  const granted = [...grantedRoles(outcome.answer)];
  const revoked = await runner.query(
    `DELETE FROM public.role_assignments
      WHERE directory_user_uuid = $1 AND source = 'rollekatalog'
        AND NOT (lower(role_key) = ANY($2::text[]))
      RETURNING id`,
    [row.uuid, granted],
  );
  return { status: 'refreshed', markedDisabled: false, revokedRoles: revoked.rows.length };
}

async function markDisabled(runner: SqlRunner, row: LinkedRow): Promise<boolean> {
  if (row.disabled) return false;
  const res = await runner.query(
    `UPDATE public.directory_users SET disabled = true, updated_at = now()
      WHERE uuid = $1 AND source = 'rollekatalog' AND disabled = false
      RETURNING uuid`,
    [row.uuid],
  );
  return res.rows.length > 0;
}

/**
 * Revokes or disables, never grants. No-op unless ACCESS_SOURCE=rollekatalog, the
 * integration is configured and the user is linked to a Rollekatalog-sourced
 * directory row. Never throws.
 */
export async function refreshUserFromRollekatalog(userId: string, deps: LoginRefreshDeps = {}): Promise<LoginRefreshResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<LoginRefreshResult>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'error', code: 'timeout' }), loginRefreshTimeoutMs() + DB_SLACK_MS);
    timer.unref?.();
  });
  const work = refresh(userId, deps).catch((err: unknown): LoginRefreshResult => {
    console.error(`[authz] login refresh failed (${errorLabel(err)})`);
    return { status: 'error', code: 'unexpected' };
  });
  try {
    const result = await Promise.race([work, deadline]);
    if (result.status === 'error') console.warn(`[authz] login refresh skipped (code ${result.code})`);
    else if (result.status === 'refreshed' && (result.markedDisabled || result.revokedRoles > 0)) {
      console.warn(`[authz] login refresh revoked access (disabled ${result.markedDisabled}, roles ${result.revokedRoles})`);
    }
    return result;
  } catch {
    // Unreachable (both promises resolve); kept so the "never throws" contract is local to this function.
    return { status: 'error', code: 'unexpected' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
