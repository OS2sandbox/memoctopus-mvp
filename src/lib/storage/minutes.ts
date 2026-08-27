import { getDB, StoredMinutes, StoredMinutesVersion } from './db';
import type { MinutesContent } from '@/types';

function newId(): string {
  return crypto.randomUUID();
}

const MAX_VERSIONS = 50;

// A stored row as it may exist on disk, including rows written before stable
// version labels / an explicit active version existed (label + updatedAt absent).
interface LegacyVersion {
  id: string;
  content: MinutesContent;
  createdAt: string;
  label?: number;
  updatedAt?: string;
  baseline?: MinutesContent;
}
interface LegacyMinutes {
  id: string;
  meetingId: string;
  templateId: string | null;
  content: MinutesContent;
  version: number;
  createdAt: string;
  activeVersionId?: string | null;
  versions: LegacyVersion[];
}

// Bring a stored row up to the current versioned shape. Rows written before stable
// version labels existed kept a single live `content`, a monotonic `version`
// counter, and an unlabelled `versions[]` (newest first, excluding the live one).
// We rebuild that into a list where every version — including the live one — has a
// stable label and the active version is tracked explicitly.
function ensureVersioned(row: LegacyMinutes): StoredMinutes {
  const hasLabels =
    !!row.activeVersionId &&
    row.versions.length > 0 &&
    row.versions.every((v) => v.label != null && v.updatedAt != null);

  // Already in the labelled shape — only `baseline` might be missing (rows written
  // before baselines existed). Backfill baseline = content WITHOUT touching labels,
  // order, or the active version (a full rebuild here would re-label and corrupt them).
  if (hasLabels) {
    if (row.versions.every((v) => v.baseline != null)) return row as StoredMinutes;
    return {
      ...row,
      versions: row.versions.map((v) => ({ ...v, baseline: v.baseline ?? v.content })),
    } as StoredMinutes;
  }

  const now = row.createdAt ?? new Date().toISOString();
  // Legacy `versions` are archived snapshots (newest first), oldest = label 1.
  // A migrated version's baseline is its content (treat what's stored as committed).
  const archived = [...row.versions].reverse().map((v, i): StoredMinutesVersion => ({
    id: v.id,
    label: i + 1,
    content: v.content,
    baseline: v.baseline ?? v.content,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt ?? v.createdAt,
  }));
  // The live content becomes the newest, active version.
  const active: StoredMinutesVersion = {
    id: newId(),
    label: archived.length + 1,
    content: row.content,
    baseline: row.content,
    createdAt: now,
    updatedAt: now,
  };
  const versions = [...archived, active];
  return {
    id: row.id,
    meetingId: row.meetingId,
    templateId: row.templateId,
    content: active.content,
    version: active.label,
    createdAt: row.createdAt ?? now,
    activeVersionId: active.id,
    versions,
  };
}

// Sync the top-level mirror (`content`, `version`) to whichever version is active.
function withActiveMirror(row: StoredMinutes): StoredMinutes {
  const active = row.versions.find((v) => v.id === row.activeVersionId) ?? row.versions[row.versions.length - 1];
  return {
    ...row,
    activeVersionId: active?.id ?? null,
    content: active?.content ?? row.content,
    version: active?.label ?? row.version,
  };
}

async function readRow(meetingId: string): Promise<StoredMinutes | null> {
  const db = await getDB();
  const existing = (await db.getAllFromIndex('minutes', 'by-meeting', meetingId))[0] as
    | LegacyMinutes
    | undefined;
  return existing ? ensureVersioned(existing) : null;
}

export async function getMinutes(meetingId: string): Promise<StoredMinutes | null> {
  return readRow(meetingId);
}

// Persist the current referat content in place. This is the autosave path: it
// OVERWRITES the active version's content and never changes labels, order, or the
// active selection, so editing — including editing an older version — keeps that
// version's number. New versions are only created via snapshotMinutes ("Gem
// version"). On first save it creates version 1 as the active version.
export async function saveMinutes(
  meetingId: string,
  content: MinutesContent,
  templateId?: string | null,
): Promise<StoredMinutes> {
  const db = await getDB();
  const existing = await readRow(meetingId);
  const now = new Date().toISOString();

  if (!existing) {
    const v: StoredMinutesVersion = { id: newId(), label: 1, content, baseline: content, createdAt: now, updatedAt: now };
    const minutes: StoredMinutes = {
      id: newId(),
      meetingId,
      templateId: templateId ?? null,
      content,
      version: 1,
      createdAt: now,
      activeVersionId: v.id,
      versions: [v],
    };
    await db.put('minutes', minutes);
    return minutes;
  }

  const versions = existing.versions.map((v) =>
    v.id === existing.activeVersionId ? { ...v, content, updatedAt: now } : v,
  );
  const minutes = withActiveMirror({
    ...existing,
    templateId: templateId !== undefined ? templateId : existing.templateId,
    versions,
  });
  await db.put('minutes', minutes);
  return minutes;
}

// Promote the current working `content` into a brand-new version ("Gem version").
// The new version is a committed checkpoint (content === baseline), gets the next
// free label, and becomes active. The previously-active version is REVERTED to its
// own baseline — the edits the user made belong to the new version, so the original
// goes back to its pre-edit checkpoint, giving clean, distinct versions. No-op when
// there's no row yet. Caps history at MAX_VERSIONS, dropping the lowest labels
// without renumbering survivors.
export async function snapshotMinutes(
  meetingId: string,
  content: MinutesContent,
): Promise<StoredMinutes | null> {
  const db = await getDB();
  const existing = await readRow(meetingId);
  if (!existing) return null;

  const now = new Date().toISOString();
  // Revert the active version to its committed baseline (drop the working edits —
  // they're being captured in the new version below).
  const reverted = existing.versions.map((v) =>
    v.id === existing.activeVersionId ? { ...v, content: v.baseline, updatedAt: now } : v,
  );
  const nextLabel = reverted.reduce((m, v) => Math.max(m, v.label), 0) + 1;
  const snapshot: StoredMinutesVersion = {
    id: newId(),
    label: nextLabel,
    content,
    baseline: content,
    createdAt: now,
    updatedAt: now,
  };

  let versions = [...reverted, snapshot];
  if (versions.length > MAX_VERSIONS) {
    // Keep the highest labels (the active snapshot is always among them).
    versions = [...versions].sort((a, b) => a.label - b.label).slice(versions.length - MAX_VERSIONS);
  }

  const minutes = withActiveMirror({ ...existing, activeVersionId: snapshot.id, versions });
  await db.put('minutes', minutes);
  return minutes;
}

// Save a freshly generated referat as its own version. The first generation
// creates version 1; regenerating (e.g. going back to Gennemgang and generating
// again) APPENDS a new version and makes it active, leaving the prior versions
// (and the user's edits to them) intact — it does not overwrite version 1.
export async function appendMinutesVersion(
  meetingId: string,
  content: MinutesContent,
  templateId?: string | null,
): Promise<StoredMinutes> {
  const db = await getDB();
  const existing = await readRow(meetingId);
  const now = new Date().toISOString();

  if (!existing) {
    const v: StoredMinutesVersion = { id: newId(), label: 1, content, baseline: content, createdAt: now, updatedAt: now };
    const minutes: StoredMinutes = {
      id: newId(),
      meetingId,
      templateId: templateId ?? null,
      content,
      version: 1,
      createdAt: now,
      activeVersionId: v.id,
      versions: [v],
    };
    await db.put('minutes', minutes);
    return minutes;
  }

  const nextLabel = existing.versions.reduce((m, v) => Math.max(m, v.label), 0) + 1;
  const fresh: StoredMinutesVersion = { id: newId(), label: nextLabel, content, baseline: content, createdAt: now, updatedAt: now };
  let versions = [...existing.versions, fresh];
  if (versions.length > MAX_VERSIONS) {
    versions = [...versions].sort((a, b) => a.label - b.label).slice(versions.length - MAX_VERSIONS);
  }
  const minutes = withActiveMirror({
    ...existing,
    templateId: templateId !== undefined ? templateId : existing.templateId,
    activeVersionId: fresh.id,
    versions,
  });
  await db.put('minutes', minutes);
  return minutes;
}

// Switch which version is being edited. The active version's content is mirrored
// to the top level so the editor and consumers load it. Returns the row unchanged
// when the id doesn't resolve.
export async function setActiveMinutesVersion(
  meetingId: string,
  versionId: string,
): Promise<StoredMinutes | null> {
  const db = await getDB();
  const existing = await readRow(meetingId);
  if (!existing) return null;
  if (!existing.versions.some((v) => v.id === versionId)) return existing;

  const minutes = withActiveMirror({ ...existing, activeVersionId: versionId });
  await db.put('minutes', minutes);
  return minutes;
}
