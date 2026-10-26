import { getMeetingOwner, setMeetingOwner } from '@/lib/pending-artifacts';
import { armMeeting, disarmMeeting, isArmed } from './meeting-arm';
import { resolveJoinUrl, type ResolvedMeeting } from './meeting-resolver';
import {
  claimMeetingSnapshot,
  deleteTeamsMeeting,
  getMeetingSnapshot,
  upsertTeamsMeeting,
  type TeamsArmResult,
  type TeamsMeetingOrigin,
  type TeamsMeetingRow,
} from './store';

/**
 * Registering a Teams meeting for automatic minutes: resolve the join URL to a
 * Graph onlineMeeting, arm it when the user is its organizer, and store the row
 * the poller works from. Shared by the dashboard's "Mødelink" box
 * (POST /api/teams/meetings) and the Outlook add-in (POST /api/outlook/meetings),
 * so the two cannot drift apart.
 *
 * Throws `GraphError` / `ResolveError` for the callers' error mapping, and
 * {@link MeetingIdTakenError} when the id belongs to someone else.
 */

export class MeetingIdTakenError extends Error {
  constructor() {
    super('meeting-id-taken');
    this.name = 'MeetingIdTakenError';
  }
}

export interface RegisterInput {
  /** Our own meeting id: the browser's IndexedDB id, or one minted for Outlook. */
  meetingId: string;
  joinUrl: string;
  /** Already resolved by the caller, to save a second Graph call. */
  resolved?: ResolvedMeeting;
  eventId?: string | null;
  occurrenceStart?: Date | null;
  occurrenceEnd?: Date | null;
  origin?: TeamsMeetingOrigin | null;
  /** Re-arming an existing row: keep its state (it may be `fetching` right now). */
  keepState?: boolean;
}

export interface RegisterResult {
  row: TeamsMeetingRow;
  armResult: TeamsArmResult;
}

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function registerTeamsMeeting(userId: string, input: RegisterInput): Promise<RegisterResult> {
  const { meetingId } = input;

  // The pending stash is keyed by meetingId across all users, and the pipeline
  // will write this meeting's transcript and recording into it. Binding the id
  // to its owner here does two things: it stops another user's browser from
  // collecting these artifacts, and it makes the hand-off work at all — both
  // the pending-audio and pending-transcript routes deny by default when no owner is
  // recorded.
  const existingOwner = await getMeetingOwner(meetingId);
  if (existingOwner && existingOwner !== userId) throw new MeetingIdTakenError();
  await setMeetingOwner(meetingId, userId);

  const resolved = input.resolved ?? (await resolveJoinUrl(userId, input.joinUrl));

  // Only the organizer may PATCH meeting options; an invitee is registered
  // anyway, because their transcript is readable if somebody starts
  // transcription manually.
  const outcome = resolved.isOrganizer ? await armMeeting(userId, resolved.graphMeetingId) : null;
  const armResult = outcome?.result ?? ('not_organizer' as const);

  // What the organizer had before we ever PATCHed this Graph meeting, for the
  // disarm to restore — claimed once per graphMeetingId, not per local id, so
  // a recurring series' second+ occurrence (its own local id, same Graph
  // meeting) gets back the true original instead of its own already-armed
  // values. See claimMeetingSnapshot. The claimed value itself is not needed
  // here — disarm reads it back later by graphMeetingId.
  if (outcome && outcome.result !== 'not_organizer') {
    await claimMeetingSnapshot(userId, resolved.graphMeetingId, outcome.previousOptions);
  }

  const row = await upsertTeamsMeeting(userId, {
    id: meetingId,
    graphMeetingId: resolved.graphMeetingId,
    joinUrl: resolved.joinUrl,
    subject: resolved.subject,
    organizerId: resolved.organizerId,
    isOrganizer: resolved.isOrganizer,
    armed: isArmed(armResult),
    armResult,
    eventId: input.eventId ?? null,
    // The client knows which *occurrence* of a recurring series it armed; Graph's
    // onlineMeeting only knows the series-level window. Prefer the occurrence, or
    // artifacts of occurrence 2+ fall outside the pick window and are never found.
    scheduledStart: input.occurrenceStart ?? toDate(resolved.scheduledStart),
    scheduledEnd: input.occurrenceEnd ?? toDate(resolved.scheduledEnd),
    // Omitted, the upsert keeps the row's state; a new row starts awaiting_teams.
    ...(input.keepState ? {} : { state: 'awaiting_teams' as const }),
    origin: input.origin ?? null,
  });

  return { row, armResult };
}

/**
 * Turns OS2taletiltekst off for a meeting: un-arm it (if we armed it) and forget it.
 *
 * The row is deleted even when the Graph side could not be undone — the user
 * asked us to stop collecting — but `disarmed: false` says the meeting may still
 * be armed in Teams (Graph failed, or TEAMS_GRAPH_ENABLED is off and there is no
 * way to reach it from here).
 */
export async function unregisterTeamsMeeting(
  userId: string,
  row: TeamsMeetingRow,
): Promise<{ disarmed: boolean }> {
  // A policy-blocked arm was still PATCHed, so it has options to put back too.
  let disarmed = true;
  if (row.armed || row.armResult === 'policy_blocked') {
    try {
      const originalOptions = await getMeetingSnapshot(userId, row.graphMeetingId);
      await disarmMeeting(userId, row.graphMeetingId, originalOptions);
    } catch (err) {
      disarmed = false;
      console.error('[teams] disarm failed for', row.id, '- the meeting may still be armed in Teams:', err);
    }
  }
  await deleteTeamsMeeting(userId, row.id);
  return { disarmed };
}
