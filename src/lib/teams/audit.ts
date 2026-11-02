// Audit events of the Microsoft Teams (Graph) integration, in one place so that every emit site
// passes the same closed vocabulary and none can pass content: only booleans, closed enums, a
// short failure code and the meeting's UUID. Never a subject, join URL, Graph meeting id, name,
// file name or raw error message (see events/teams.ts and docs/central-access/audit.md).
//
// Every function here is best-effort and NEVER throws or rejects: recordEvent already drops an
// unwritable event with a content-free warning, and the wait is capped, so a slow audit database
// can neither break the Teams flow (poller, hand-off, sweep) nor hold up the person's response.
import type { AuditEventOf } from '@/lib/audit/events';
import { recordEvent, recordServerEvent, UUID_RE } from '@/lib/audit/record';
import type { HeaderSource } from '@/lib/audit/request-context';
import { withTimeout } from '@/lib/audit/with-timeout';
import type { ArmResult } from './meeting-arm';
import type { RecordingCleanupState } from './store';

/** How long a caller waits for its audit write at most; the write itself carries on in the background. */
const AUDIT_WAIT_MS = 2_000;

/**
 * The meeting id is chosen by the browser and the Teams routes accept anything matching /^[\w-]+$/,
 * so it only becomes the audit entity when it is a well-formed UUID (the browser's crypto.randomUUID()
 * in practice); otherwise the event is logged without an entity.
 */
function entity(meetingId: string): { entityId?: string } {
  return UUID_RE.test(meetingId) ? { entityId: meetingId } : {};
}

async function emit(label: string, write: () => Promise<unknown>): Promise<void> {
  try {
    if (await withTimeout(write(), AUDIT_WAIT_MS)) console.warn(`[teams/audit] ${label} timed out`);
  } catch {
    // recordEvent does not reject; this only guards a bug in the wiring. Nothing here may leak into the flow.
  }
}

type Req = HeaderSource;

/** POST /api/teams/meetings. After a failure only `code` is certain; what is known of the arm step is passed along. */
export function recordTeamsRegister(
  req: Req,
  run: {
    userId: string;
    meetingId: string;
    outcome: 'success' | 'error';
    armed?: boolean;
    isOrganizer?: boolean;
    armResult?: ArmResult;
    code?: string;
  },
): Promise<void> {
  const event: AuditEventOf<'teams.meeting_register'> = {
    type: 'teams.meeting_register',
    actorUserId: run.userId,
    outcome: run.outcome,
    ...entity(run.meetingId),
    details: {
      ...(run.armed !== undefined ? { armed: run.armed } : {}),
      ...(run.isOrganizer !== undefined ? { isOrganizer: run.isOrganizer } : {}),
      ...(run.armResult !== undefined ? { armResult: run.armResult } : {}),
      ...(run.code ? { code: run.code } : {}),
    },
  };
  return emit('teams.meeting_register', () => recordServerEvent(req, event));
}

/** DELETE /api/teams/meetings/[id]. `code` is only given when the options in Teams could not be put back. */
export function recordTeamsUnregister(
  req: Req,
  run: { userId: string; meetingId: string; disarmed: boolean; code?: string },
): Promise<void> {
  const event: AuditEventOf<'teams.meeting_unregister'> = {
    type: 'teams.meeting_unregister',
    actorUserId: run.userId,
    outcome: run.disarmed ? 'success' : 'error',
    ...entity(run.meetingId),
    details: { disarmed: run.disarmed, ...(run.code ? { code: run.code } : {}) },
  };
  return emit('teams.meeting_unregister', () => recordServerEvent(req, event));
}

/**
 * A fetch from Graph reached a verdict. 'poller' = the background poller (source 'system'), 'manual' =
 * the person asked for it ("Tjek nu", "Prøv igen"; source 'server'); the owning person is the actor in both.
 */
export function recordTeamsArtifactsFetch(run: {
  userId: string;
  meetingId: string;
  trigger: 'poller' | 'manual';
  result: 'ready' | 'failed';
  transcript: boolean;
  recording: boolean;
  code?: string;
}): Promise<void> {
  const event: AuditEventOf<'teams.artifacts_fetch'> = {
    type: 'teams.artifacts_fetch',
    source: run.trigger === 'manual' ? 'server' : 'system',
    actorUserId: run.userId,
    outcome: run.result === 'ready' ? 'success' : 'error',
    ...entity(run.meetingId),
    details: {
      trigger: run.trigger,
      result: run.result,
      transcript: run.transcript,
      recording: run.recording,
      ...(run.code ? { code: run.code } : {}),
    },
  };
  return emit('teams.artifacts_fetch', () => recordEvent(event));
}

/** The recording's verdict on the organizer's OneDrive (never 'pending'); 'failed' is an error outcome. */
export function recordTeamsRecordingDelete(run: {
  userId: string;
  meetingId: string;
  status: Exclude<RecordingCleanupState, 'pending'>;
}): Promise<void> {
  const event: AuditEventOf<'teams.recording_delete'> = {
    type: 'teams.recording_delete',
    source: 'system',
    actorUserId: run.userId,
    outcome: run.status === 'failed' ? 'error' : 'success',
    ...entity(run.meetingId),
    details: { status: run.status },
  };
  return emit('teams.recording_delete', () => recordEvent(event));
}

/**
 * The server-held copy of a Teams result was deleted. handoff = the browser acknowledged it (source 'server',
 * the person as actor), ttl = the retention sweep (source 'system'; the actor is the owner when the stash
 * still named one). `failed` = the file could not be removed.
 */
export function recordTeamsStashDelete(run: {
  trigger: 'handoff' | 'ttl';
  meetingId: string;
  userId?: string | null;
  failed?: boolean;
}): Promise<void> {
  const event: AuditEventOf<'teams.stash_delete'> = {
    type: 'teams.stash_delete',
    source: run.trigger === 'handoff' ? 'server' : 'system',
    ...(run.userId ? { actorUserId: run.userId } : {}),
    ...(run.failed ? { outcome: 'error' as const } : {}),
    ...entity(run.meetingId),
    details: { trigger: run.trigger },
  };
  return emit('teams.stash_delete', () => recordEvent(event));
}
