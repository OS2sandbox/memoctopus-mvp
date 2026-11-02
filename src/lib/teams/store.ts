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

/**
 * `pending` is written before the first attempt and stays until Graph has given a
 * definite answer, so a throttle, a restart or an expired sign-in only delays the
 * delete. The rest are final: `deleted` (gone), `recycled` (the tenant refused a
 * permanent delete, so it sits in the recycle bin), `not_found` (no such file in
 * this user's Recordings folder — typically an invitee, whose organizer holds it)
 * and `failed` (refused, ambiguous, or still unreachable after a day).
 */
export type RecordingCleanupState = 'pending' | 'deleted' | 'recycled' | 'not_found' | 'failed';

/** Outcome of the one-shot arm PATCH, kept so the UI can explain itself later. */
export type TeamsArmResult = 'armed' | 'armed_in_progress' | 'armed_late' | 'not_organizer' | 'policy_blocked';

/** Where a meeting was armed from. `null` is the dashboard's "Mødelink" box. */
export type TeamsMeetingOrigin = 'outlook';

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
  /**
   * The window was registered for one occurrence of a recurring series (by the
   * Outlook add-in or the calendar), not read from Graph. Graph's onlineMeeting
   * only knows the series' window, so the poller must not overwrite this one.
   */
  occurrenceWindow: boolean;
  state: TeamsMeetingState;
  lastPolledAt: Date | null;
  attempts: number;
  failureReason: string | null;
  transcriptId: string | null;
  recordingId: string | null;
  /**
   * Where deleting the recording from the organizer's OneDrive stands; null while
   * nothing has been queued — no recording of ours, or the user has not collected
   * the transcript yet (see {@link queueRecordingCleanup}).
   */
  recordingCleanup: RecordingCleanupState | null;
  /** When the delete was queued. The cleanup's day of retries is measured from it. */
  recordingCleanupAt: Date | null;
  /**
   * Size of the recording our own transcription was made from — what identifies
   * the file in OneDrive. Null when the transcript did not come from one.
   */
  recordingBytes: number | null;
  /**
   * Every recording to delete — more than one when recording was stopped and
   * started again. Rows from before this column hold only `recordingBytes`, so
   * reads fall back to that.
   */
  recordingSizes: number[];
  /** `'outlook'` when armed from the Outlook add-in, null for the dashboard. */
  origin: TeamsMeetingOrigin | null;
  /** When the user first opened an Outlook-armed meeting here. See {@link isDeferred}. */
  openedAt: Date | null;
  /** When the user last asked for this collected meeting again. See {@link requestRecollect}. */
  recollectedAt: Date | null;
  /**
   * Downloads of the recording that timed out or were cut off. Unlike `attempts`
   * these say nothing about Teams: the recording is there, we just cannot get it.
   */
  recordingStalls: number;
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
  | 'recordingCleanup'
  | 'recordingCleanupAt'
  | 'recordingBytes'
  | 'recordingSizes'
  | 'createdAt'
  | 'eventId'
  | 'armResult'
  | 'origin'
  | 'openedAt'
  | 'recollectedAt'
  | 'recordingStalls'
  | 'occurrenceWindow'
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

/**
 * How long an Outlook-armed meeting nobody has opened keeps its recording in
 * Teams before we stop waiting. The storage rule the DPO is asked to accept: the
 * recording stays in the organizer's OneDrive until they open the meeting in
 * OS2taletiltekst, and never for longer than this on our account.
 */
export const OUTLOOK_UNOPENED_GIVE_UP_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * An Outlook-armed meeting the user has not opened here yet. The background
 * poller leaves it alone: someone who armed it from Outlook may come back days
 * later, and a transcript fetched now would only sit on our server, uncollected,
 * until the hour-long TTL swept it. Opening the meeting (its screen, at or after
 * the scheduled start) is what starts the fetch, with the user there to collect it.
 */
export function isDeferred(row: Pick<TeamsMeetingRow, 'origin' | 'openedAt'>): boolean {
  return row.origin === 'outlook' && row.openedAt == null;
}

/**
 * Has the meeting begun? A meeting Graph gives no start for is an instant one,
 * which by definition already has.
 */
export function hasStarted(row: Pick<TeamsMeetingRow, 'scheduledStart'>, now: Date): boolean {
  const start = realDate(row.scheduledStart);
  return start == null || start.getTime() <= now.getTime();
}

/**
 * How long after a meeting a collected one may be collected again ("Hent igen")
 * while its recording is still in OneDrive — the same bound an unopened Outlook
 * meeting is kept for. Once the recording has been deleted only Teams' own
 * transcript is left, and the poller's 24 h window applies instead.
 */
export const RECOLLECT_WINDOW_MS = OUTLOOK_UNOPENED_GIVE_UP_MS;

/**
 * The instant the 24 h give-up window is measured from: the LATER of the meeting's
 * scheduled end, when we were asked to watch it, (for an Outlook-armed meeting)
 * when the user opened it, and when the user asked for a collected meeting again.
 * Opening and asking again are what start those fetches, so their window starts
 * there too, however long after the meeting it is.
 *
 * Not the scheduled end alone. A link pasted for a meeting that finished days ago
 * would be born outside its own window and answered `failed` before Graph was asked
 * even once — while Graph still had the transcript. Being handed a link now earns
 * the meeting a full window from now, whenever it was actually held.
 */
export function giveUpAnchor(
  row: Pick<TeamsMeetingRow, 'scheduledEnd' | 'createdAt'> & {
    openedAt?: Date | null;
    recollectedAt?: Date | null;
  },
): Date | null {
  // realDate, not a bare ??: rows written before the resolver filtered it carry
  // Graph's 0001-01-01 zero value, and treating that as a real scheduled end
  // makes the meeting look two thousand years overdue and abandoned on sight.
  const candidates = [
    realDate(row.scheduledEnd),
    row.createdAt ?? null,
    row.openedAt ?? null,
    row.recollectedAt ?? null,
  ]
    .filter((d): d is Date => d != null);
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (b.getTime() > a.getTime() ? b : a));
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
  occurrence_window?: boolean | null;
  state: string;
  last_polled_at: Date | string | null;
  attempts: number | string;
  failure_reason: string | null;
  transcript_id: string | null;
  recording_id: string | null;
  recording_cleanup?: string | null;
  recording_cleanup_at?: Date | string | null;
  recording_bytes?: number | string | null;
  recording_sizes?: (number | string)[] | null;
  origin?: string | null;
  opened_at?: Date | string | null;
  recollected_at?: Date | string | null;
  recording_stalls?: number | string | null;
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
    occurrenceWindow: Boolean(raw.occurrence_window),
    state: raw.state as TeamsMeetingState,
    lastPolledAt: toDate(raw.last_polled_at),
    attempts: Number(raw.attempts ?? 0),
    failureReason: raw.failure_reason ?? null,
    transcriptId: raw.transcript_id ?? null,
    recordingId: raw.recording_id ?? null,
    recordingCleanup: (raw.recording_cleanup as RecordingCleanupState | null | undefined) ?? null,
    recordingCleanupAt: toDate(raw.recording_cleanup_at ?? null),
    // BIGINT arrives as a string from pg.
    recordingBytes: raw.recording_bytes == null ? null : Number(raw.recording_bytes),
    recordingSizes: raw.recording_sizes?.length
      ? raw.recording_sizes.map(Number)
      : raw.recording_bytes == null ? [] : [Number(raw.recording_bytes)],
    origin: raw.origin === 'outlook' ? 'outlook' : null,
    openedAt: toDate(raw.opened_at ?? null),
    recollectedAt: toDate(raw.recollected_at ?? null),
    recordingStalls: Number(raw.recording_stalls ?? 0),
    createdAt: toDate(raw.created_at ?? null),
  };
}

/**
 * Every read the app makes leaves out a meeting the user has switched off. Such a
 * row exists only while its recording is still to be deleted from OneDrive (see
 * {@link markTeamsMeetingUnregistered}); the cleanup reads it directly.
 */
const REGISTERED = 'unregistered_at IS NULL';

const SELECT_COLUMNS = `
  id, graph_meeting_id, event_id, join_url, subject, organizer_id, is_organizer,
  armed, arm_result, scheduled_start, scheduled_end, occurrence_window, state,
  last_polled_at, attempts, failure_reason, transcript_id, recording_id,
  recording_cleanup, recording_cleanup_at, recording_bytes, recording_sizes, origin, opened_at,
  recollected_at, recording_stalls, created_at
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
       attempts, failure_reason, transcript_id, recording_id, origin, occurrence_window,
       updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::text, 'not_organizer'), $10, $11,
       COALESCE($12::text, 'awaiting_teams'), $13::timestamptz, COALESCE($14::int, 0),
       $15, $16, $17, $18, $19, NOW()
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
       occurrence_window = EXCLUDED.occurrence_window,
       state            = COALESCE($12::text, teams_meetings.state),
       last_polled_at   = COALESCE($13::timestamptz, teams_meetings.last_polled_at),
       attempts         = COALESCE($14::int, teams_meetings.attempts),
       failure_reason   = COALESCE($15, teams_meetings.failure_reason),
       transcript_id    = COALESCE($16, teams_meetings.transcript_id),
       recording_id     = COALESCE($17, teams_meetings.recording_id),
       -- Where it was first armed from stays: re-pasting an Outlook meeting's link
       -- in the dashboard must not lift the Outlook storage rule off it.
       origin           = COALESCE(teams_meetings.origin, EXCLUDED.origin),
       unregistered_at  = NULL,
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
      row.origin ?? null,
      row.occurrenceWindow ?? false,
    ],
  );
  // RETURNING always yields a row; the null branch keeps TypeScript honest.
  if (!result) throw new Error('upsertTeamsMeeting returned no row');
  return mapRow(result);
}

/**
 * The organizer's meeting options as they were before OS2taletiltekst ever armed
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
    `SELECT ${SELECT_COLUMNS} FROM teams_meetings WHERE id = $1 AND ${REGISTERED}`,
    [id],
  );
  return raw ? mapRow(raw) : null;
}

/** Every row for one Graph meeting (a series has one onlineMeeting for all its occurrences). */
export async function listTeamsMeetingsByGraphId(
  userId: string,
  graphMeetingId: string,
): Promise<TeamsMeetingRow[]> {
  const rows = await queryUserSchema<RawTeamsMeeting>(
    userId,
    `SELECT ${SELECT_COLUMNS} FROM teams_meetings
      WHERE graph_meeting_id = $1 AND ${REGISTERED}
      ORDER BY created_at DESC`,
    [graphMeetingId],
  );
  return rows.map(mapRow);
}

export async function listTeamsMeetings(userId: string): Promise<TeamsMeetingRow[]> {
  const rows = await queryUserSchema<RawTeamsMeeting>(
    userId,
    `SELECT ${SELECT_COLUMNS} FROM teams_meetings WHERE ${REGISTERED} ORDER BY created_at DESC`,
  );
  return rows.map(mapRow);
}

/**
 * Meetings whose artifacts should be fetched now: still waiting for Teams (or a
 * `fetching` row abandoned mid-download), past their scheduled end (or, with no
 * schedule, past when we were asked to watch them), and out of the backoff since
 * the last poll — every 2 minutes for the first {@link FAST_POLL_ATTEMPTS} polls,
 * then every 15. `needs_reauth` is listed too: the user signs in again in another
 * tab, and the next tick has to pick the meeting back up on its own.
 *
 * A row past its give-up window stays listed. Giving up is a write `pollMeeting`
 * makes, and it can only make it on a row it is handed; leaving such rows out
 * kept them in `awaiting_teams` for good.
 */
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
                      <= $1::timestamptz - ($5::int * INTERVAL '1 millisecond'))
            )
        -- Unopened Outlook meetings only once the 30-day cap has passed, to be
        -- settled (see isDeferred).
        AND (origin IS DISTINCT FROM 'outlook'
             OR opened_at IS NOT NULL
             OR GREATEST(scheduled_end, created_at)
                <= $1::timestamptz - ($6::bigint * INTERVAL '1 millisecond'))
        -- GREATEST, not COALESCE: see giveUpAnchor. GREATEST skips NULLs, so a
        -- meeting with no schedule still falls back to created_at.
        AND GREATEST(scheduled_end, created_at, opened_at, recollected_at) <= $1::timestamptz
        -- No upper bound: a row past its give-up window must still reach
        -- pollMeeting, which is what marks it failed.
        AND (last_polled_at IS NULL
             OR last_polled_at <= $1::timestamptz
                - (CASE WHEN attempts < $2::int THEN $3::int ELSE $4::int END)
                  * INTERVAL '1 millisecond')
        AND ${REGISTERED}
      ORDER BY GREATEST(scheduled_end, created_at, opened_at, recollected_at) ASC`,
    [now, FAST_POLL_ATTEMPTS, FAST_POLL_MS, SLOW_POLL_MS, STALE_FETCHING_MS, OUTLOOK_UNOPENED_GIVE_UP_MS],
  );
  return rows.map(mapRow);
}

export interface TeamsMeetingPatch {
  state?: TeamsMeetingState;
  failureReason?: string | null;
  transcriptId?: string | null;
  recordingId?: string | null;
  recordingCleanup?: RecordingCleanupState | null;
  recordingBytes?: number | null;
  recordingSizes?: number[] | null;
}

const PATCH_COLUMNS: Record<keyof TeamsMeetingPatch, string> = {
  state: 'state',
  failureReason: 'failure_reason',
  transcriptId: 'transcript_id',
  recordingId: 'recording_id',
  recordingCleanup: 'recording_cleanup',
  recordingBytes: 'recording_bytes',
  recordingSizes: 'recording_sizes',
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
  /** Count a recording download that timed out or was cut off (`recording_stalls`). */
  countRecordingStall?: boolean;
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
  { incrementAttempts = true, countRecordingStall = false }: MarkPollOptions = {},
): Promise<TeamsMeetingRow> {
  const sets = [
    ...(incrementAttempts ? ['attempts = attempts + 1'] : []),
    ...(countRecordingStall ? ['recording_stalls = recording_stalls + 1'] : []),
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

/**
 * Records that the user opened an Outlook-armed meeting here, which lifts the
 * deferral (see {@link isDeferred}). Only the first opening counts.
 */
export async function markTeamsMeetingOpened(userId: string, id: string): Promise<TeamsMeetingRow> {
  const result = await queryUserSchemaOne<RawTeamsMeeting>(
    userId,
    `UPDATE teams_meetings
        SET opened_at = COALESCE(opened_at, NOW()), updated_at = NOW()
      WHERE id = $1
      RETURNING ${SELECT_COLUMNS}`,
    [id],
  );
  if (!result) throw new Error(`markTeamsMeetingOpened: no such Teams meeting: ${id}`);
  return mapRow(result);
}

/**
 * "Hent igen": a collected meeting whose transcript the user never got goes back
 * to waiting for Teams, and earns a full give-up window from now (see
 * {@link giveUpAnchor}). Its recording gets another chance, too, however often it
 * stalled before. Only a `ready` row moves; anything else returns null.
 */
export async function requestRecollect(userId: string, id: string): Promise<TeamsMeetingRow | null> {
  const result = await queryUserSchemaOne<RawTeamsMeeting>(
    userId,
    `UPDATE teams_meetings
        SET state = 'awaiting_teams', failure_reason = NULL, recollected_at = NOW(),
            recording_stalls = 0, updated_at = NOW()
      WHERE id = $1 AND state = 'ready' AND ${REGISTERED}
      RETURNING ${SELECT_COLUMNS}`,
    [id],
  );
  return result ? mapRow(result) : null;
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

/**
 * The browser has saved this meeting's transcript, so the recording it was made
 * from can go: queue its delete from OneDrive. Not before — until then the
 * recording is what a re-collect transcribes again (the server's copy of the
 * transcript expires after an hour).
 *
 * Only a collected meeting whose transcript came from our own transcription of
 * a recording, and only once; anything else is left as it is. Returns whether a
 * delete was queued.
 */
export async function queueRecordingCleanup(userId: string, id: string): Promise<boolean> {
  const rows = await queryUserSchema<{ id: string }>(
    userId,
    `UPDATE teams_meetings
        SET recording_cleanup = 'pending', recording_cleanup_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND state = 'ready' AND recording_bytes IS NOT NULL
        AND recording_cleanup IS NULL AND ${REGISTERED}
      RETURNING id`,
    [id],
  );
  return rows.length > 0;
}

/** Rows whose recording is still waiting to be deleted from OneDrive. */
export async function listPendingRecordingCleanups(userId: string): Promise<TeamsMeetingRow[]> {
  const rows = await queryUserSchema<RawTeamsMeeting>(
    userId,
    `SELECT ${SELECT_COLUMNS} FROM teams_meetings
      WHERE recording_cleanup = 'pending' AND recording_bytes IS NOT NULL
      ORDER BY updated_at ASC`,
  );
  return rows.map(mapRow);
}

/**
 * Settles a pending cleanup. Only a row still `pending` is written, so of two runs
 * racing on the same recording the first verdict stands — the second finds the
 * file gone and would otherwise overwrite `deleted` with `not_found`.
 *
 * A row the user has switched off was only kept for this delete, so it goes now.
 */
export async function settleRecordingCleanup(
  userId: string,
  id: string,
  result: Exclude<RecordingCleanupState, 'pending'>,
): Promise<void> {
  await queryUserSchema(
    userId,
    `UPDATE teams_meetings SET recording_cleanup = $2, updated_at = NOW()
      WHERE id = $1 AND recording_cleanup = 'pending'`,
    [id, result],
  );
  await queryUserSchema(
    userId,
    `DELETE FROM teams_meetings
      WHERE id = $1 AND unregistered_at IS NOT NULL AND recording_cleanup IS DISTINCT FROM 'pending'`,
    [id],
  );
}

/**
 * Switches a meeting off without losing the delete still queued for its recording:
 * the row disappears from every read the app makes, and only the cleanup sees it
 * until {@link settleRecordingCleanup} removes it.
 */
export async function markTeamsMeetingUnregistered(userId: string, id: string): Promise<void> {
  await queryUserSchema(
    userId,
    `UPDATE teams_meetings SET unregistered_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [id],
  );
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
