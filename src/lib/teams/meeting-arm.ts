import { graphFetch, GraphError } from '@/lib/teams/graph-client';
import { getMeeting, type ResolvedMeeting } from '@/lib/teams/meeting-resolver';

/**
 * "OS2taletiltekst slået til" for one meeting.
 *
 * Arming is a single PATCH of the meeting's own options — exactly what the
 * organizer would tick in Teams' meeting options — so Teams records and
 * transcribes the meeting itself and we only collect the artifacts afterwards.
 * No bot joins, and for a scheduled meeting nobody has to press
 * anything during it.
 *
 * Two exceptions, both because Teams only acts on `recordAutomatically` when a
 * meeting starts. A meeting Graph gives no window for is reported as
 * `armed_in_progress` (see {@link isInstantMeeting}), and one switched on at or
 * after its booked start as `armed_late` (see {@link isLateArm}). Either may
 * already be running, and then someone has to start the recording by hand; what
 * they record is collected afterwards exactly as an automatic one would be.
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

export type ArmResult = 'armed' | 'armed_in_progress' | 'armed_late' | 'not_organizer' | 'policy_blocked';

/**
 * Teams acts on `recordAutomatically` when a meeting *starts*, so a meeting that
 * is already under way cannot be armed into transcribing itself — and Graph has
 * no delegated API to start transcription on a running meeting either. All we
 * can do is `allowTranscription`, so the organizer can start it by hand in one
 * tap; the collection afterwards is unchanged.
 *
 * An instant meeting ("Mød nu", or a personal meeting link) is one Graph gives no
 * real window for: either the year-1 sentinel (which {@link graphDate} has already
 * turned into null) or a zero-length window whose start and end are the moment it
 * came into being.
 *
 * That is NOT the same as "already running", and the UI must not say it is. The
 * link to such a meeting is routinely pasted into OS2taletiltekst before anyone joins,
 * and then `recordAutomatically` works perfectly. But delegated Graph offers no
 * roster and no in-progress flag, so we cannot tell the two apart — which is why
 * the result is reported separately and the screen offers the manual start as a
 * condition ("var mødet begyndt, inden du indsatte linket…") rather than a fact.
 *
 * A scheduled meeting is never "instant", even when its start has passed. Whether
 * people may already be in it is a separate question, answered by
 * {@link isLateArm}: Teams starts recording on the first join, not at the booked
 * time, so a late arm still works when nobody has joined yet — but not when they
 * have.
 */
export function isInstantMeeting(
  scheduledStart: string | null,
  scheduledEnd: string | null,
): boolean {
  if (scheduledStart === null) return true;
  const start = Date.parse(scheduledStart);
  const end = scheduledEnd === null ? NaN : Date.parse(scheduledEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return end <= start;
}

/**
 * People join a Teams meeting before its booked start, and a meeting that is
 * already running ignores `recordAutomatically`. So "late" starts a little before
 * the start, not at it.
 */
export const LATE_ARM_LEAD_MS = 15 * 60 * 1000;

/**
 * Switched on so close to (or after) the booked start that people may already be
 * in the meeting. Delegated Graph has no roster and no in-progress flag, so this
 * is a "maybe": the organizer may simply be running late, in which case
 * `recordAutomatically` still works. The screen therefore states the manual start
 * as a condition, and states it at once — the poller does not look at a scheduled
 * meeting before its end, so waiting for empty polls (as for a meeting with no
 * window) would only show the hint once the meeting is over.
 */
export function isLateArm(scheduledStart: string | null, now: Date): boolean {
  if (scheduledStart === null) return false;
  const start = Date.parse(scheduledStart);
  if (!Number.isFinite(start)) return false;
  return now.getTime() >= start - LATE_ARM_LEAD_MS;
}

/**
 * Every arming outcome leaves the meeting armed and worth polling — they differ
 * only in what we may promise the user about who starts the recording.
 */
export function isArmed(result: ArmResult): boolean {
  return result === 'armed' || result === 'armed_in_progress' || result === 'armed_late';
}

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
export async function armMeeting(
  userId: string,
  graphMeetingId: string,
  now: Date = new Date(),
): Promise<ArmOutcome> {
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
  // Policy wins: if Teams refused the options outright, how the meeting was
  // started is beside the point — nobody can transcribe it, by hand or not.
  const result: ArmResult = blocked
    ? 'policy_blocked'
    : isInstantMeeting(after.scheduledStart, after.scheduledEnd)
      ? 'armed_in_progress'
      : isLateArm(after.scheduledStart, now)
        ? 'armed_late'
        : 'armed';
  return { result, options: after.options, previousOptions };
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
 * "Slå OS2taletiltekst fra". Puts back the options as they were before arming
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
