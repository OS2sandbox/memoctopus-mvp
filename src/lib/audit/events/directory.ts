// Directory synchronisation from Rollekatalog. Counts and short codes only: no
// names, emails or user ids. `system` is the cron trigger; a manual run from the
// admin button is a `server` event whose actor is the admin. The entity is the
// sync_runs row.
import { z } from 'zod';
import { code, count, defineEvent } from './types';

export const directoryEvents = {
  'directory.sync': defineEvent({
    sources: ['system', 'server'],
    entityType: 'sync_run',
    entityIdRequired: false,
    details: z
      .object({
        trigger: z.enum(['cron', 'manual']),
        status: z.enum(['success', 'aborted', 'error', 'already_running']),
        forced: z.boolean().optional(),
        usersUpserted: count(),
        usersDisabled: count(),
        sessionsRevoked: count().optional(),
        orgUnitsUpserted: count(),
        orgUnitsOrphaned: count(),
        orgUnitCyclesBroken: count().optional(),
        assignmentsUpserted: count(),
        assignmentsRemoved: count(),
        assignmentsIgnoredRole: count(),
        assignmentsSkippedUnknownUser: count(),
        assignmentsWithoutScope: count(),
        usersSkippedInvalid: count().optional(),
        orgUnitsSkippedInvalid: count().optional(),
        assignmentRowsSkippedInvalid: count().optional(),
        membershipsSkippedInvalid: count().optional(),
        errorCode: code().optional(),
      })
      .strict(),
  }),
} as const;
