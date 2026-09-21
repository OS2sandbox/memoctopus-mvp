import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { teamsGraphEnabled } from '@/lib/auth/providers';
import { teamsErrorResponse } from '@/lib/teams/http-errors';
import { disarmMeeting } from '@/lib/teams/meeting-arm';
import { pollMeeting } from '@/lib/teams/poller';
import { deleteTeamsMeeting, getTeamsMeeting, type TeamsMeetingRow } from '@/lib/teams/store';

function serialize(row: TeamsMeetingRow) {
  return {
    id: row.id,
    state: row.state,
    armed: row.armed,
    armResult: row.armResult,
    isOrganizer: row.isOrganizer,
    subject: row.subject,
    scheduledStart: row.scheduledStart ? row.scheduledStart.toISOString() : null,
    scheduledEnd: row.scheduledEnd ? row.scheduledEnd.toISOString() : null,
    failureReason: row.failureReason,
    lastPolledAt: row.lastPolledAt ? row.lastPolledAt.toISOString() : null,
    // Lets the screen say "switched off" instead of showing a state that can no
    // longer change, and instead of asking for a sign-in that cannot help.
    enabled: teamsGraphEnabled(),
  };
}

/**
 * Status of one registered Teams meeting. `?poll=1` runs the poller for it
 * first (the "Tjek nu" button); the poller itself is a no-op while the meeting
 * has not ended yet, so this stays cheap.
 *
 * Ownership: the row lives in the caller's own per-user schema, so a row that
 * is not theirs simply does not exist → 404.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const userId = session.user.id;

  let row = await getTeamsMeeting(userId, id);
  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  if (req.nextUrl.searchParams.get('poll') === '1') {
    try {
      // A forced poll is also the "Prøv igen" button, so it has to be able to
      // revive a row the poller has already written off as failed.
      row = await pollMeeting(userId, id, new Date(), { force: true });
    } catch (err) {
      return teamsErrorResponse(err);
    }
  }

  return NextResponse.json(serialize(row));
}

/** Turns Memoctopus off for a meeting: un-arm it (if we armed it) and forget it. */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const userId = session.user.id;

  const row = await getTeamsMeeting(userId, id);
  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  if (row.armed) {
    // A failed disarm must not block deletion — the user asked us to stop.
    try {
      await disarmMeeting(userId, row.graphMeetingId);
    } catch (err) {
      console.error('[teams/meetings] disarm failed for', id, err);
    }
  }

  await deleteTeamsMeeting(userId, id);
  return NextResponse.json({ ok: true });
}
