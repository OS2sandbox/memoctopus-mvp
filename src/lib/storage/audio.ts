import { getDB, StoredAudio } from './db';

export async function saveAudio(meetingId: string, blob: Blob, mimeType: string): Promise<void> {
  const db = await getDB();
  await db.put('audio', { meetingId, blob, mimeType });
}

export async function getAudio(meetingId: string): Promise<StoredAudio | null> {
  const db = await getDB();
  return (await db.get('audio', meetingId)) ?? null;
}

export async function deleteAudio(meetingId: string): Promise<void> {
  const db = await getDB();
  await db.delete('audio', meetingId);
}
