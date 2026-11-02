// Central (locked) templates. create/update/retarget/archive/restore are written
// in the same transaction as the change (central.ts); "archive" is how a common prompt
// is withdrawn (the history is append-only, nothing is deleted). Reading a template or
// its prompt is not audited (unlike opening a meeting's records, see meeting.ts). Ids, counts and FIELD NAMES only: never the name, prompt or
// change note. Those live in central_template_versions; the log viewer shows the change
// note by looking it up there at read time (change-notes.ts), nothing is copied here.
import { z } from 'zod';
import { CENTRAL_CONTENT_FIELDS } from '@/lib/skabeloner/central-types';
import { count, defineEvent } from './types';

// 'targets' (org units) and 'principalTargets' (roles/groups) are fields of the template too: an
// update that also changed the recipients says so. Only the NUMBER of role/group targets is ever
// logged, never which roles or groups (those are in central_template_versions).
const CHANGED_FIELDS = [...CENTRAL_CONTENT_FIELDS, 'targets', 'principalTargets'] as const;

const base = {
  sources: ['server'] as const,
  entityType: 'central_template',
  entityIdRequired: true,
  // The owning org unit; absent for an organisation-wide template.
  secondaryEntityTypes: ['org_unit'] as const,
};

const version = () => count().min(1);

export const centralTemplateEvents = {
  'central_template.create': defineEvent({
    ...base,
    details: z.object({ version: version(), targetCount: count(), principalTargetCount: count() }).strict(),
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
    details: z.object({ version: version(), targetCount: count(), principalTargetCount: count() }).strict(),
  }),
  'central_template.archive': defineEvent({ ...base, details: z.object({ version: version() }).strict() }),
  'central_template.restore': defineEvent({ ...base, details: z.object({ version: version() }).strict() }),
} as const;
