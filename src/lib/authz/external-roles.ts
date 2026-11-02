// The role/group CATALOGUE (public.external_roles): the only role and group values the
// app stores for a person (public.user_external_roles) and the only ones a shared prompt
// can be targeted at. It is filled from a source: today the optional `catalogue` section
// of AUTH_CONFIG_FILE (source 'config', so an installation without Rollekatalog works),
// later the Rollekatalog's role list (source 'rollekatalog', written by its own sync).
//
// A config entry wins over a Rollekatalog row with the same key (it takes the row over), and an
// entry that leaves the file is DEACTIVATED, not deleted, so a prompt that still targets it
// keeps the reference (the person simply stops matching it at their next login).
import { authConfigCatalogue, authConfigCatalogueState, type CatalogueEntry, type CatalogueState } from '@/lib/auth/providers';
import { defaultRunner, errorLabel, type SqlRunner } from './pg-runner';

export interface CatalogueSyncResult {
  /** Entries written (inserted or refreshed). */
  upserted: number;
  /** Config entries that are no longer in the file and were marked inactive. */
  deactivated: number;
  /** Why nothing was changed: the section was unusable, or empty while the file did not say 'absent'. */
  skipped?: 'invalid' | 'empty';
}

/**
 * Loads the config catalogue into public.external_roles.
 *
 * What may be DEACTIVATED is guarded, because deactivating drops people's stored values at their next login and
 * unlinks nothing a prompt targets, but a wrong guess is costly: an unreadable or invalid file (a missing mount, a
 * typo, a half-written edit) must never wipe the catalogue, and an EMPTY list only deactivates when the file
 * says so by having no catalogue section at all ('absent'). With state 'invalid' nothing is written.
 */
export async function syncConfigCatalogue(
  entries: readonly CatalogueEntry[] = authConfigCatalogue(),
  runner: SqlRunner = defaultRunner(),
  state: CatalogueState = authConfigCatalogueState(),
): Promise<CatalogueSyncResult> {
  if (state === 'invalid') {
    console.warn('[authz] config catalogue is invalid or unreadable; the stored catalogue is left as it is');
    return { upserted: 0, deactivated: 0, skipped: 'invalid' };
  }
  if (entries.length === 0 && state !== 'absent') {
    console.warn('[authz] config catalogue is empty; the stored catalogue is left as it is (remove the section to deactivate it)');
    return { upserted: 0, deactivated: 0, skipped: 'empty' };
  }
  const kinds = entries.map((e) => e.kind);
  const identifiers = entries.map((e) => e.identifier);
  const names = entries.map((e) => e.name);

  return runner.transaction(async (tx) => {
    // One writer at a time: two instances starting together must not interleave their sets.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['referat:external-roles-config']);

    // Config wins: a Rollekatalog row with the same key is taken over, so the entry stays active while the file lists it.
    const upserted = await tx.query(
      `INSERT INTO public.external_roles AS e (kind, identifier, name, source, active, synced_at)
       SELECT c.kind, c.identifier, c.name, 'config', true, now()
         FROM unnest($1::text[], $2::text[], $3::text[]) AS c(kind, identifier, name)
       ON CONFLICT (kind, identifier) DO UPDATE
         SET name = EXCLUDED.name, source = 'config', active = true, synced_at = now()
       RETURNING 1`,
      [kinds, identifiers, names],
    );
    const deactivated = await tx.query(
      `UPDATE public.external_roles e SET active = false, synced_at = now()
        WHERE e.source = 'config' AND e.active
          AND NOT EXISTS (
            SELECT 1 FROM unnest($1::text[], $2::text[]) AS c(kind, identifier)
             WHERE c.kind = e.kind AND c.identifier = e.identifier)
       RETURNING 1`,
      [kinds, identifiers],
    );
    return { upserted: upserted.rows.length, deactivated: deactivated.rows.length };
  });
}

let synced = false;
let attempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
const RETRY_MAX_ATTEMPTS = 8;

function scheduleRetry(): void {
  if (retryTimer || attempt >= RETRY_MAX_ATTEMPTS) return;
  const delay = Math.min(RETRY_BASE_MS * 3 ** attempt, RETRY_MAX_MS);
  attempt += 1;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void syncConfigCatalogueOnce();
  }, delay);
  retryTimer.unref?.();
}

/**
 * Once per process, never throws: a failure is a content-free warning and is RETRIED with a growing delay
 * (a database that is not up yet at boot must not leave the catalogue unsynced until the next restart).
 */
export async function syncConfigCatalogueOnce(): Promise<CatalogueSyncResult | 'failed' | 'skipped'> {
  if (synced) return 'skipped';
  synced = true;
  try {
    const result = await syncConfigCatalogue();
    attempt = 0;
    return result;
  } catch (err) {
    synced = false;
    console.warn(`[authz] config catalogue sync failed (${errorLabel(err)})`);
    scheduleRetry();
    return 'failed';
  }
}

/** Test only. */
export function __resetCatalogueSync(): void {
  synced = false;
  attempt = 0;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = undefined;
}
