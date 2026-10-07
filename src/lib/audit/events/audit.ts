// The audit log auditing itself.
import { z } from 'zod';
import { count, defineEvent } from './types';

// Why events were not stored. The first four are emitted by the server about its own
// limits (once per person and window, with a count); `client_outbox` is the browser
// reporting that its own queue lost events before they were delivered (self-reported).
export const DROP_REASONS = ['daily_cap', 'rate_limit', 'actor_ceiling', 'throttle', 'client_outbox'] as const;
export type DropReason = (typeof DROP_REASONS)[number];

export const auditEvents = {
  'audit.export': defineEvent({
    sources: ['server'],
    entityType: null,
    entityIdRequired: false,
    // truncated: the export hit its hard row cap, so the file is not the whole result.
    details: z.object({ rowCount: count(), format: z.enum(['csv']), truncated: z.boolean().optional() }).strict(),
  }),
  // A limit made the log skip events. A count and a reason, never what was skipped.
  // Itself exempt from every cap, so a flood cannot hide that it happened.
  'audit.events_dropped': defineEvent({
    sources: ['system', 'client'],
    entityType: null,
    entityIdRequired: false,
    details: z.object({ reason: z.enum(DROP_REASONS), count: count().min(1) }).strict(),
  }),
  'audit.prune': defineEvent({
    sources: ['system'],
    entityType: null,
    entityIdRequired: false,
    details: z.object({ deletedCount: count(), olderThanDays: count() }).strict(),
  }),
} as const;
