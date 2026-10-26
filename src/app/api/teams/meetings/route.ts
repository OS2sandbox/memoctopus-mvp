import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { teamsGraphEnabled } from '@/lib/auth/providers';
import { GraphError, TEAMS_DISABLED_MESSAGE } from '@/lib/teams/graph-client';
import { graphDate } from '@/lib/teams/graph-dates';
import { teamsErrorResponse } from '@/lib/teams/http-errors';
import { MeetingIdTakenError, registerTeamsMeeting } from '@/lib/teams/register';
import { isDeferred, listTeamsMeetings } from '@/lib/teams/store';

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
 * The caller's registered Teams meetings, read from their own per-user schema.
 *
 * Two uses. The Arkiv reads `state`: the browser's copy of a Teams meeting keeps
 * `awaiting_teams` until the transcript is collected, because that status is
 * what renders the meeting's Teams screen (with "Prøv igen" and "Slet"), so the
 * archive cannot tell from its own data that the server has given up.
 *
 * And the dashboard imports meetings armed from Outlook, which exist only here
 * until a browser has seen them: those rows carry what a new local meeting needs.
 * `deferred` says the meeting is waiting for its user to open it.
 */
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const rows = await listTeamsMeetings(session.user.id);
  return NextResponse.json({
    meetings: rows.map((row) => ({
      id: row.id,
      state: row.state,
      ...(row.origin === 'outlook'
        ? {
            origin: row.origin,
            deferred: isDeferred(row),
            subject: row.subject,
            joinUrl: row.joinUrl,
            scheduledStart: row.scheduledStart ? row.scheduledStart.toISOString() : null,
            createdAt: row.createdAt ? row.createdAt.toISOString() : null,
          }
        : {}),
    })),
  });
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

  // The client knows which *occurrence* of a recurring series it armed; Graph's
  // onlineMeeting only knows the series-level window (see registerTeamsMeeting).
  const eventId = str(body.eventId) ?? null;
  const occurrenceStart = toDate(graphDate(str(body.scheduledStart)));
  const occurrenceEnd = toDate(graphDate(str(body.scheduledEnd)));

  try {
    const { row, armResult } = await registerTeamsMeeting(userId, {
      meetingId,
      joinUrl,
      eventId,
      occurrenceStart,
      occurrenceEnd,
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
    if (err instanceof MeetingIdTakenError) {
      return NextResponse.json({ error: 'meeting-id-taken' }, { status: 409 });
    }
    return teamsErrorResponse(err);
  }
}
