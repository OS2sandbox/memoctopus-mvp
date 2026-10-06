// Central (locked) templates. create/update/retarget/archive/restore are written
// in the same transaction as the change (central.ts); `read` is emitted by the
// manager routes when a prompt is returned (best-effort, coalesced). Ids, counts and FIELD NAMES only: never the name, prompt or
// change note, which live in central_template_versions (readable by managers in
// scope) and not in the audit log.
import { z } from 'zod';
import { CENTRAL_CONTENT_FIELDS } from '@/lib/skabeloner/central-types';
import { count, defineEvent } from './types';

// 'targets' is a field of the template too: an update that also changed the recipients says so.
const CHANGED_FIELDS = [...CENTRAL_CONTENT_FIELDS, 'targets'] as const;

const base = {
  sources: ['server'] as const,
  entityType: 'central_template',
  entityIdRequired: true,
  // The owning org unit.
  secondaryEntityTypes: ['org_unit'] as const,
};

const version = () => count().min(1);

export const centralTemplateEvents = {
  'central_template.create': defineEvent({
    ...base,
    details: z.object({ version: version(), targetCount: count() }).strict(),
  }),
  'central_template.update': defineEvent({
    ...base,
    details: z
      .object({
        version: version(),
        changedFields: z.array(z.enum(CHANGED_FIELDS)).max(CHANGED_FIELDS.length),
      })
      .strict(),
  }),
  'central_template.retarget': defineEvent({
    ...base,
    details: z.object({ version: version(), targetCount: count() }).strict(),
  }),
  'central_template.archive': defineEvent({ ...base, details: z.object({ version: version() }).strict() }),
  'central_template.restore': defineEvent({ ...base, details: z.object({ version: version() }).strict() }),
  // A manager in scope was shown the prompt (template detail or changelog). The
  // version is the one current at the time; the prompt text is never part of it.
  'central_template.read': defineEvent({ ...base, details: z.object({ version: version() }).strict() }),
} as const;
