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
  title: string;
  participants?: string[];
  source?: 'local' | 'teams';
  meetingUrl?: string | null;
  status?: MeetingStatus;
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
    updatedAt: now,
    audioDurationSeconds: null,
    audioSizeBytes: 0,
    audioDeleted: false,
    botSession: null,
  };
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
