// Runs of an integration towards an external system: today the two Rollekatalog pulls
// (user/organisation sync and the role/group catalogue refresh). The event says THAT a run
// happened, how it was triggered, how it ended (a closed status and short code) and, for a run
// that applied, how many rows each step touched. Counts only: never a name, a person, a role or
// group identifier, a key or a URL, and not WHO got or lost which role (changes of rights are
// deliberately not audited, only that the run happened). A run that found another run already
// holding the lock changed nothing and is not recorded.
import { z } from 'zod';
import { SYNC_COUNT_KEYS } from '@/lib/rollekatalog/types';
import { count, code, defineEvent } from './types';

/** The counters of a role/group catalogue refresh (CatalogueRefreshCounts in rollekatalog/catalogue-sync.ts). */
export const CATALOGUE_COUNT_KEYS = ['fetched', 'added', 'updated', 'deactivated', 'skipped'] as const;

/** Every counter an integration run may report, flat (details allow no nesting), all optional. */
export const INTEGRATION_COUNT_KEYS = [...SYNC_COUNT_KEYS, ...CATALOGUE_COUNT_KEYS] as const;

const counts = Object.fromEntries(INTEGRATION_COUNT_KEYS.map((k) => [k, count().optional()])) as Record<
  (typeof INTEGRATION_COUNT_KEYS)[number],
  z.ZodOptional<ReturnType<typeof count>>
>;

export const integrationEvents = {
  'integration.sync_run': defineEvent({
    // 'system' for the scheduled (cron) run, 'server' for an administrator's button.
    sources: ['system', 'server'],
    entityType: null,
    entityIdRequired: false,
    details: z
      .object({
        kind: z.enum(['org_sync', 'role_catalogue']),
        trigger: z.enum(['cron', 'manual']),
        // aborted = a safety guard (empty response, removal threshold) stopped it before any write.
        status: z.enum(['success', 'aborted', 'error']),
        // The closed short code of an aborted or failed run (empty_response, removal_threshold, timeout, ...).
        code: code().optional(),
        ...counts,
      })
      .strict(),
  }),
} as const;
