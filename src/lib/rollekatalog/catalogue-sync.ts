// Refreshes the role/group CATALOGUE (public.external_roles, source 'rollekatalog') from
// Rollekatalog's read API. The catalogue is what a superuser picks from when making a shared
// prompt available to roles or groups; it holds names and identifiers only (schemas.ts), never
// a person. Read-only towards Rollekatalog: GETs with the READ key.
//
// Safety nets, all fail-closed, like the user/organisation sync:
//   - a non-blocking advisory lock: a concurrent run answers 'already_running'
//   - everything is fetched first; a failed or partial fetch never touches the table
//   - empty-response guard: no roles and no groups aborts ('empty_response')
//   - removal threshold: deactivating unusually many entries aborts ('removal_threshold')
//     unless forced (the admin button)
//   - rows are never DELETED: an entry that left Rollekatalog is deactivated, so a prompt that
//     targets it (central_template_principal_targets, RESTRICT) and the people's role rows
//     (user_external_roles) keep their reference; a deactivated entry matches nobody.
//   - only rows with source='rollekatalog' are written; a 'config' entry with the same key wins.
// The run is not audited and leaves no sync_runs row (that is the user/org sync's status
// panel); `external_roles.synced_at` tells when it last ran. Failures surface as short codes.
import { createRunner, errorLabel } from '@/lib/authz/pg-runner';
import { createRollekatalogClient, type RollekatalogClient } from './client';
import { catalogueConfigIssue, syncMaxRemovalPercent } from './config';
import { errorCodeOf } from './errors';
import { tryAdvisoryLock, exceedsRemovalThreshold, type Lock } from './sync';
import { defaultSyncEnv, queryOnce, tbl, type SyncEnv } from './sync-run';

export interface CatalogueRefreshCounts {
  /** Entries in the answer (roles + groups, after dropping bad rows and duplicates). */
  fetched: number;
  /** Entries that are new in the catalogue. */
  added: number;
  /** Entries that were already known (name refreshed, reactivated if they had been withdrawn). */
  updated: number;
  /** Entries that are no longer in Rollekatalog and were deactivated. */
  deactivated: number;
  /** Rows dropped from the answer: invalid or duplicate. */
  skipped: number;
}

export const emptyCatalogueCounts = (): CatalogueRefreshCounts => ({
  fetched: 0,
  added: 0,
  updated: 0,
  deactivated: 0,
  skipped: 0,
});

export type CatalogueRefreshStatus = 'success' | 'aborted' | 'error' | 'already_running';

export interface CatalogueRefreshResult {
  status: CatalogueRefreshStatus;
  counts: CatalogueRefreshCounts;
  /** A RollekatalogErrorCode, 'empty_response', 'removal_threshold', 'not_configured', 'db_error', 'unexpected', ...; null on success. */
  errorCode: string | null;
}

export interface CatalogueRefreshOptions {
  trigger: 'cron' | 'manual';
  /** Bypass the removal threshold (admin button). The empty-response guard still applies. */
  force?: boolean;
}

export interface CatalogueRefreshDeps {
  /** Test seam: the database (schema and connections). Production uses the app pool and `public`. */
  env?: SyncEnv;
  /** Test seam: the Rollekatalog client. Production reads URL, keys and limits from the environment. */
  client?: Pick<RollekatalogClient, 'getRoleCatalogue'>;
}

class CatalogueAbort extends Error {
  constructor(readonly code: 'empty_response' | 'removal_threshold') {
    super(code);
  }
}

// One lock per schema, so the throwaway schemas of the Postgres test lane never block each other.
const lockKey = (env: SyncEnv): string => `os2taletiltekst.rollekatalog.catalogue:${env.schema}`;

/** Removing up to this many entries never trips the threshold: a catalogue of 8 roles may lose 3. */
const REMOVAL_ALLOWANCE = 3;

interface Entry {
  kind: 'role' | 'group';
  identifier: string;
  name: string;
}

async function apply(env: SyncEnv, entries: Entry[], force: boolean): Promise<CatalogueRefreshCounts> {
  const runner = createRunner({ query: (text, params) => queryOnce(env, text, params) }, () => env.connect());
  const t = (table: string) => tbl(env, table);
  const kinds = entries.map((e) => e.kind);
  const identifiers = entries.map((e) => e.identifier);
  const names = entries.map((e) => e.name);

  return runner.transaction(async (tx) => {
    // What would leave, judged before anything is written.
    const base = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${t('external_roles')} WHERE source = 'rollekatalog' AND active`,
    );
    const gone = await tx.query<{ kind: string; identifier: string }>(
      `SELECT e.kind, e.identifier FROM ${t('external_roles')} e
        WHERE e.source = 'rollekatalog' AND e.active
          AND NOT EXISTS (
            SELECT 1 FROM unnest($1::text[], $2::text[]) AS c(kind, identifier)
             WHERE c.kind = e.kind AND c.identifier = e.identifier)`,
      [kinds, identifiers],
    );
    const activeBefore = base.rows[0]?.n ?? 0;
    if (
      !force &&
      gone.rows.length > REMOVAL_ALLOWANCE &&
      exceedsRemovalThreshold(gone.rows.length, activeBefore, syncMaxRemovalPercent())
    ) {
      console.warn(`[rollekatalog] catalogue refresh aborted code=removal_threshold removed=${gone.rows.length}/${activeBefore}`);
      throw new CatalogueAbort('removal_threshold');
    }

    // The entries that stay: written (new) or refreshed (known). Only this source's rows;
    // xmax = 0 is true only for a freshly inserted row.
    const upserted = await tx.query<{ inserted: boolean }>(
      `INSERT INTO ${t('external_roles')} AS e (kind, identifier, name, source, active, synced_at)
       SELECT c.kind, c.identifier, c.name, 'rollekatalog', true, now()
         FROM unnest($1::text[], $2::text[], $3::text[]) AS c(kind, identifier, name)
       ON CONFLICT (kind, identifier) DO UPDATE
         SET name = EXCLUDED.name, active = true, synced_at = now()
         WHERE e.source = 'rollekatalog'
       RETURNING (xmax = 0) AS inserted`,
      [kinds, identifiers, names],
    );
    await tx.query(
      `UPDATE ${t('external_roles')} e SET active = false, synced_at = now()
        WHERE e.source = 'rollekatalog' AND e.active
          AND NOT EXISTS (
            SELECT 1 FROM unnest($1::text[], $2::text[]) AS c(kind, identifier)
             WHERE c.kind = e.kind AND c.identifier = e.identifier)`,
      [kinds, identifiers],
    );

    const added = upserted.rows.filter((r) => r.inserted).length;
    return { fetched: entries.length, added, updated: upserted.rows.length - added, deactivated: gone.rows.length, skipped: 0 };
  });
}

/**
 * Runs one catalogue refresh. Never throws: every outcome is a result. A run that aborted or
 * failed changed nothing, so its counts stay zero.
 */
export async function runCatalogueRefresh(
  opts: CatalogueRefreshOptions,
  deps: CatalogueRefreshDeps = {},
): Promise<CatalogueRefreshResult> {
  const env = deps.env ?? defaultSyncEnv();
  let lock: Lock | null = null;
  try {
    const issue = catalogueConfigIssue();
    if (issue) return { status: 'error', counts: emptyCatalogueCounts(), errorCode: issue };

    lock = await tryAdvisoryLock(env, lockKey(env));
    if (!lock) return { status: 'already_running', counts: emptyCatalogueCounts(), errorCode: 'already_running' };

    const client = deps.client ?? createRollekatalogClient();
    const { roles, groups } = await client.getRoleCatalogue();
    const entries: Entry[] = [...roles.entries, ...groups.entries];
    // Checked before any write: an empty answer must never become "every role was withdrawn".
    if (entries.length === 0) throw new CatalogueAbort('empty_response');

    const counts = await apply(env, entries, opts.force === true).catch((err: unknown) => {
      if (err instanceof CatalogueAbort) throw err;
      console.warn(`[rollekatalog] catalogue refresh apply failed (${errorLabel(err)})`);
      throw new DbFailure();
    });
    counts.skipped = roles.skipped + groups.skipped;
    return { status: 'success', counts, errorCode: null };
  } catch (err) {
    const aborted = err instanceof CatalogueAbort;
    const code = aborted ? err.code : err instanceof DbFailure ? 'db_error' : errorCodeOf(err);
    console.warn(`[rollekatalog] catalogue refresh ${aborted ? 'aborted' : 'error'} code=${code}`);
    return { status: aborted ? 'aborted' : 'error', counts: emptyCatalogueCounts(), errorCode: code };
  } finally {
    if (lock) await lock.release().catch(() => {});
  }
}

class DbFailure extends Error {}
