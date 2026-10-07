import { getDB, StoredMeeting } from './db';
import { MeetingStatus } from '@/types';
import { reportAuditEvent } from '@/lib/audit/client';
import type { DeleteTrigger } from '@/lib/audit/events/meeting';

export type MeetingOrigin = 'live' | 'upload' | 'bot';

function newId(): string {
  return crypto.randomUUID();
}

export async function getAllMeetings(): Promise<StoredMeeting[]> {
  const db = await getDB();
  const all = await db.getAll('meetings');
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getMeeting(id: string): Promise<StoredMeeting | null> {
  const db = await getDB();
  return (await db.get('meetings', id)) ?? null;
}

export async function createMeeting(data: {
  title: string;
  participants?: string[];
  source?: 'local' | 'teams';
  meetingUrl?: string | null;
  status?: MeetingStatus;
  // The audio's own recording date. Defaults to now (correct for live/Teams
  // recordings); upload flows pass the file's date so an old clip keeps its date.
  recordedAt?: string;
  // How the meeting came about, reported as the meeting.create audit event.
  origin: MeetingOrigin;
}): Promise<StoredMeeting> {
  const db = await getDB();
  const now = new Date().toISOString();
  const meeting: StoredMeeting = {
    id: newId(),
    title: data.title,
    participants: data.participants ?? [],
    status: data.status ?? 'recording',
    source: data.source ?? 'local',
    meetingUrl: data.meetingUrl ?? null,
    createdAt: now,
    recordedAt: data.recordedAt ?? now,
    updatedAt: now,
    audioDurationSeconds: null,
    audioSizeBytes: 0,
    audioDeleted: false,
    botSession: null,
  };
  await db.put('meetings', meeting);
  reportAuditEvent('meeting.create', meeting.id, { origin: data.origin });
  return meeting;
}

export async function updateMeeting(
  id: string,
  patch: Partial<Omit<StoredMeeting, 'id' | 'createdAt'>>,
  // Machine writes (the Teams bot's roster poll) pass `automatic: true`: a roster that
  // changed because people joined or left is not a user edit, so it is not reported as one.
  opts: { automatic?: boolean; trigger?: DeleteTrigger } = {},
): Promise<void> {
  const db = await getDB();
  const existing = await db.get('meetings', id);
  if (!existing) return;
  await db.put('meetings', { ...existing, ...patch, updatedAt: new Date().toISOString() });
  try {
    reportMeetingChanges(existing, patch, opts);
  } catch {
    // Reporting is best effort and must never turn a successful write into an error.
  }
}

// Rows written by older versions may lack the array; treat that as empty.
const sameStrings = (a: string[] | undefined, b: string[] | undefined) => {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

// Audit reporting is derived from what actually changed against the stored row, so
// a write that repeats the current value (the participants effect re-saving on
// mount) reports nothing. Reported here: redaction, audio deletion, a change of the
// participant list and of the recording date. Status changes are not audited, and neither is the
// title here: pipeline steps also write it, so a RENAME by the person is reported where the person
// makes it (settings page, minutes header) as meeting.metadata_edit. Only the opaque
// meeting id and a participant COUNT leave here, never a name or the title.
function reportMeetingChanges(
  existing: StoredMeeting,
  patch: Partial<Omit<StoredMeeting, 'id' | 'createdAt'>>,
  opts: { automatic?: boolean; trigger?: DeleteTrigger },
): void {
  const id = existing.id;
  if (patch.status === 'redacted' && existing.status !== 'redacted') reportAuditEvent('meeting.redact', id);
  if (patch.audioDeleted === true && !existing.audioDeleted) {
    reportAuditEvent('meeting.audio_delete', id, { trigger: opts.trigger ?? 'user' });
  }
  if (opts.automatic !== true && patch.recordedAt !== undefined && patch.recordedAt !== existing.recordedAt) {
    reportAuditEvent('meeting.metadata_edit', id, { field: 'recorded_at' });
  }
  if (opts.automatic !== true && patch.participants !== undefined && !sameStrings(patch.participants, existing.participants)) {
    reportAuditEvent('meeting.participants_edit', id, { participantCount: (patch.participants ?? []).length });
  }
}

export async function deleteMeeting(
  id: string,
  // Why it was deleted, for the audit log: the person asked (default) or the app did it on its own.
  opts: { trigger?: DeleteTrigger } = {},
): Promise<void> {
  const trigger = opts.trigger ?? 'user';
  // An automatic delete is reported before anything is awaited: it can run from the tab-close
  // purge (pagehide), where a frozen page never gets to a later step. It is retracted below when
  // the meeting did not exist or the delete failed (a retract only undoes an event that has not
  // been delivered yet, about a second; after that the event stays, which is accepted).
  let retract: (() => void) | undefined;
  try {
    if (trigger !== 'user') retract = reportAuditEvent('meeting.delete', id, { trigger });
  } catch {
    // Reporting never fails a delete.
  }
  try {
    await deleteMeetingRows(id, trigger, retract);
  } catch (err) {
    retract?.();
    throw err;
  }
}

async function deleteMeetingRows(id: string, trigger: DeleteTrigger, retract: (() => void) | undefined): Promise<void> {
  const db = await getDB();
  const existed = (await db.get('meetings', id)) !== undefined;
  if (!existed) retract?.();
  const tx = db.transaction(['meetings', 'transcripts', 'minutes', 'audio'], 'readwrite');

  // Find and delete transcript
  const transcriptIdx = tx.objectStore('transcripts').index('by-meeting');
  const transcripts = await transcriptIdx.getAll(id);
  await Promise.all(transcripts.map((t) => tx.objectStore('transcripts').delete(t.id)));

  // Find and delete minutes
  const minutesIdx = tx.objectStore('minutes').index('by-meeting');
  const minutesList = await minutesIdx.getAll(id);
  await Promise.all(minutesList.map((m) => tx.objectStore('minutes').delete(m.id)));

  // Delete audio and meeting
  await tx.objectStore('audio').delete(id);
  await tx.objectStore('meetings').delete(id);
  await tx.done;
  // Only a meeting that existed was deleted; a repeated call reports nothing.
  if (existed && trigger === 'user') reportAuditEvent('meeting.delete', id, { trigger });
}
