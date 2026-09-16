import { graphJson } from '@/lib/teams/graph-client';
import { getGraphMe } from '@/lib/teams/meeting-resolver';

/**
 * "Kommende Teams-møder" on the dashboard (plan §3): the next N days of the
 * signed-in user's online meetings, each of which can be armed with one toggle.
 *
 * `calendarView` (not `/me/events`) is what expands a recurring series into its
 * individual occurrences, which is what a user expects to see in a list of
 * "upcoming meetings" — the arming itself still targets the series' single
 * onlineMeeting.
 */

export interface CalendarMeeting {
  eventId: string;
  subject: string;
  start: string;
  end: string;
  joinUrl: string | null;
  isOrganizer: boolean;
  isRecurring: boolean;
}

const DEFAULT_DAYS = 7;
const PAGE_SIZE = 50;
/** A week of meetings fits in 150 events; more than that is a runaway query. */
const MAX_PAGES = 3;

const SELECT = 'id,subject,start,end,isOnlineMeeting,onlineMeeting,organizer,seriesMasterId,type';

interface GraphDateTimeZone {
  dateTime?: string | null;
  timeZone?: string | null;
}

interface GraphEvent {
  id?: string | null;
  subject?: string | null;
  start?: GraphDateTimeZone | null;
  end?: GraphDateTimeZone | null;
  isOnlineMeeting?: boolean | null;
  onlineMeeting?: { joinUrl?: string | null } | null;
  organizer?: { emailAddress?: { address?: string | null } | null } | null;
  seriesMasterId?: string | null;
  type?: string | null;
}

interface GraphEventPage {
  value?: GraphEvent[];
  '@odata.nextLink'?: string;
}

/**
 * Graph returns `dateTime` without a zone designator and states the zone
 * separately; we ask for UTC via the Prefer header, so appending Z is correct
 * and gives the same ISO strings the rest of the app stores.
 */
function toIso(value: GraphDateTimeZone | null | undefined): string {
  const raw = value?.dateTime?.trim();
  if (!raw) return '';
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const parsed = new Date(hasZone ? raw : `${raw}Z`);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
}

function normaliseAddress(address: string | null | undefined): string {
  return (address ?? '').trim().toLowerCase();
}

export async function listUpcomingOnlineMeetings(
  userId: string,
  opts: { days?: number; now?: Date } = {},
): Promise<CalendarMeeting[]> {
  const days = opts.days ?? DEFAULT_DAYS;
  const now = opts.now ?? new Date();
  const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const me = await getGraphMe(userId);
  const myAddresses = new Set(
    [me.mail, me.userPrincipalName].map(normaliseAddress).filter(Boolean),
  );

  const query = [
    `startDateTime=${encodeURIComponent(now.toISOString())}`,
    `endDateTime=${encodeURIComponent(end.toISOString())}`,
    `$select=${SELECT}`,
    '$orderby=start/dateTime',
    `$top=${PAGE_SIZE}`,
  ].join('&');

  // Without this header Graph renders start/end in the mailbox's own time zone.
  const init: RequestInit = { headers: { Prefer: 'outlook.timezone="UTC"' } };

  const events: GraphEvent[] = [];
  let path: string | undefined = `/me/calendarView?${query}`;
  for (let page = 0; page < MAX_PAGES && path; page += 1) {
    const body: GraphEventPage = await graphJson<GraphEventPage>(userId, path, init);
    events.push(...(body?.value ?? []));
    path = body?.['@odata.nextLink'];
  }

  return events
    .filter((event) => event.isOnlineMeeting === true && Boolean(event.onlineMeeting?.joinUrl))
    .map((event) => ({
      eventId: event.id ?? '',
      subject: event.subject ?? '(uden emne)',
      start: toIso(event.start),
      end: toIso(event.end),
      joinUrl: event.onlineMeeting?.joinUrl ?? null,
      isOrganizer:
        myAddresses.size > 0 &&
        myAddresses.has(normaliseAddress(event.organizer?.emailAddress?.address)),
      isRecurring:
        Boolean(event.seriesMasterId) ||
        event.type === 'occurrence' ||
        event.type === 'exception' ||
        event.type === 'seriesMaster',
    }));
}
