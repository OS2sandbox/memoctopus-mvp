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

export async function updateMeeting(
  id: string,
  patch: Partial<Omit<StoredMeeting, 'id' | 'createdAt'>>,
): Promise<void> {
  const db = await getDB();
  const existing = await db.get('meetings', id);
  if (!existing) return;
  await db.put('meetings', { ...existing, ...patch, updatedAt: new Date().toISOString() });
  try {
    reportMeetingChanges(existing, patch);
  } catch {
    // Reporting is best effort and must never turn a successful write into an error.
  }
}

// Audit reporting is derived from what actually changed against the stored row, so
// a write that repeats the current value reports nothing. Only two transitions are
// reported here (redaction and audio deletion); status changes, renames and
// participant edits are not audited. Only the opaque meeting id leaves here.
function reportMeetingChanges(
  existing: StoredMeeting,
  patch: Partial<Omit<StoredMeeting, 'id' | 'createdAt'>>,
): void {
  const id = existing.id;
  if (patch.status === 'redacted' && existing.status !== 'redacted') reportAuditEvent('meeting.redact', id);
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
