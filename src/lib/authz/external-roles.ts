// The role/group CATALOGUE (public.external_roles): the only role and group values the
// app stores for a person (public.user_external_roles) and the only ones a shared prompt
// can be targeted at. It is filled from a source: today the optional `catalogue` section
// of AUTH_CONFIG_FILE (source 'config', so an installation without Rollekatalog works),
// later the Rollekatalog's role list (source 'rollekatalog', written by its own sync).
//
// This module owns the 'config' rows only: it never touches another source's rows, and an
// entry that leaves the file is DEACTIVATED, not deleted, so a prompt that still targets it
// keeps the reference (the person simply stops matching it at their next login).
import { authConfigCatalogue, type CatalogueEntry } from '@/lib/auth/providers';
import { defaultRunner, errorLabel, type SqlRunner } from './pg-runner';

export interface CatalogueSyncResult {
  /** Entries written (inserted or refreshed). */
  upserted: number;
  /** Config entries that are no longer in the file and were marked inactive. */
  deactivated: number;
}

export async function syncConfigCatalogue(
  entries: readonly CatalogueEntry[] = authConfigCatalogue(),
  runner: SqlRunner = defaultRunner(),
): Promise<CatalogueSyncResult> {
  const kinds = entries.map((e) => e.kind);
  const identifiers = entries.map((e) => e.identifier);
  const names = entries.map((e) => e.name);

  return runner.transaction(async (tx) => {
    // One writer at a time: two instances starting together must not interleave their sets.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['referat:external-roles-config']);

    // Only rows this source owns are refreshed; a Rollekatalog row with the same key is left alone.
    const upserted = await tx.query(
      `INSERT INTO public.external_roles AS e (kind, identifier, name, source, active, synced_at)
       SELECT c.kind, c.identifier, c.name, 'config', true, now()
         FROM unnest($1::text[], $2::text[], $3::text[]) AS c(kind, identifier, name)
       ON CONFLICT (kind, identifier) DO UPDATE
         SET name = EXCLUDED.name, active = true, synced_at = now()
         WHERE e.source = 'config'
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

/** Once per process, never throws: a failure is a content-free warning and the next start tries again. */
export async function syncConfigCatalogueOnce(): Promise<CatalogueSyncResult | 'failed' | 'skipped'> {
  if (synced) return 'skipped';
  synced = true;
  try {
    return await syncConfigCatalogue();
  } catch (err) {
    console.warn(`[authz] config catalogue sync failed (${errorLabel(err)})`);
    return 'failed';
  }
}

/** Test only. */
export function __resetCatalogueSync(): void {
  synced = false;
}
