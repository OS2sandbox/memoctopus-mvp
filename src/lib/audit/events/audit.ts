// The audit log auditing itself.
import { z } from 'zod';
import { count, defineEvent } from './types';

export const auditEvents = {
  'audit.export': defineEvent({
    sources: ['server'],
    entityType: null,
    entityIdRequired: false,
    // truncated: the export hit its hard row cap, so the file is not the whole result.
    details: z.object({ rowCount: count(), format: z.enum(['csv']), truncated: z.boolean().optional() }).strict(),
  }),
  'audit.prune': defineEvent({
    sources: ['system'],
    entityType: null,
    entityIdRequired: false,
    details: z.object({ deletedCount: count(), olderThanDays: count() }).strict(),
  }),
} as const;
