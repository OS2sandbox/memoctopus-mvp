import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { listUpcomingOnlineMeetings } from '@/lib/teams/calendar';
import { teamsErrorResponse } from '@/lib/teams/http-errors';
import { listTeamsMeetings } from '@/lib/teams/store';

const DEFAULT_DAYS = 7;
const MAX_DAYS = 30;

function normalizeUrl(url: string): string {
  return url.trim().toLowerCase();
}

/**
 * The dashboard's "Kommende Teams-møder" list. Each entry carries
 * `armedMeetingId`: the id of our own meeting record when this calendar entry
 * is already registered, which is what the toggle renders from.
 */
export async function GET(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const raw = Number(req.nextUrl.searchParams.get('days'));
  const days = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX_DAYS) : DEFAULT_DAYS;

  try {
    const [meetings, registered] = await Promise.all([
      listUpcomingOnlineMeetings(session.user.id, { days }),
      listTeamsMeetings(session.user.id),
    ]);

    // Every occurrence of a recurring series shares one join URL, so keying the
    // armed lookup on it alone would render the whole series as armed against
    // the first occurrence's row. The calendar event id is per occurrence.
    const byEventId = new Map(
      registered.filter((row) => row.eventId).map((row) => [row.eventId as string, row.id]),
    );
    const byJoinUrl = new Map(
      registered.filter((row) => !row.eventId).map((row) => [normalizeUrl(row.joinUrl), row.id]),
    );

    return NextResponse.json({
      meetings: meetings.map((m) => ({
        ...m,
        armedMeetingId:
          byEventId.get(m.eventId) ??
          (m.joinUrl ? (byJoinUrl.get(normalizeUrl(m.joinUrl)) ?? null) : null),
      })),
    });
  } catch (err) {
    return teamsErrorResponse(err);
  }
}
