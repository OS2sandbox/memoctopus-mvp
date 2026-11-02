import { resolveJoinUrl, type ResolvedMeeting } from '@/lib/teams/meeting-resolver';
import { registerTeamsMeeting } from '@/lib/teams/register';
import { listTeamsMeetingsByGraphId, type TeamsMeetingRow } from '@/lib/teams/store';

/**
 * Arming a Teams meeting on behalf of the Outlook add-in: the same registration
 * as the dashboard's "Mødelink" box, marked `origin = 'outlook'` so the storage
 * rule applies (the recording stays in Teams until the user opens the meeting in
 * OS2taletiltekst). Shared by POST /api/outlook/meetings (the link read from the
 * invitation) and POST /api/outlook/online-meetings (a meeting the add-in created).
 *
 * There is no browser meeting yet, so the id is minted here, and the dashboard
 * imports the meeting from GET /api/teams/meetings the next time it loads.
 *
 * Arming again finds the earlier Outlook row for the same occurrence and re-arms
 * it in place. A meeting already registered in the dashboard is left exactly as
 * it is: it lives in that browser, and turning it into an Outlook row would defer
 * it and hand its "Slå fra" to the add-in.
 *
 * Throws GraphError / ResolveError for the caller's error mapping.
 */

export interface ArmFromOutlookInput {
  joinUrl: string;
  /** The appointment's own times; null when unknown or not a window. */
  occurrenceStart: Date | null;
  occurrenceEnd: Date | null;
  /** Already resolved by the caller, to save a Graph call. */
  resolved?: ResolvedMeeting;
}

export interface ArmFromOutlookResult {
  id: string;
  subject: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  isOrganizer: boolean;
  armed: boolean;
  armResult: string | null;
  alreadyRegistered: boolean;
  managedInDashboard: boolean;
}

const ACTIVE = (row: TeamsMeetingRow) => row.state !== 'ready' && row.state !== 'failed';

/** An ISO instant from the pane, or null. Anything unparseable is ignored. */
export function parseInstant(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The appointment's start and end from the pane, both or neither: a window or nothing. */
export function parseWindow(start: unknown, end: unknown): { start: Date | null; end: Date | null } {
  const s = parseInstant(start);
  const e = parseInstant(end);
  return s && e && e > s ? { start: s, end: e } : { start: null, end: null };
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  return a == null || b == null ? a === b : a.getTime() === b.getTime();
}

export async function armFromOutlook(userId: string, input: ArmFromOutlookInput): Promise<ArmFromOutlookResult> {
  const { joinUrl, occurrenceStart, occurrenceEnd } = input;
  const resolved = input.resolved ?? (await resolveJoinUrl(userId, joinUrl));
  const rows = (await listTeamsMeetingsByGraphId(userId, resolved.graphMeetingId)).filter(ACTIVE);

  const fromDashboard = rows.find((r) => r.origin !== 'outlook');
  if (fromDashboard) {
    return {
      id: fromDashboard.id,
      subject: fromDashboard.subject,
      scheduledStart: fromDashboard.scheduledStart?.toISOString() ?? null,
      scheduledEnd: fromDashboard.scheduledEnd?.toISOString() ?? null,
      isOrganizer: fromDashboard.isOrganizer,
      armed: fromDashboard.armed,
      armResult: fromDashboard.armResult,
      alreadyRegistered: true,
      managedInDashboard: true,
    };
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

  return {
    id: row.id,
    subject: row.subject,
    scheduledStart: row.scheduledStart ? row.scheduledStart.toISOString() : null,
    scheduledEnd: row.scheduledEnd ? row.scheduledEnd.toISOString() : null,
    isOrganizer: row.isOrganizer,
    armed: row.armed,
    armResult,
    alreadyRegistered: reuse != null,
    managedInDashboard: false,
  };
}
