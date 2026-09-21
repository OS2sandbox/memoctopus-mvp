import { graphFetch, GraphError } from '@/lib/teams/graph-client';
import { getMeeting, type ResolvedMeeting } from '@/lib/teams/meeting-resolver';

/**
 * "Memoctopus slået til" for one meeting.
 *
 * Arming is a single PATCH of the meeting's own options — exactly what the
 * organizer would tick in Teams' meeting options — so Teams records and
 * transcribes the meeting itself and we only collect the artifacts afterwards
 * (plan §3). No bot joins, nobody has to press anything during the meeting.
 *
 * Only the organizer may update meeting options. An invitee gets 403 and we
 * report `not_organizer` so the UI can show the copy-paste sentence to send to
 * the organizer; the meeting is still worth polling, because an invitee can
 * read the transcript if somebody starts it manually.
 */

const DEFAULT_SPOKEN_LANGUAGE = 'da-DK';

export const ARM_OPTIONS = {
  allowRecording: true,
  allowTranscription: true,
  recordAutomatically: true,
  meetingSpokenLanguageTag: DEFAULT_SPOKEN_LANGUAGE,
} as const;

export type ArmResult = 'armed' | 'not_organizer' | 'policy_blocked';

export interface ArmOutcome {
  result: ArmResult;
  /** The options after arming (or, for `not_organizer`, as far as we can read them). */
  options: ResolvedMeeting['options'];
  /**
   * The options as they were before the PATCH, so a later disarm can put back
   * exactly what the organizer had. A value we could not read is null.
   */
  previousOptions: ResolvedMeeting['options'];
}

const UNKNOWN_OPTIONS: ResolvedMeeting['options'] = {
  allowRecording: null,
  allowTranscription: null,
  recordAutomatically: null,
  meetingSpokenLanguageTag: null,
};

/**
 * `||` not `??`: docker-compose passes an unset variable through as an empty
 * string, and an empty language tag would make Graph reject the PATCH.
 */
function spokenLanguageTag(): string {
  return process.env.TEAMS_SPOKEN_LANGUAGE?.trim() || DEFAULT_SPOKEN_LANGUAGE;
}

function armBody(): Record<string, unknown> {
  return { ...ARM_OPTIONS, meetingSpokenLanguageTag: spokenLanguageTag() };
}

function meetingPath(graphMeetingId: string): string {
  return `/me/onlineMeetings/${encodeURIComponent(graphMeetingId)}`;
}

async function patchOptions(
  userId: string,
  graphMeetingId: string,
  body: Record<string, unknown>,
): Promise<void> {
  await graphFetch(userId, meetingPath(graphMeetingId), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function isNotOrganizer(error: unknown): boolean {
  return error instanceof GraphError && error.code === 'forbidden';
}

/**
 * Idempotent: re-arming an already-armed meeting PATCHes the same values and
 * reads back the same state.
 *
 * The read-back is not paranoia. A tenant recording/transcription policy that
 * forbids the feature makes Graph accept the PATCH and silently keep the flag
 * false, which is the difference between "it will record" and "the user thinks
 * it will record" — so we only claim `armed` when Graph says so.
 *
 * The options are read once BEFORE the PATCH: it overwrites them, and
 * {@link disarmMeeting} can only give the organizer back what we saw here.
 */
export async function armMeeting(userId: string, graphMeetingId: string): Promise<ArmOutcome> {
  const previousOptions = await readOptions(userId, graphMeetingId);

  try {
    await patchOptions(userId, graphMeetingId, armBody());
  } catch (error) {
    if (!isNotOrganizer(error)) throw error;
    return {
      result: 'not_organizer',
      options: await readOptions(userId, graphMeetingId),
      previousOptions,
    };
  }

  const after = await getMeeting(userId, graphMeetingId);
  const blocked = after.options.recordAutomatically === false || after.options.allowTranscription === false;
  return { result: blocked ? 'policy_blocked' : 'armed', options: after.options, previousOptions };
}

/** Best effort — an invitee may not even be allowed to read the options back. */
async function readOptions(
  userId: string,
  graphMeetingId: string,
): Promise<ResolvedMeeting['options']> {
  try {
    return (await getMeeting(userId, graphMeetingId)).options;
  } catch {
    return UNKNOWN_OPTIONS;
  }
}

/**
 * "Slå Memoctopus fra". Puts back the options as they were before arming
 * (`original`, snapshotted by {@link armMeeting}) — including the ones that were
 * off, so we do not leave recording and transcription enabled on a meeting whose
 * organizer never wanted them.
 *
 * A null value is one we could not read then. It is left alone: turning off
 * something we cannot show we turned on would take away a capability the
 * organizer set themselves.
 *
 * A row armed before snapshots existed has no `original`. It gets the old
 * behaviour: only `recordAutomatically` is reset, because allowRecording and
 * allowTranscription may have been on before we touched the meeting.
 *
 * A 403 here means we never armed it in the first place (invitee), so there is
 * nothing to undo and nothing to report. Sending the same PATCH again is
 * harmless, so disarming twice is too.
 */
export async function disarmMeeting(
  userId: string,
  graphMeetingId: string,
  original: ResolvedMeeting['options'] | null = null,
): Promise<void> {
  const restore = Object.fromEntries(
    // An empty tag is as good as unreadable: Graph rejects it.
    Object.entries(original ?? {}).filter(([, value]) => value !== null && value !== ''),
  );
  const body = Object.keys(restore).length > 0 ? restore : { recordAutomatically: false };

  try {
    await patchOptions(userId, graphMeetingId, body);
  } catch (error) {
    if (!isNotOrganizer(error)) throw error;
  }
}
