// CLIENT-reported meeting events. Meetings live only in the browser (IndexedDB),
// so these are SELF-REPORTED and forgeable by that user; the viewer labels them
// 'selvrapporteret'. Only the lifecycle moments that matter for accountability are
// reported (create, delete, redact, audio delete); edits and status changes are
// not. Titles, participant names, transcript and minutes text never appear: the
// meeting is referenced by its opaque uuid and codes only.
import { z } from 'zod';
import { defineEvent } from './types';

const base = { sources: ['client'] as const, entityType: 'meeting', entityIdRequired: true };
const noDetails = () => z.object({}).strict();

export const meetingEvents = {
  'meeting.create': defineEvent({
    ...base,
    details: z.object({ origin: z.enum(['live', 'upload', 'bot']) }).strict(),
  }),
  'meeting.delete': defineEvent({ ...base, details: noDetails() }),
  'meeting.redact': defineEvent({ ...base, details: noDetails() }),
  'meeting.audio_delete': defineEvent({ ...base, details: noDetails() }),
} as const;
