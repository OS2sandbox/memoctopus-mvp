import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { teamsGraphEnabled } from '@/lib/auth/providers';
import { teamsErrorResponse } from '@/lib/teams/http-errors';
import { disarmMeeting } from '@/lib/teams/meeting-arm';
import { pollMeeting } from '@/lib/teams/poller';
import { readPendingTranscript } from '@/lib/pending-artifacts';
import {
  POLL_GIVE_UP_MS,
  deleteTeamsMeeting,
  getTeamsMeeting,
  giveUpAnchor,
  setTeamsMeetingState,
  type TeamsMeetingRow,
} from '@/lib/teams/store';

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

/**
 * Turns Memoctopus off for a meeting: un-arm it (if we armed it) and forget it.
 *
 * The row is deleted even when the Graph side could not be undone — the user
 * asked us to stop collecting — but `disarmed: false` says the meeting may still
 * be armed in Teams (Graph failed, or TEAMS_GRAPH_ENABLED is off and there is no
 * way to reach it from here).
 */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const userId = session.user.id;

  const row = await getTeamsMeeting(userId, id);
  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // A policy-blocked arm was still PATCHed, so it has options to put back too.
  let disarmed = true;
  if (row.armed || row.armResult === 'policy_blocked') {
    try {
      await disarmMeeting(userId, row.graphMeetingId, row.originalOptions ?? null);
    } catch (err) {
      disarmed = false;
      console.error('[teams/meetings] disarm failed for', id, '- the meeting may still be armed in Teams:', err);
    }
  }

  await deleteTeamsMeeting(userId, id);
  return NextResponse.json({ ok: true, disarmed });
}

/**
 * `{ action: 'recollect' }`: the row says `ready` but the transcript it stands for
 * is no longer on the server (nobody collected it within the pending-artifacts TTL
 * and the sweep removed it). Graph still holds the artifacts, so the row is put back
 * into `awaiting_teams`; the caller then forces a poll (the same `?poll=1` that
 * "Prøv igen" uses) and the pipeline runs again. No new state.
 *
 * Refused (409) for a row that is not `ready`, and once the poller would give up on
 * the meeting anyway: pollMeeting would otherwise mark the revived row `failed` and
 * the ready state would be lost for good.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const userId = session.user.id;

  const row = await getTeamsMeeting(userId, id);
  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
  if (body?.action !== 'recollect') {
    return NextResponse.json({ error: 'unknown_action' }, { status: 400 });
  }

  // While the integration is off pollMeeting does nothing, so a revived row would wait
  // forever under a message that says it is being fetched.
  if (!teamsGraphEnabled()) return NextResponse.json({ error: 'disabled' }, { status: 403 });

  if (row.state !== 'ready') return NextResponse.json({ error: 'not_ready' }, { status: 409 });

  // The stash is still there: nothing is missing, the browser just has not collected it.
  if (await readPendingTranscript(id)) return NextResponse.json(serialize(row));

  const anchor = giveUpAnchor(row);
  if (anchor && anchor.getTime() < Date.now() - POLL_GIVE_UP_MS) {
    return NextResponse.json({ error: 'window_closed' }, { status: 409 });
  }

  await setTeamsMeetingState(userId, id, 'awaiting_teams', null);
  return NextResponse.json(serialize((await getTeamsMeeting(userId, id)) ?? row));
}
