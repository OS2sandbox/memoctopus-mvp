import { getDB, StoredAudio } from './db';
import { reportAuditEvent } from '@/lib/audit/client';
import { withRetractableReport } from '@/lib/audit/retractable-report';
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
  const trigger = opts.trigger ?? 'user';
  // An automatic delete (the app, not the person) is reported FIRST, before anything is awaited,
  // because it often runs from the tab-close purge (pagehide), where a page that is frozen after
  // the first await would never report it. Existence is not known yet, so the event is retracted
  // if there was no audio or the delete failed (see withRetractableReport).
  await withRetractableReport(
    trigger !== 'user',
    () => reportAuditEvent('meeting.audio_delete', meetingId, { trigger }),
    async (retractIfMissing) => {
      const db = await getDB();
      // ONE readwrite transaction with both requests issued back to back: the delete is queued
      // before anything else is awaited.
      const tx = db.transaction('audio', 'readwrite');
      const keyRequest = tx.store.getKey(meetingId);
      void tx.store.delete(meetingId);
      const existed = (await keyRequest) !== undefined;
      if (!existed) retractIfMissing();
      await tx.done;
      // Standalone deletion (review flow, unmount cleanup). The flows that follow up with
      // updateMeeting({ audioDeleted: true }) report the same action there too; the
      // client dedupes the pair per meeting. A call with no audio left reports nothing.
      return existed;
    },
  );
}
