// CLIENT-reported meeting events. Meetings, transcripts, minutes versions and audio
// live only in the browser (IndexedDB), so the server cannot observe what happens to
// them: these events are SELF-REPORTED, forgeable by that user and NOT proof. The
// viewer labels them 'selvrapporteret'. They record that an ACTION happened (a view,
// an edit, a version switch, a playback, a recording step, a delete), never the
// content: the meeting is referenced by its opaque uuid, everything else is a count
// or a code. Titles, participant and speaker names, transcript and minutes text, file
// names and instructions never appear. The entity is always the meeting; `object`
// or the event name says which part of it (minutes, a version, transcript, audio).
import { z } from 'zod';
import { count, defineEvent } from './types';

const base = { sources: ['client'] as const, entityType: 'meeting', entityIdRequired: true };
const noDetails = () => z.object({}).strict();

// Why a delete happened. `user` = the person asked; `auto_*` = the app did it on its
// own (after minutes were generated, when the person left the page, when the tab closed,
// or because a recording turned out to be empty).
export const CLIENT_DELETE_TRIGGERS = ['user', 'auto_generate', 'auto_leave', 'auto_pagehide', 'auto_empty'] as const;
export type DeleteTrigger = (typeof CLIENT_DELETE_TRIGGERS)[number];
const trigger = () => z.enum(CLIENT_DELETE_TRIGGERS).optional();

export const meetingEvents = {
  'meeting.create': defineEvent({
    ...base,
    details: z.object({ origin: z.enum(['live', 'upload', 'bot']) }).strict(),
  }),
  'meeting.delete': defineEvent({ ...base, details: z.object({ trigger: trigger() }).strict() }),
  'meeting.redact': defineEvent({ ...base, details: noDetails() }),
  'meeting.audio_delete': defineEvent({ ...base, details: z.object({ trigger: trigger() }).strict() }),

  // Access: the minutes or the transcript was opened.
  'meeting.minutes_view': defineEvent({ ...base, details: noDetails() }),
  'meeting.transcript_view': defineEvent({ ...base, details: noDetails() }),
  // Playback of the locally held audio started (a browser player on a blob: URL).
  'meeting.audio_play': defineEvent({ ...base, details: noDetails() }),

  // Recording with the local microphone.
  'meeting.recording_start': defineEvent({ ...base, details: noDetails() }),
  'meeting.recording_pause': defineEvent({ ...base, details: noDetails() }),
  'meeting.recording_resume': defineEvent({ ...base, details: noDetails() }),
  'meeting.recording_stop': defineEvent({ ...base, details: noDetails() }),

  // Edits. `minutes_save` is coalesced in the browser (one event per window), so it says
  // "the minutes were edited", not how many keystrokes.
  'meeting.minutes_save': defineEvent({ ...base, details: noDetails() }),
  // The transcript text was edited (autosave, coalesced like minutes_save). No details.
  'meeting.transcript_edit': defineEvent({ ...base, details: noDetails() }),
  // The meeting's title or recording date was changed. Says which field, never the value.
  'meeting.metadata_edit': defineEvent({ ...base, details: z.object({ field: z.enum(['title', 'recorded_at']) }).strict() }),
  // `action`: view = an earlier version was opened, snapshot = "Gem version", generate =
  // a regenerated minutes version, activate = another version became the active one
  // (the nearest thing to a restore). versionNumber is the label of the version
  // concerned, never any of its content.
  'meeting.minutes_version': defineEvent({
    ...base,
    details: z
      .object({ versionNumber: count(), action: z.enum(['view', 'snapshot', 'generate', 'activate']) })
      .strict(),
  }),
  // The 50-version cap removed the oldest versions of a meeting.
  'meeting.minutes_version_prune': defineEvent({
    ...base,
    details: z.object({ prunedCount: count().min(1) }).strict(),
  }),
  // Meeting metadata: who took part and who spoke. Counts only, never names.
  'meeting.participants_edit': defineEvent({
    ...base,
    details: z.object({ participantCount: count() }).strict(),
  }),
  'meeting.speakers_edit': defineEvent({
    ...base,
    details: z.object({ speakerCount: count().optional() }).strict(),
  }),
} as const;
