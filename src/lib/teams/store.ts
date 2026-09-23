import { pool } from '@/lib/db';
import { realDate } from '@/lib/teams/graph-dates';
import { queryUserSchema, queryUserSchemaOne } from '@/lib/db/user-schema';
import type { ResolvedMeetingOptions } from '@/lib/teams/meeting-resolver';

/**
 * Server-side record of a Teams meeting that Microsoft Graph will produce
 * artifacts for. The client still owns the meeting itself (IndexedDB); this
 * table exists so a server-side poller knows what to fetch and when.
 */

export type TeamsMeetingState =
  | 'awaiting_teams'
  | 'fetching'
  | 'ready'
  | 'failed'
  | 'needs_reauth';

/** Outcome of the one-shot arm PATCH, kept so the UI can explain itself later. */
export type TeamsArmResult = 'armed' | 'armed_in_progress' | 'not_organizer' | 'policy_blocked';

export interface TeamsMeetingRow {
  id: string;
  graphMeetingId: string;
  /** Calendar occurrence this row was armed from, when the client knew it. */
  eventId: string | null;
  joinUrl: string;
  subject: string | null;
  organizerId: string | null;
  isOrganizer: boolean;
  armed: boolean;
  armResult: TeamsArmResult;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  state: TeamsMeetingState;
  lastPolledAt: Date | null;
  attempts: number;
  failureReason: string | null;
  transcriptId: string | null;
  recordingId: string | null;
  createdAt: Date | null;
}

/** Fields every caller must supply; the rest have server-side defaults. */
export type TeamsMeetingInput = Omit<
  TeamsMeetingRow,
  | 'state'
  | 'lastPolledAt'
  | 'attempts'
  | 'failureReason'
  | 'transcriptId'
  | 'recordingId'
  | 'createdAt'
  | 'eventId'
  | 'armResult'
> &
  Partial<TeamsMeetingRow>;

// ─── Polling policy ─────────────────────────────────────────────────────────

/** Poll every 2 min for the first 15 attempts (~30 min), then every 15 min. */
export const FAST_POLL_ATTEMPTS = 15;
const FAST_POLL_MS = 2 * 60 * 1000;
const SLOW_POLL_MS = 15 * 60 * 1000;

/** After this long past the scheduled end we stop polling and give up. */
export const POLL_GIVE_UP_MS = 24 * 60 * 60 * 1000;

/**
 * A row parked in `fetching` for longer than this was abandoned mid-download —
 * a deploy, a crash, or an OOM on a hundreds-of-MB recording. Without this it
 * would never be re-listed, never given up on, and never surface as failed.
 */
export const STALE_FETCHING_MS = 30 * 60 * 1000;

/** States the poller picks up on its own (`fetching` only once it is stale). */
const POLLABLE_STATES = ['awaiting_teams', 'needs_reauth'] as const;

export function pollBackoffMs(attempts: number): number {
  return attempts < FAST_POLL_ATTEMPTS ? FAST_POLL_MS : SLOW_POLL_MS;
}

/**
 * Pure mirror of the SQL filter in {@link listDueTeamsMeetings}. A meeting is
 * due when it is still waiting for Teams, its scheduled end has passed (or is
 * unknown), the backoff since the last poll has elapsed, and we have not yet
 * given up on it.
 */
export function isTeamsMeetingDue(row: TeamsMeetingRow, now: Date): boolean {
  const nowMs = now.getTime();

  // `needs_reauth` is pollable: the user re-consents in another tab and the very
  // next backoff tick has to pick the meeting back up on its own.
  const pollable = (POLLABLE_STATES as readonly string[]).includes(row.state);
  const staleFetching =
    row.state === 'fetching' &&
    (row.lastPolledAt ?? row.createdAt) != null &&
    (row.lastPolledAt ?? row.createdAt)!.getTime() <= nowMs - STALE_FETCHING_MS;
  if (!pollable && !staleFetching) return false;

  // A meeting with no schedule (ad-hoc "Mød nu", or a link whose window Graph
  // omits) is bounded by when we were asked to watch it, so it still gives up.
  const bound = giveUpAnchor(row);
  if (bound) {
    const boundMs = bound.getTime();
    if (boundMs > nowMs) return false;
    // A row we have never actually polled is never abandoned on the clock alone:
    // the window can elapse while TEAMS_GRAPH_ENABLED is off or the instance is
    // down, and Graph keeps artifacts far longer than our 24 h.
    if (boundMs < nowMs - POLL_GIVE_UP_MS && row.lastPolledAt != null) return false;
  }
  if (row.lastPolledAt && row.lastPolledAt.getTime() > nowMs - pollBackoffMs(row.attempts)) {
    return false;
  }
  return true;
}

/**
 * The instant the 24 h give-up window is measured from: the LATER of the meeting's
 * scheduled end and when we were asked to watch it.
 *
 * Not the scheduled end alone. A link pasted for a meeting that finished days ago
 * would be born outside its own window and answered `failed` before Graph was asked
 * even once — while Graph still had the transcript. Being handed a link now earns
 * the meeting a full window from now, whenever it was actually held.
 */
export function giveUpAnchor(row: Pick<TeamsMeetingRow, 'scheduledEnd' | 'createdAt'>): Date | null {
  // realDate, not a bare ??: rows written before the resolver filtered it carry
  // Graph's 0001-01-01 zero value, and treating that as a real scheduled end
  // makes the meeting look two thousand years overdue and abandoned on sight.
  const end = realDate(row.scheduledEnd);
  const created = row.createdAt ?? null;
  if (!end) return created;
  if (!created) return end;
  return end.getTime() >= created.getTime() ? end : created;
}

// ─── Row mapping ────────────────────────────────────────────────────────────

interface RawTeamsMeeting {
  id: string;
  graph_meeting_id: string;
  event_id: string | null;
  join_url: string;
  subject: string | null;
  organizer_id: string | null;
  is_organizer: boolean;
  armed: boolean;
  arm_result: string | null;
  scheduled_start: Date | string | null;
  scheduled_end: Date | string | null;
  state: string;
  last_polled_at: Date | string | null;
  attempts: number | string;
  failure_reason: string | null;
  transcript_id: string | null;
  recording_id: string | null;
  created_at?: Date | string | null;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  return value instanceof Date ? value : new Date(value);
}

function mapRow(raw: RawTeamsMeeting): TeamsMeetingRow {
  return {
    id: raw.id,
    graphMeetingId: raw.graph_meeting_id,
    eventId: raw.event_id ?? null,
    joinUrl: raw.join_url,
    subject: raw.subject ?? null,
    organizerId: raw.organizer_id ?? null,
    isOrganizer: Boolean(raw.is_organizer),
    armed: Boolean(raw.armed),
    armResult: (raw.arm_result as TeamsArmResult | null) ?? (raw.armed ? 'armed' : 'not_organizer'),
    scheduledStart: toDate(raw.scheduled_start),
    scheduledEnd: toDate(raw.scheduled_end),
    state: raw.state as TeamsMeetingState,
    lastPolledAt: toDate(raw.last_polled_at),
    attempts: Number(raw.attempts ?? 0),
    failureReason: raw.failure_reason ?? null,
    transcriptId: raw.transcript_id ?? null,
    recordingId: raw.recording_id ?? null,
    createdAt: toDate(raw.created_at ?? null),
  };
}

const SELECT_COLUMNS = `
  id, graph_meeting_id, event_id, join_url, subject, organizer_id, is_organizer,
  armed, arm_result, scheduled_start, scheduled_end, state, last_polled_at,
  attempts, failure_reason, transcript_id, recording_id, created_at
`;

// ─── Queries ────────────────────────────────────────────────────────────────

/**
 * Insert or update by our own meeting id. Identity fields (graph id, join url,
 * subject, organizer, armed, schedule) are always overwritten; the poller-owned
 * fields (state, attempts, …) are only overwritten when explicitly supplied.
 */
export async function upsertTeamsMeeting(
  userId: string,
  row: TeamsMeetingInput,
): Promise<TeamsMeetingRow> {
  const result = await queryUserSchemaOne<RawTeamsMeeting>(
    userId,
    `INSERT INTO teams_meetings (
       id, graph_meeting_id, event_id, join_url, subject, organizer_id, is_organizer,
       armed, arm_result, scheduled_start, scheduled_end, state, last_polled_at,
       attempts, failure_reason, transcript_id, recording_id, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::text, 'not_organizer'), $10, $11,
       COALESCE($12::text, 'awaiting_teams'), $13::timestamptz, COALESCE($14::int, 0),
       $15, $16, $17, NOW()
     )
     ON CONFLICT (id) DO UPDATE SET
       graph_meeting_id = EXCLUDED.graph_meeting_id,
       event_id         = COALESCE(EXCLUDED.event_id, teams_meetings.event_id),
       join_url         = EXCLUDED.join_url,
       subject          = EXCLUDED.subject,
       organizer_id     = EXCLUDED.organizer_id,
       is_organizer     = EXCLUDED.is_organizer,
       armed            = EXCLUDED.armed,
       arm_result       = COALESCE($9::text, teams_meetings.arm_result),
       scheduled_start  = EXCLUDED.scheduled_start,
       scheduled_end    = EXCLUDED.scheduled_end,
       state            = COALESCE($12::text, teams_meetings.state),
       last_polled_at   = COALESCE($13::timestamptz, teams_meetings.last_polled_at),
       attempts         = COALESCE($14::int, teams_meetings.attempts),
       failure_reason   = COALESCE($15, teams_meetings.failure_reason),
       transcript_id    = COALESCE($16, teams_meetings.transcript_id),
       recording_id     = COALESCE($17, teams_meetings.recording_id),
       updated_at       = NOW()
     RETURNING ${SELECT_COLUMNS}`,
    [
      row.id,
      row.graphMeetingId,
      row.eventId ?? null,
      row.joinUrl,
      row.subject ?? null,
      row.organizerId ?? null,
      row.isOrganizer ?? false,
      row.armed ?? false,
      row.armResult ?? null,
      row.scheduledStart ?? null,
      row.scheduledEnd ?? null,
      row.state ?? null,
      row.lastPolledAt ?? null,
      row.attempts ?? null,
      row.failureReason ?? null,
      row.transcriptId ?? null,
      row.recordingId ?? null,
    ],
  );
  // RETURNING always yields a row; the null branch keeps TypeScript honest.
  if (!result) throw new Error('upsertTeamsMeeting returned no row');
  return mapRow(result);
}

/**
 * The organizer's meeting options as they were before Memoctopus ever armed
 * this Graph meeting, so disarming can put them back — one snapshot per
 * `graphMeetingId`, not per local id: a recurring series shares one
 * onlineMeeting but mints a new local id per pasted link, and the *first*
 * local id to arm it is the only one that ever saw the true pre-arm state.
 *
 * `previousOptions` is only stored the first time this is called for a given
 * `graphMeetingId` — the `DO UPDATE` is a no-op (it writes the row's own key
 * back onto itself) purely so `RETURNING` still yields a row on conflict, so
 * every caller gets back the one canonical snapshot regardless of who wrote
 * it. A caller that lost the race (2nd+ local id, or a re-arm reading back
 * our own PATCH) gets the original organizer values, not its own.
 */
export async function claimMeetingSnapshot(
  userId: string,
  graphMeetingId: string,
  previousOptions: ResolvedMeetingOptions | null,
): Promise<ResolvedMeetingOptions | null> {
  const result = await queryUserSchemaOne<{ original_options: ResolvedMeetingOptions | null }>(
    userId,
    `INSERT INTO teams_meeting_snapshots (graph_meeting_id, original_options)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (graph_meeting_id) DO UPDATE SET
       graph_meeting_id = teams_meeting_snapshots.graph_meeting_id
     RETURNING original_options`,
    [graphMeetingId, previousOptions ? JSON.stringify(previousOptions) : null],
  );
  return result?.original_options ?? null;
}

/** Read-only lookup of the snapshot {@link claimMeetingSnapshot} recorded, for disarming. */
export async function getMeetingSnapshot(
  userId: string,
  graphMeetingId: string,
): Promise<ResolvedMeetingOptions | null> {
  const result = await queryUserSchemaOne<{ original_options: ResolvedMeetingOptions | null }>(
    userId,
    `SELECT original_options FROM teams_meeting_snapshots WHERE graph_meeting_id = $1`,
    [graphMeetingId],
  );
  return result?.original_options ?? null;
}

export async function getTeamsMeeting(
  userId: string,
  id: string,
): Promise<TeamsMeetingRow | null> {
  const raw = await queryUserSchemaOne<RawTeamsMeeting>(
    userId,
    `SELECT ${SELECT_COLUMNS} FROM teams_meetings WHERE id = $1`,
    [id],
  );
  return raw ? mapRow(raw) : null;
}

export async function getTeamsMeetingByGraphId(
  userId: string,
  graphMeetingId: string,
): Promise<TeamsMeetingRow | null> {
  const raw = await queryUserSchemaOne<RawTeamsMeeting>(
    userId,
    `SELECT ${SELECT_COLUMNS} FROM teams_meetings
      WHERE graph_meeting_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [graphMeetingId],
  );
  return raw ? mapRow(raw) : null;
}

export async function listTeamsMeetings(userId: string): Promise<TeamsMeetingRow[]> {
  const rows = await queryUserSchema<RawTeamsMeeting>(
    userId,
    `SELECT ${SELECT_COLUMNS} FROM teams_meetings ORDER BY created_at DESC`,
  );
  return rows.map(mapRow);
}

/** Meetings whose artifacts should be fetched now. See {@link isTeamsMeetingDue}. */
export async function listDueTeamsMeetings(
  userId: string,
  now: Date,
): Promise<TeamsMeetingRow[]> {
  const rows = await queryUserSchema<RawTeamsMeeting>(
    userId,
    `SELECT ${SELECT_COLUMNS} FROM teams_meetings
      WHERE (
              state IN ('awaiting_teams', 'needs_reauth')
              OR (state = 'fetching'
                  AND COALESCE(last_polled_at, created_at)
                      <= $1::timestamptz - ($6::int * INTERVAL '1 millisecond'))
            )
        -- GREATEST, not COALESCE: see giveUpAnchor. GREATEST skips NULLs, so a
        -- meeting with no schedule still falls back to created_at.
        AND GREATEST(scheduled_end, created_at) <= $1::timestamptz
        AND (last_polled_at IS NULL
             OR GREATEST(scheduled_end, created_at)
                >= $1::timestamptz - ($2::int * INTERVAL '1 millisecond'))
        AND (last_polled_at IS NULL
             OR last_polled_at <= $1::timestamptz
                - (CASE WHEN attempts < $3::int THEN $4::int ELSE $5::int END)
                  * INTERVAL '1 millisecond')
      ORDER BY GREATEST(scheduled_end, created_at) ASC`,
    [now, POLL_GIVE_UP_MS, FAST_POLL_ATTEMPTS, FAST_POLL_MS, SLOW_POLL_MS, STALE_FETCHING_MS],
  );
  return rows.map(mapRow);
}

export interface TeamsMeetingPatch {
  state?: TeamsMeetingState;
  failureReason?: string | null;
  transcriptId?: string | null;
  recordingId?: string | null;
}

const PATCH_COLUMNS: Record<keyof TeamsMeetingPatch, string> = {
  state: 'state',
  failureReason: 'failure_reason',
  transcriptId: 'transcript_id',
  recordingId: 'recording_id',
};

export interface MarkPollOptions {
  /**
   * `attempts` is what ends the wait for a recording (RECORDING_GRACE_ATTEMPTS)
   * and moves a meeting from the 2-minute to the 15-minute backoff, so it has
   * to count polls that actually asked Teams something — not a throttle, an
   * outage, or a user pressing "Tjek nu". `last_polled_at` is stamped either
   * way, or a throttled meeting would be due again on the very next tick.
   */
  incrementAttempts?: boolean;
}

/**
 * Records one poll: stamps `last_polled_at`, applies the patch, and by default
 * bumps `attempts`. Returns the updated row via `RETURNING` — every caller
 * needs the fresh row right after writing it, so this saves them a re-SELECT.
 */
export async function markPollAttempt(
  userId: string,
  id: string,
  patch: TeamsMeetingPatch = {},
  { incrementAttempts = true }: MarkPollOptions = {},
): Promise<TeamsMeetingRow> {
  const sets = [
    ...(incrementAttempts ? ['attempts = attempts + 1'] : []),
    'last_polled_at = NOW()',
    'updated_at = NOW()',
  ];
  const params: unknown[] = [id];

  for (const key of Object.keys(PATCH_COLUMNS) as (keyof TeamsMeetingPatch)[]) {
    if (!(key in patch)) continue;
    params.push(patch[key] ?? null);
    sets.push(`${PATCH_COLUMNS[key]} = $${params.length}`);
  }

  const result = await queryUserSchemaOne<RawTeamsMeeting>(
    userId,
    `UPDATE teams_meetings SET ${sets.join(', ')} WHERE id = $1 RETURNING ${SELECT_COLUMNS}`,
    params,
  );
  if (!result) throw new Error(`markPollAttempt: no such Teams meeting: ${id}`);
  return mapRow(result);
}

/**
 * Writes back what Graph currently says about the meeting itself — its window and
 * subject — without touching any polling state.
 *
 * The booked window is a snapshot taken once at registration, and organizers move,
 * rename and shorten meetings afterwards. Left stale it decides when we are allowed
 * to poll and which artifact we accept, so a rescheduled meeting is polled at the
 * wrong time or, moved more than the give-up window, never polled at all.
 *
 * Returns the updated row via `RETURNING`, for the same reason as
 * {@link markPollAttempt}.
 */
export async function refreshTeamsMeetingSchedule(
  userId: string,
  id: string,
  fields: { scheduledStart: Date | null; scheduledEnd: Date | null; subject: string | null },
): Promise<TeamsMeetingRow> {
  const result = await queryUserSchemaOne<RawTeamsMeeting>(
    userId,
    `UPDATE teams_meetings
        SET scheduled_start = $2, scheduled_end = $3,
            subject = COALESCE($4, subject),
            updated_at = NOW()
      WHERE id = $1
      RETURNING ${SELECT_COLUMNS}`,
    [id, fields.scheduledStart, fields.scheduledEnd, fields.subject],
  );
  if (!result) throw new Error(`refreshTeamsMeetingSchedule: no such Teams meeting: ${id}`);
  return mapRow(result);
}

/** Returns the updated row via `RETURNING`, for the same reason as {@link markPollAttempt}. */
export async function setTeamsMeetingState(
  userId: string,
  id: string,
  state: TeamsMeetingState,
  failureReason: string | null = null,
): Promise<TeamsMeetingRow> {
  const result = await queryUserSchemaOne<RawTeamsMeeting>(
    userId,
    `UPDATE teams_meetings
        SET state = $2, failure_reason = $3, updated_at = NOW()
      WHERE id = $1
      RETURNING ${SELECT_COLUMNS}`,
    [id, state, failureReason],
  );
  if (!result) throw new Error(`setTeamsMeetingState: no such Teams meeting: ${id}`);
  return mapRow(result);
}

export async function deleteTeamsMeeting(userId: string, id: string): Promise<void> {
  await queryUserSchema(userId, `DELETE FROM teams_meetings WHERE id = $1`, [id]);
}

// ─── Cross-user discovery ───────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Inverse of `getUserSchemaName()`: `u_<userId with - replaced by _>`.
 * User ids are either UUIDs (dashes were escaped) or opaque ids without
 * dashes, so restoring dashes is only correct when the result is a UUID.
 */
export function userIdFromSchemaName(schema: string): string | null {
  if (!schema.startsWith('u_')) return null;
  const body = schema.slice(2);
  if (!body) return null;
  const dashed = body.replace(/_/g, '-');
  return UUID_RE.test(dashed) ? dashed : body;
}

/** Every user id that has a per-user schema — the poller's work list. */
export async function listUserSchemaIds(): Promise<string[]> {
  const result = await pool.query<{ schema_name: string }>(
    `SELECT schema_name FROM information_schema.schemata
      WHERE schema_name LIKE 'u\\_%'
      ORDER BY schema_name`,
  );
  return result.rows
    .map((r) => userIdFromSchemaName(r.schema_name))
    .filter((id): id is string => Boolean(id));
}
