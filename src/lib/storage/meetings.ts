import { getDB, StoredMeeting } from './db';
import { MeetingStatus } from '@/types';
import { deleteAudio } from './audio';

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
  /** A fixed id, for a meeting that already exists on the server (armed from Outlook). */
  id?: string;
  title: string;
  participants?: string[];
  source?: 'local' | 'teams';
  meetingUrl?: string | null;
  status?: MeetingStatus;
  // The audio's own recording date. Defaults to now (correct for live/Teams
  // recordings); upload flows pass the file's date so an old clip keeps its date.
  recordedAt?: string;
  // Set for a Teams meeting (a pasted link, or one armed from Outlook). Omitted for
  // local recordings. The subject becomes the title and the scheduled start the
  // recordedAt; the live values stay on the server.
  graphManaged?: boolean;
}): Promise<StoredMeeting> {
  const db = await getDB();
  const now = new Date().toISOString();
  const meeting: StoredMeeting = {
    id: data.id ?? newId(),
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
  };
  // Only write the Teams fields that were actually supplied, so a local recording's
  // record stays free of undefined keys.
  if (data.graphManaged !== undefined) meeting.graphManaged = data.graphManaged;
  await db.put('meetings', meeting);
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
}

export async function deleteMeeting(id: string): Promise<void> {
  const db = await getDB();
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
}
