// Personal templates. Template NAMES and prompt text are never logged; only the
// opaque id and which fields changed. Ids are the per-user `gen_random_uuid()::text`.
import { z } from 'zod';
import { defineEvent } from './types';

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

const base = { sources: ['server'] as const, entityType: 'template', entityIdRequired: true };

export const templateEvents = {
  'template.create': defineEvent({
    ...base,
    details: z.object({ hasPrompt: z.boolean().optional() }).strict(),
  }),
  'template.update': defineEvent({
    ...base,
    details: z.object({ changedFields: z.array(z.enum(TEMPLATE_FIELDS)).max(TEMPLATE_FIELDS.length) }).strict(),
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
