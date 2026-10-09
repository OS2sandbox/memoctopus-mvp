// Personal templates. Template NAMES and prompt text are never logged; only the
// opaque id and which fields changed. Ids are the per-user `gen_random_uuid()::text`.
// A failed create/update/delete/share/import is recorded with outcome 'error' (the
// route re-throws afterwards); such an event may have no id (a create that never got
// one), so the id is not required.
import { z } from 'zod';
import { count, defineEvent } from './types';

const TEMPLATE_FIELDS = [
  'name',
  'description',
  'prompt',
  'includeDeltagere',
  'includeBeslutningspunkter',
  'includeDagsorden',
  'includeDato',
] as const;

// Only the server-side link flow is audited; the stateless share CODE is built and read client-side.
const SHARE_KINDS = ['link'] as const;

const base = { sources: ['server'] as const, entityType: 'template', entityIdRequired: false };

export const templateEvents = {
  'template.create': defineEvent({
    ...base,
    details: z.object({ hasPrompt: z.boolean().optional() }).strict(),
  }),
  'template.update': defineEvent({
    ...base,
    // hasChangeNote: whether the person wrote an (optional) note about the edit; the note itself
    // lives only in their own schema and never reaches audit_events. `version` is the history version
    // of that edit, so the viewer and the CSV export can look the note up at read time (same as the
    // central templates' notes).
    details: z
      .object({
        changedFields: z.array(z.enum(TEMPLATE_FIELDS)).max(TEMPLATE_FIELDS.length),
        hasChangeNote: z.boolean(),
        version: count().min(1).optional(),
      })
      .strict(),
  }),
  'template.delete': defineEvent({ ...base, details: z.object({}).strict() }),
  'template.share': defineEvent({
    ...base,
    details: z.object({ kind: z.enum(SHARE_KINDS) }).strict(),
  }),
  'template.import': defineEvent({
    ...base,
    details: z.object({ kind: z.enum(SHARE_KINDS) }).strict(),
  }),
} as const;
