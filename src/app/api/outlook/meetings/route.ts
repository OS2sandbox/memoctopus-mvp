import { NextRequest, NextResponse } from 'next/server';
import { authenticateAddinRequest } from '@/lib/outlook/addin-auth';
import { addinErrorResponse } from '@/lib/outlook/http';
import { resolveJoinUrl } from '@/lib/teams/meeting-resolver';
import { registerTeamsMeeting } from '@/lib/teams/register';
import { listTeamsMeetingsByGraphId, type TeamsMeetingRow } from '@/lib/teams/store';
import { validateTeamsUrl } from '@/lib/teams/url';

/**
 * Arms a Teams meeting from the Outlook add-in: the same registration as the
 * dashboard's "Mødelink" box, authenticated by the add-in's Entra token instead
 * of a session cookie (see addin-auth.ts), and marked `origin = 'outlook'` so the
 * storage rule applies: the recording stays in Teams until the user opens the
 * meeting in OS2taletiltekst.
 *
 * There is no browser meeting yet, so the id is minted here, and the dashboard
 * imports the meeting from GET /api/teams/meetings the next time it loads.
 *
 * Pressing the button again finds the earlier Outlook row for the same
 * occurrence and re-arms it in place. A meeting already registered in the
 * dashboard is left exactly as it is: it lives in that browser, and turning it
 * into an Outlook row would defer it and hand its "Slå fra" to the add-in.
 */

const ACTIVE = (row: TeamsMeetingRow) => row.state !== 'ready' && row.state !== 'failed';

/** An ISO instant from the pane, or null. Anything unparseable is ignored. */
function instant(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  return a == null || b == null ? a === b : a.getTime() === b.getTime();
}

export async function POST(req: NextRequest) {
  let userId: string;
  try {
    userId = await authenticateAddinRequest(req.headers);
  } catch (err) {
    return addinErrorResponse(err);
  }

  const body = (await req.json().catch(() => null)) as
    | { joinUrl?: unknown; start?: unknown; end?: unknown }
    | null;
  const joinUrl = typeof body?.joinUrl === 'string' ? body.joinUrl.trim() : '';
  const check = validateTeamsUrl(joinUrl);
  if (!check.ok) {
    return NextResponse.json(
      { error: check.reason, message: 'Mødets Teams-link kunne ikke læses.' },
      { status: 400 },
    );
  }
  // The appointment's own times. A recurring series has one onlineMeeting whose
  // window is the series'; without the occurrence, occurrence 2+ falls outside
  // the window the pipeline accepts artifacts in.
  let occurrenceStart = instant(body?.start);
  let occurrenceEnd = instant(body?.end);
  if (!occurrenceStart || !occurrenceEnd || occurrenceEnd <= occurrenceStart) {
    occurrenceStart = null;
    occurrenceEnd = null;
  }

  try {
    const resolved = await resolveJoinUrl(userId, joinUrl);
    const rows = (await listTeamsMeetingsByGraphId(userId, resolved.graphMeetingId)).filter(ACTIVE);

    const fromDashboard = rows.find((r) => r.origin !== 'outlook');
    if (fromDashboard) {
      return NextResponse.json({
        id: fromDashboard.id,
        subject: fromDashboard.subject,
        scheduledStart: fromDashboard.scheduledStart?.toISOString() ?? null,
        scheduledEnd: fromDashboard.scheduledEnd?.toISOString() ?? null,
        isOrganizer: fromDashboard.isOrganizer,
        armed: fromDashboard.armed,
        armResult: fromDashboard.armResult,
        alreadyRegistered: true,
        managedInDashboard: true,
      });
    }

    // The same occurrence: same start, or no start known on either side.
    const reuse = rows.find(
      (r) => r.origin === 'outlook' && (occurrenceStart == null || sameInstant(r.scheduledStart, occurrenceStart)),
    ) ?? null;
    const meetingId = reuse?.id ?? `ol-${crypto.randomUUID()}`;

    const { row, armResult } = await registerTeamsMeeting(userId, {
      meetingId,
      joinUrl,
      resolved,
      occurrenceStart,
      occurrenceEnd,
      origin: 'outlook',
      // A re-arm must not reset a row that is being fetched right now.
      keepState: reuse != null,
    });

    console.log(`[outlook] ${userId} ${reuse ? 're-armed' : 'armed'} ${row.id} (${armResult})`);

    return NextResponse.json({
      id: row.id,
      subject: row.subject,
      scheduledStart: row.scheduledStart ? row.scheduledStart.toISOString() : null,
      scheduledEnd: row.scheduledEnd ? row.scheduledEnd.toISOString() : null,
      isOrganizer: row.isOrganizer,
      armed: row.armed,
      armResult,
      alreadyRegistered: reuse != null,
      managedInDashboard: false,
    });
  } catch (err) {
    return addinErrorResponse(err);
  }
}
