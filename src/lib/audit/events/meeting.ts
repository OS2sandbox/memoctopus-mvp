// CLIENT-reported meeting events. Meetings live only in the browser (IndexedDB),
// so these are SELF-REPORTED and forgeable by that user; the viewer labels them
// 'selvrapporteret'. Titles, participant names, transcript and minutes text never
// appear: the meeting is referenced by its opaque uuid and counts/codes only.
import { z } from 'zod';
import { count, defineEvent } from './types';

const MEETING_STATUSES = [
  'joining',
  'recording',
  'processing',
  'review',
  'minutes',
  'done',
  'redacted',
  'failed',
  'cancelled',
] as const;

const base = { sources: ['client'] as const, entityType: 'meeting', entityIdRequired: true };
const noDetails = () => z.object({}).strict();

export const meetingEvents = {
  'meeting.create': defineEvent({
    ...base,
    details: z.object({ origin: z.enum(['live', 'upload', 'bot']) }).strict(),
  }),
  'meeting.status_change': defineEvent({
    ...base,
    details: z.object({ fromStatus: z.enum(MEETING_STATUSES), toStatus: z.enum(MEETING_STATUSES) }).strict(),
  }),
  'meeting.rename': defineEvent({ ...base, details: noDetails() }),
  'meeting.participants_edit': defineEvent({
    ...base,
    details: z.object({ participantCount: count() }).strict(),
  }),
  'meeting.delete': defineEvent({ ...base, details: noDetails() }),
  'meeting.redact': defineEvent({ ...base, details: noDetails() }),
  'meeting.audio_delete': defineEvent({ ...base, details: noDetails() }),
  'meeting.transcript_edit': defineEvent({ ...base, details: z.object({ segmentCount: count().optional() }).strict() }),
  'meeting.minutes_save': defineEvent({ ...base, details: noDetails() }),
  // `action` tells a new version (snapshot = "Gem version", generate = regenerated
  // referat) from switching the active version; versionNumber is the label of the
  // version concerned, never any of its content.
  'meeting.minutes_version': defineEvent({
    ...base,
    details: z
      .object({ versionNumber: count(), action: z.enum(['snapshot', 'generate', 'activate']).optional() })
      .strict(),
  }),
} as const;
