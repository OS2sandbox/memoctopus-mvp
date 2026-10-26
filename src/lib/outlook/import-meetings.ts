import { createMeeting, getMeeting } from '@/lib/storage';

/**
 * Browser side of the Outlook add-in: a meeting armed from Outlook exists only on
 * the server until a browser has seen it, because meetings otherwise live in this
 * browser's IndexedDB. This brings those meetings in, under the server's own id,
 * as ordinary Graph-managed Teams meetings, so the Arkiv lists them and opening
 * one runs the same Teams screen as a pasted link.
 *
 * A meeting already collected (`ready`) is not imported: it was collected in
 * another browser, and its transcript is no longer on the server to show here.
 */

export interface ServerTeamsMeeting {
  id: string;
  state: string;
  origin?: 'outlook';
  deferred?: boolean;
  subject?: string | null;
  joinUrl?: string;
  scheduledStart?: string | null;
  createdAt?: string | null;
}

function title(m: ServerTeamsMeeting): string {
  if (m.subject?.trim()) return m.subject.trim();
  const when = m.scheduledStart ?? m.createdAt;
  const date = when ? new Date(when) : new Date();
  return `Teams-møde · ${new Intl.DateTimeFormat('da', { day: 'numeric', month: 'long' }).format(date)}`;
}

/**
 * Fetches the caller's Teams meetings from the server and imports the Outlook
 * ones this browser does not have. Returns the server's list (the Arkiv reads its
 * states), or null when the server could not be asked — the caller then simply
 * shows what it has.
 */
export async function importOutlookMeetings(): Promise<ServerTeamsMeeting[] | null> {
  let meetings: ServerTeamsMeeting[];
  try {
    const res = await fetch('/api/teams/meetings');
    if (!res.ok) return null;
    meetings = ((await res.json()) as { meetings?: ServerTeamsMeeting[] }).meetings ?? [];
  } catch (err) {
    console.warn('[outlook] kunne ikke hente møder fra serveren:', err);
    return null;
  }

  for (const m of meetings) {
    if (m.origin !== 'outlook' || m.state === 'ready' || !m.joinUrl) continue;
    try {
      if (await getMeeting(m.id)) continue;
      await createMeeting({
        id: m.id,
        title: title(m),
        source: 'teams',
        graphManaged: true,
        meetingUrl: m.joinUrl,
        status: 'awaiting_teams',
        ...(m.subject ? { teamsSubject: m.subject } : {}),
        ...(m.scheduledStart ? { scheduledStart: m.scheduledStart, recordedAt: m.scheduledStart } : {}),
      });
    } catch (err) {
      console.warn('[outlook] kunne ikke tilføje mødet', m.id, err);
    }
  }
  return meetings;
}
