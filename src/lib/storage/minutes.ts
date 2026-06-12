import { getDB, StoredMinutes } from './db';
import type { MinutesContent } from '@/types';

function newId(): string {
  return crypto.randomUUID();
}

const MAX_VERSION_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export async function getMinutes(meetingId: string): Promise<StoredMinutes | null> {
  const db = await getDB();
  const results = await db.getAllFromIndex('minutes', 'by-meeting', meetingId);
  return results[0] ?? null;
}

export async function saveMinutes(
  meetingId: string,
  content: MinutesContent,
  templateId?: string | null,
): Promise<StoredMinutes> {
  const db = await getDB();
  const existing = (await db.getAllFromIndex('minutes', 'by-meeting', meetingId))[0];
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - MAX_VERSION_AGE_MS).toISOString();

  let versions: StoredMinutes['versions'] = [];
  if (existing) {
    const archived = {
      id: newId(),
      content: existing.content,
      createdAt: now,
    };
    versions = [archived, ...existing.versions].filter((v) => v.createdAt > cutoff);
  }

  const minutes: StoredMinutes = {
    id: existing?.id ?? newId(),
    meetingId,
    templateId: templateId !== undefined ? templateId : (existing?.templateId ?? null),
    content,
    version: (existing?.version ?? 0) + 1,
    createdAt: existing?.createdAt ?? now,
    versions,
  };
  await db.put('minutes', minutes);
  return minutes;
}
