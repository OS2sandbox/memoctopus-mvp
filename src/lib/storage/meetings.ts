import { getDB, StoredMeeting } from './db';
import { MeetingStatus } from '@/types';
import { reportAuditEvent } from '@/lib/audit/client';

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

const sameStrings = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

export async function updateMeeting(
  id: string,
  patch: Partial<Omit<StoredMeeting, 'id' | 'createdAt'>>,
  // Machine writes (the Teams bot's roster poll) pass `automatic: true`: a roster
  // that changed because people joined or left is not a user edit, so it is not
  // reported as one. Same convention as saveTranscriptChapters.
  opts: { automatic?: boolean } = {},
): Promise<void> {
  const db = await getDB();
  const existing = await db.get('meetings', id);
  if (!existing) return;
  await db.put('meetings', { ...existing, ...patch, updatedAt: new Date().toISOString() });
  reportMeetingChanges(existing, patch, opts.automatic === true);
}

// Audit reporting is derived from what actually changed against the stored row, so
// a write that repeats the current value (the participants effect re-saving on
// mount, a redundant rename) reports nothing. Only ids, status codes and counts
// leave here: never the title or the participant names.
function reportMeetingChanges(
  existing: StoredMeeting,
  patch: Partial<Omit<StoredMeeting, 'id' | 'createdAt'>>,
  automatic: boolean,
): void {
  const id = existing.id;
  if (patch.status !== undefined && patch.status !== existing.status) {
    reportAuditEvent('meeting.status_change', id, { fromStatus: existing.status, toStatus: patch.status });
    if (patch.status === 'redacted') reportAuditEvent('meeting.redact', id);
  }
  if (patch.title !== undefined && patch.title !== existing.title) {
    reportAuditEvent('meeting.rename', id);
  }
  if (!automatic && patch.participants !== undefined && !sameStrings(patch.participants, existing.participants)) {
    reportAuditEvent('meeting.participants_edit', id, { participantCount: patch.participants.length });
  }
  if (patch.audioDeleted === true && !existing.audioDeleted) {
    reportAuditEvent('meeting.audio_delete', id);
  }
}

export async function deleteMeeting(id: string): Promise<void> {
  const db = await getDB();
  const existed = (await db.get('meetings', id)) !== undefined;
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
  if (existed) reportAuditEvent('meeting.delete', id);
}
