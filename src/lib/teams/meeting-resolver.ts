import { graphJson } from '@/lib/teams/graph-client';
import { validateTeamsUrl } from '@/lib/teams/url';
import { graphDate } from '@/lib/teams/graph-dates';

/**
 * Turning a join link (or a Graph meeting id) into everything the rest of the
 * Teams integration needs: the `onlineMeeting` id we poll artifacts from, the
 * scheduled window the poller waits for, and whether the signed-in user is the
 * organizer — because only the organizer may arm the meeting (plan §3).
 *
 * Delegated auth means `/me/onlineMeetings` only ever returns meetings the
 * signed-in user is invited to, so "no match" genuinely means "not invited"
 * rather than "does not exist".
 */

export interface ResolvedMeetingOptions {
  allowRecording: boolean | null;
  allowTranscription: boolean | null;
  recordAutomatically: boolean | null;
  meetingSpokenLanguageTag: string | null;
}

export interface ResolvedMeeting {
  graphMeetingId: string;
  joinUrl: string;
  subject: string | null;
  organizerId: string | null;
  isOrganizer: boolean;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  meetingType: string | null;
  options: ResolvedMeetingOptions;
}

export type ResolveErrorCode = 'invalid-url' | 'wrong-host' | 'not_invited';

/** Danish, user-safe messages: these all surface directly in the paste-a-link box. */
const RESOLVE_MESSAGES: Record<ResolveErrorCode, string> = {
  'invalid-url': 'Linket er ikke en gyldig URL.',
  'wrong-host': 'Linket er ikke et Teams-mødelink.',
  not_invited:
    'Vi kunne ikke finde mødet. Du skal være inviteret til mødet med den Microsoft-konto, du er logget ind med.',
};

export class ResolveError extends Error {
  readonly code: ResolveErrorCode;

  constructor(code: ResolveErrorCode, message?: string) {
    super(message ?? RESOLVE_MESSAGES[code]);
    this.name = 'ResolveError';
    this.code = code;
  }
}

// ─── Graph wire shapes (only the fields we $select / read) ───────────────────

interface GraphIdentitySet {
  user?: { id?: string | null } | null;
}

interface GraphOnlineMeeting {
  id?: string | null;
  joinWebUrl?: string | null;
  joinUrl?: string | null;
  subject?: string | null;
  startDateTime?: string | null;
  endDateTime?: string | null;
  meetingType?: string | null;
  allowRecording?: boolean | null;
  allowTranscription?: boolean | null;
  recordAutomatically?: boolean | null;
  meetingSpokenLanguageTag?: string | null;
  participants?: { organizer?: { identity?: GraphIdentitySet | null } | null } | null;
}

export interface GraphMe {
  id: string | null;
  mail: string | null;
  userPrincipalName: string | null;
}

/**
 * The signed-in user's own Graph identity. `mail` is null for accounts without
 * a mailbox, which is why the calendar organizer comparison falls back to
 * `userPrincipalName`.
 */
export async function getGraphMe(userId: string): Promise<GraphMe> {
  const me = await graphJson<Partial<GraphMe>>(userId, '/me?$select=id,mail,userPrincipalName');
  return {
    id: me?.id ?? null,
    mail: me?.mail ?? null,
    userPrincipalName: me?.userPrincipalName ?? null,
  };
}

function organizerIdOf(meeting: GraphOnlineMeeting): string | null {
  return meeting.participants?.organizer?.identity?.user?.id ?? null;
}

function toResolved(meeting: GraphOnlineMeeting, meId: string | null): ResolvedMeeting {
  const organizerId = organizerIdOf(meeting);
  return {
    graphMeetingId: meeting.id ?? '',
    joinUrl: meeting.joinWebUrl ?? meeting.joinUrl ?? '',
    subject: meeting.subject ?? null,
    organizerId,
    // Never "true by default": a missing organizer id must not let an invitee
    // believe they can arm the meeting.
    isOrganizer: Boolean(organizerId && meId && organizerId === meId),
    // Not `?? null`: Graph sends 0001-01-01T00:00:00Z rather than omitting the
    // field when a meeting has no schedule, which is every instant meeting.
    scheduledStart: graphDate(meeting.startDateTime),
    scheduledEnd: graphDate(meeting.endDateTime),
    meetingType: meeting.meetingType ?? null,
    options: {
      allowRecording: meeting.allowRecording ?? null,
      allowTranscription: meeting.allowTranscription ?? null,
      recordAutomatically: meeting.recordAutomatically ?? null,
      meetingSpokenLanguageTag: meeting.meetingSpokenLanguageTag ?? null,
    },
  };
}

/**
 * OData string literals are single-quoted and escape a quote by doubling it;
 * everything else (notably the `%` in a percent-encoded join link, and the `&`
 * of a second query parameter) has to survive as a *query-string* escape, so
 * the whole filter expression is encodeURIComponent'd afterwards.
 */
function joinUrlFilter(joinUrl: string): string {
  const literal = joinUrl.replace(/'/g, "''");
  return encodeURIComponent(`JoinWebUrl eq '${literal}'`);
}

/** Paste-a-link / calendar-toggle entry point. */
export async function resolveJoinUrl(userId: string, joinUrl: string): Promise<ResolvedMeeting> {
  const check = validateTeamsUrl(joinUrl);
  if (!check.ok) throw new ResolveError(check.reason);

  const [me, list] = await Promise.all([
    getGraphMe(userId),
    graphJson<{ value?: GraphOnlineMeeting[] }>(
      userId,
      `/me/onlineMeetings?$filter=${joinUrlFilter(check.url)}`,
    ),
  ]);

  const meeting = list?.value?.[0];
  if (!meeting) throw new ResolveError('not_invited');

  const resolved = toResolved(meeting, me.id);
  // Graph echoes its own canonical join URL; fall back to what the user pasted.
  if (!resolved.joinUrl) resolved.joinUrl = check.url;
  return resolved;
}

/** Re-read a meeting we already know the Graph id of (arming read-back, poller). */
export async function getMeeting(userId: string, graphMeetingId: string): Promise<ResolvedMeeting> {
  const [me, meeting] = await Promise.all([
    getGraphMe(userId),
    graphJson<GraphOnlineMeeting>(
      userId,
      `/me/onlineMeetings/${encodeURIComponent(graphMeetingId)}`,
    ),
  ]);
  return toResolved(meeting ?? {}, me.id);
}
