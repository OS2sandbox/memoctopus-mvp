import { getDB, StoredAudio } from './db';
import { reportAuditEvent } from '@/lib/audit/client';

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
  const existed = (await db.get('audio', meetingId)) !== undefined;
  await db.delete('audio', meetingId);
  // Standalone deletion (review flow, unmount cleanup). The flows that follow up with
  // updateMeeting({ audioDeleted: true }) report the same action there too; the
  // client dedupes the pair per meeting. A call with no audio left reports nothing.
  if (existed) reportAuditEvent('meeting.audio_delete', meetingId);
}
