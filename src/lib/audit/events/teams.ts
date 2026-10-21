// The Microsoft Teams (Graph) integration. A person registers a Teams meeting (which arms it:
// the server PATCHes the meeting options through Graph on their behalf), the server later fetches
// the transcript/recording from Graph, deletes the recording from the organizer's OneDrive and
// deletes its own transient copy of the result once the browser has taken it (or nobody did).
// The entity is the meeting (the browser-generated id; only attached when it is a UUID), never
// its subject, join URL or Graph meeting id. Booleans, closed enums and short codes only: never a
// name, a file name, a URL or an error message. Pipeline steps (download, transcoding,
// transcription) are not events; the fetch that starts them is.
import { z } from 'zod';
import { code, defineEvent } from './types';

// The meeting id is chosen by the browser and the routes only require /^[\w-]+$/, so a UUID is
// not guaranteed: the emitters pass the id only when it is one.
const meeting = { entityType: 'meeting', entityIdRequired: false };

export const teamsEvents = {
  // POST /api/teams/meetings. The details are what is known: after a failure (outcome 'error',
  // `code` = the closed failure code) the meeting may or may not have been armed in Teams.
  'teams.meeting_register': defineEvent({
    ...meeting,
    sources: ['server'],
    details: z
      .object({
        armed: z.boolean().optional(),
        isOrganizer: z.boolean().optional(),
        // The one-shot arm PATCH's verdict (TeamsArmResult in teams/store.ts).
        armResult: z.enum(['armed', 'armed_in_progress', 'not_organizer', 'policy_blocked']).optional(),
        code: code().optional(),
      })
      .strict(),
  }),
  // DELETE /api/teams/meetings/[id]. `disarmed` = the meeting's options are back as they were
  // (trivially true for a meeting that was never armed); false = it may still be armed in Teams,
  // in which case the outcome is 'error' and `code` says why.
  'teams.meeting_unregister': defineEvent({
    ...meeting,
    sources: ['server'],
    details: z.object({ disarmed: z.boolean(), code: code().optional() }).strict(),
  }),
  // A fetch of the meeting's transcript/recording from Graph came to a verdict: ready, or failed
  // for good (outcome 'error', `code` = closed failure code). A poll that finds nothing yet or
  // is throttled is not an event. `transcript`/`recording`: which artifacts were fetched.
  // 'poller' = the background poller (source 'system', the owning person as actor), 'manual' =
  // the person pressed "Tjek nu" / "Prøv igen" (source 'server').
  'teams.artifacts_fetch': defineEvent({
    ...meeting,
    sources: ['system', 'server'],
    details: z
      .object({
        trigger: z.enum(['poller', 'manual']),
        result: z.enum(['ready', 'failed']),
        transcript: z.boolean(),
        recording: z.boolean(),
        code: code().optional(),
      })
      .strict(),
  }),
  // The recording was removed from the organizer's OneDrive through Graph (RecordingCleanupState
  // in teams/store.ts, except `pending`). Automatic, so source 'system' with the owner as actor;
  // 'failed' is outcome 'error'.
  'teams.recording_delete': defineEvent({
    ...meeting,
    sources: ['system'],
    details: z.object({ status: z.enum(['deleted', 'recycled', 'not_found', 'failed']) }).strict(),
  }),
  // The server-held copy of a Teams result (the transcript with its speaker names, in the
  // pending stash) was deleted: handoff = the browser saved it and acknowledged (source 'server',
  // the person as actor), ttl = nobody collected it and the retention sweep removed it (source
  // 'system', the actor is the owner recorded with the stash when it is still readable).
  // Teams audio is never stashed: the recording is transcribed and dropped.
  'teams.stash_delete': defineEvent({
    ...meeting,
    sources: ['system', 'server'],
    details: z.object({ trigger: z.enum(['handoff', 'ttl']) }).strict(),
  }),
} as const;
