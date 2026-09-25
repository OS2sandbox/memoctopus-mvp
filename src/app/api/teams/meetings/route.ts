import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { teamsGraphEnabled } from '@/lib/auth/providers';
import { GraphError, TEAMS_DISABLED_MESSAGE } from '@/lib/teams/graph-client';
import { graphDate } from '@/lib/teams/graph-dates';
import { getMeetingOwner, setMeetingOwner } from '@/lib/pending-artifacts';
import { teamsErrorResponse } from '@/lib/teams/http-errors';
import { armMeeting, isArmed } from '@/lib/teams/meeting-arm';
import { resolveJoinUrl } from '@/lib/teams/meeting-resolver';
import { claimMeetingSnapshot, upsertTeamsMeeting } from '@/lib/teams/store';

/** ISO string → Date, tolerating a missing or unparseable value. */
function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The meeting id is the client's own IndexedDB id, and it ends up as a file
 * name in the pending stash and in the pipeline's scratch directory. Anything
 * outside this alphabet (`../…`) is rejected at the boundary rather than
 * relying on a downstream call happening to validate first.
 */
const SAFE_MEETING_ID = /^[\w-]+$/;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Registers a Teams meeting for automatic minutes: resolve the join URL to a
 * Graph onlineMeeting, arm it when we are the organizer, and store the row the
 * poller works from.
 */
export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Before anything is written: resolving the link needs Graph, which the sign-in
  // never got scopes for, and the owner binding below would be left dangling.
  if (!teamsGraphEnabled()) {
    return teamsErrorResponse(new GraphError('disabled', TEAMS_DISABLED_MESSAGE, { status: 403 }));
  }

  let body: {
    meetingId?: unknown;
    joinUrl?: unknown;
    eventId?: unknown;
    scheduledStart?: unknown;
    scheduledEnd?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid-url' }, { status: 400 });
  }

  const meetingId = typeof body.meetingId === 'string' ? body.meetingId.trim() : '';
  const joinUrl = typeof body.joinUrl === 'string' ? body.joinUrl : '';
  if (!meetingId) return NextResponse.json({ error: 'missing-meeting-id' }, { status: 400 });
  if (!SAFE_MEETING_ID.test(meetingId)) {
    return NextResponse.json({ error: 'invalid-meeting-id' }, { status: 400 });
  }
  if (!joinUrl) return NextResponse.json({ error: 'invalid-url' }, { status: 400 });

  const userId = session.user.id;

  // The pending stash is keyed by meetingId across all users, and the pipeline
  // will write this meeting's transcript and recording into it. Binding the id
  // to its owner here does two things: it stops another user's browser from
  // collecting these artifacts, and it makes the hand-off work at all — both
  // the pending-audio and pending-transcript routes deny by default when no owner is
  // recorded.
  const existingOwner = await getMeetingOwner(meetingId);
  if (existingOwner && existingOwner !== userId) {
    return NextResponse.json({ error: 'meeting-id-taken' }, { status: 409 });
  }
  await setMeetingOwner(meetingId, userId);

  // The client knows which *occurrence* of a recurring series it armed; Graph's
  // onlineMeeting only knows the series-level window. Prefer the occurrence, or
  // artifacts of occurrence 2+ fall outside the pick window and are never found.
  const eventId = str(body.eventId) ?? null;
  const occurrenceStart = toDate(graphDate(str(body.scheduledStart)));
  const occurrenceEnd = toDate(graphDate(str(body.scheduledEnd)));

  try {
    const resolved = await resolveJoinUrl(userId, joinUrl);

    // Only the organizer may PATCH meeting options; an invitee is registered
    // anyway, because their transcript is readable if somebody starts
    // transcription manually.
    const outcome = resolved.isOrganizer
      ? await armMeeting(userId, resolved.graphMeetingId)
      : null;
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
      eventId,
      scheduledStart: occurrenceStart ?? toDate(resolved.scheduledStart),
      scheduledEnd: occurrenceEnd ?? toDate(resolved.scheduledEnd),
      state: 'awaiting_teams',
    });

    return NextResponse.json({
      id: row.id,
      graphMeetingId: row.graphMeetingId,
      subject: row.subject,
      scheduledStart: row.scheduledStart ? row.scheduledStart.toISOString() : null,
      scheduledEnd: row.scheduledEnd ? row.scheduledEnd.toISOString() : null,
      isOrganizer: row.isOrganizer,
      armed: row.armed,
      armResult,
      state: row.state,
    });
  } catch (err) {
    return teamsErrorResponse(err);
  }
}
