import { openDB, deleteDB, DBSchema } from 'idb';
import { getStorageUserId, waitForStorageUserId } from './scope';
import type { TranscriptSegment, PiiReplacement, MinutesContent, MeetingStatus } from '@/types';
import type { TranscriptChapter } from '@/lib/ai/chapters';

export interface StoredMeeting {
  id: string;
  title: string;
  participants: string[];
  status: MeetingStatus;
  source: 'local' | 'teams';
  meetingUrl: string | null;
  createdAt: string;
  // When the audio was actually recorded — the file's own date for uploads, or
  // the recording start for live/Teams meetings. Used for the "Dato" referat tag.
  // Optional for back-compat with meetings created before this field existed.
  recordedAt?: string | null;
  updatedAt: string;
  audioDurationSeconds: number | null;
  audioSizeBytes: number;
  audioDeleted: boolean;
  // Active Teams bot-service session id (null when not a bot meeting / not joined).
  botSession?: string | null;
}

export interface StoredTranscript {
  id: string;
  meetingId: string;
  rawText: string;
  segments: TranscriptSegment[];
  chapters: TranscriptChapter[];
  piiReplacements: PiiReplacement[];
  piiRemovedAt: string | null;
  // Speaker-diarization lifecycle. 'pending' means the transcript was saved with
  // default ('Taler 1') labels and an acoustic diarization pass is still running —
  // the review UI shows an uncertainty state instead of confident labels until it
  // resolves to 'done'. 'failed' means the diarization service couldn't be reached
  // (or errored), so labels stay default and the review UI tells the user automatic
  // speaker recognition is unavailable. Absent (legacy transcripts, or paths that
  // arrive already diarized) is treated as 'done'.
  diarizationStatus?: 'pending' | 'done' | 'failed';
}

// A single referat version with a stable, human-facing number (`label`). Labels
// never change once assigned: editing a version updates its content in place but
// keeps its label and position, so "Version 1" stays "Version 1" even after it's
// edited later than "Version 3".
export interface StoredMinutesVersion {
  id: string;
  label: number;
  // The live/working content (autosaved edits while this version is active).
  content: MinutesContent;
  // The committed checkpoint this version reverts to when "Gem version" promotes
  // the working edits into a new version. Equals `content` for an untouched version.
  baseline: MinutesContent;
  createdAt: string;
  updatedAt: string;
}

export interface StoredMinutes {
  id: string;
  meetingId: string;
  templateId: string | null;
  // Mirror of the active version's content + label, kept in sync so consumers that
  // only read the "current" referat (export, meeting page) don't need version logic.
  content: MinutesContent;
  version: number;
  createdAt: string;
  // The version currently being edited; autosaves write to it in place.
  activeVersionId: string | null;
  versions: StoredMinutesVersion[];
}

export interface StoredAudio {
  meetingId: string;
  blob: Blob;
  mimeType: string;
}

interface ReferatDB extends DBSchema {
  meetings: { key: string; value: StoredMeeting };
  transcripts: {
    key: string;
    value: StoredTranscript;
    indexes: { 'by-meeting': string };
  };
  minutes: {
    key: string;
    value: StoredMinutes;
    indexes: { 'by-meeting': string };
  };
  audio: { key: string; value: StoredAudio };
}

const LEGACY_DB_NAME = 'referat-db';

// The stores to carry over, with the property each record is keyed by (`audio` is
// keyed by meetingId, the rest by id).
const LEGACY_STORES = [
  { name: 'meetings', key: 'id' },
  { name: 'transcripts', key: 'id' },
  { name: 'minutes', key: 'id' },
  { name: 'audio', key: 'meetingId' },
] as const;

// A structural view of an idb database, so the adoption pass can iterate stores by
// name without fighting idb's per-store generics.
interface AnyDB {
  objectStoreNames: { contains(name: string): boolean };
  getAll(store: string): Promise<unknown[]>;
  get(store: string, key: string): Promise<unknown>;
  put(store: string, value: unknown): Promise<unknown>;
  close(): void;
}

let dbPromise: ReturnType<typeof openDB<ReferatDB>> | null = null;
let openName: string | null = null;
let legacyAdoption: Promise<void> | null = null;

// Whether the legacy origin-scoped database still exists. `indexedDB.databases()`
// is missing on some browsers (older Firefox/Safari); when we can't tell we answer
// optimistically and let adoptLegacyDatabase() open it — an empty database created
// that way owns no stores, copies nothing, and is deleted again.
async function legacyDatabaseExists(): Promise<boolean> {
  const idb = typeof indexedDB !== 'undefined' ? indexedDB : undefined;
  if (idb && typeof idb.databases === 'function') {
    try {
      return (await idb.databases()).some((d) => d.name === LEGACY_DB_NAME);
    } catch {
      // Reporting is best-effort; fall through to the optimistic answer.
    }
  }
  return true;
}

// Move records from the pre-scoping database into this user's own database, then
// drop the old one. Deployments here are single-user-per-device, so the first user
// to sign in after the upgrade is treated as the owner of what was already stored —
// without this their existing meetings would become unreachable, and IndexedDB is
// the only place they live (there is no server-side copy).
//
// Existing records are never overwritten, and the legacy database is kept if any
// part of the copy fails so a later attempt can retry rather than lose data.
async function adoptLegacyDatabase(scoped: unknown): Promise<void> {
  if (!(await legacyDatabaseExists())) return;

  let legacy: AnyDB;
  try {
    legacy = (await openDB<ReferatDB>(LEGACY_DB_NAME, 1)) as unknown as AnyDB;
  } catch {
    return;
  }

  const target = scoped as AnyDB;
  try {
    let copied = 0;
    for (const { name, key } of LEGACY_STORES) {
      if (!legacy.objectStoreNames?.contains(name)) continue;
      for (const record of await legacy.getAll(name)) {
        const id = (record as Record<string, unknown>)[key];
        if (typeof id !== 'string') continue;
        // Never clobber something already in this user's database.
        if ((await target.get(name, id)) === undefined) {
          await target.put(name, record);
          copied++;
        }
      }
    }
    if (copied > 0) console.info(`[storage] adopted ${copied} record(s) from ${LEGACY_DB_NAME}`);
  } catch (err) {
    console.error('[storage] legacy adoption failed; keeping the old database:', err);
    legacy.close();
    return;
  }

  legacy.close();
  await deleteDB(LEGACY_DB_NAME).catch(() => {});
}

function openScopedDB(userId: string) {
  const name = `referat-db-u-${userId}`;
  // Reopen if the active user changed (a different user signed in this session) so
  // we never serve one user's data from another's cached connection.
  if (!dbPromise || openName !== name) {
    openName = name;
    const opening = openDB<ReferatDB>(name, 1, {
      upgrade(db) {
        db.createObjectStore('meetings', { keyPath: 'id' });
        const transcripts = db.createObjectStore('transcripts', { keyPath: 'id' });
        transcripts.createIndex('by-meeting', 'meetingId');
        const minutes = db.createObjectStore('minutes', { keyPath: 'id' });
        minutes.createIndex('by-meeting', 'meetingId');
        db.createObjectStore('audio', { keyPath: 'meetingId' });
      },
    });
    // Callers await adoption, so the archive never renders empty and then fills in.
    // Runs at most once per page load; after it succeeds the legacy database is gone.
    dbPromise = opening.then(async (db) => {
      legacyAdoption ??= adoptLegacyDatabase(db);
      await legacyAdoption;
      return db;
    });
  }
  return dbPromise;
}

// Returns the IndexedDB connection for the ACTIVE user. The database is namespaced
// by user id (see ./scope) so users sharing a browser never see each other's data.
// If the scope isn't set yet (a storage call raced ahead of <StorageScope> on first
// mount), it waits for it rather than opening an unscoped database.
export function getDB() {
  const userId = getStorageUserId();
  if (userId) return openScopedDB(userId);
  return waitForStorageUserId().then(openScopedDB);
}
