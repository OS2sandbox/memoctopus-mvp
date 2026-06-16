import { getDB, StoredMinutes } from './db';
import type { MinutesContent } from '@/types';

function newId(): string {
  return crypto.randomUUID();
}

const MAX_VERSION_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_VERSIONS = 50;

export async function getMinutes(meetingId: string): Promise<StoredMinutes | null> {
  const db = await getDB();
  const results = await db.getAllFromIndex('minutes', 'by-meeting', meetingId);
  return results[0] ?? null;
}

// Persist the current referat content in place. This is the autosave path: it
// OVERWRITES the live content and never touches the version history, so editing
// no longer spawns a new version on every keystroke. Historical versions are
// only created explicitly via snapshotMinutes (when leaving the editor or via
// the "Gem version" button). On first save it creates version 1.
export async function saveMinutes(
  meetingId: string,
  content: MinutesContent,
  templateId?: string | null,
): Promise<StoredMinutes> {
  const db = await getDB();
  const existing = (await db.getAllFromIndex('minutes', 'by-meeting', meetingId))[0];
  const now = new Date().toISOString();

  const minutes: StoredMinutes = {
    id: existing?.id ?? newId(),
    meetingId,
    templateId: templateId !== undefined ? templateId : (existing?.templateId ?? null),
    content,
    version: existing?.version ?? 1,
    createdAt: existing?.createdAt ?? now,
    versions: existing?.versions ?? [],
  };
  await db.put('minutes', minutes);
  return minutes;
}

// Capture a point-in-time version. Archives `baselineContent` (the document as it
// stood at the start of the editing session / last checkpoint) into the version
// history and bumps the version number, while leaving the current live content
// untouched — so the current document is always the newest version and the
// history holds the prior checkpoints. No-op when there is no minutes row yet, or
// when the baseline is identical to the most recent archived version (nothing new
// to checkpoint). Old versions past the 7-day window are pruned.
export async function snapshotMinutes(
  meetingId: string,
  baselineContent: MinutesContent,
): Promise<StoredMinutes | null> {
  const db = await getDB();
  const existing = (await db.getAllFromIndex('minutes', 'by-meeting', meetingId))[0];
  if (!existing) return null;

  const latest = existing.versions[0];
  if (latest && latest.content.body === baselineContent.body) return existing;

  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - MAX_VERSION_AGE_MS).toISOString();
  const archived = { id: newId(), content: baselineContent, createdAt: now };
  const versions = [archived, ...existing.versions]
    .filter((v) => v.createdAt > cutoff)
    .slice(0, MAX_VERSIONS);

  const minutes: StoredMinutes = {
    ...existing,
    version: existing.version + 1,
    versions,
  };
  await db.put('minutes', minutes);
  return minutes;
}
