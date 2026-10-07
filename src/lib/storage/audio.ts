import { getDB, StoredAudio } from './db';
import { reportAuditEvent } from '@/lib/audit/client';
import type { DeleteTrigger } from '@/lib/audit/events/meeting';

export async function saveAudio(meetingId: string, blob: Blob, mimeType: string): Promise<void> {
  const db = await getDB();
  await db.put('audio', { meetingId, blob, mimeType });
}

export async function getAudio(meetingId: string): Promise<StoredAudio | null> {
  const db = await getDB();
  return (await db.get('audio', meetingId)) ?? null;
}

export async function deleteAudio(
  meetingId: string,
  // Why it was deleted, for the audit log: the person asked (default) or the app did it on its own.
  opts: { trigger?: DeleteTrigger } = {},
): Promise<void> {
  const db = await getDB();
  // ONE readwrite transaction with both requests issued back to back: this runs from
  // the tab-close purge (pagehide), where a page that is frozen after the first await
  // would never get to a second step. The delete is queued before anything is awaited.
  const tx = db.transaction('audio', 'readwrite');
  const keyRequest = tx.store.getKey(meetingId);
  void tx.store.delete(meetingId);
  const existed = (await keyRequest) !== undefined;
  await tx.done;
  // Standalone deletion (review flow, unmount cleanup). The flows that follow up with
  // updateMeeting({ audioDeleted: true }) report the same action there too; the
  // client dedupes the pair per meeting. A call with no audio left reports nothing.
  if (existed) reportAuditEvent('meeting.audio_delete', meetingId, { trigger: opts.trigger ?? 'user' });
}
