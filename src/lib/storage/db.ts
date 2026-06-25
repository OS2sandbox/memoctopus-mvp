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

let dbPromise: ReturnType<typeof openDB<ReferatDB>> | null = null;
let openName: string | null = null;
let legacyCleaned = false;

function openScopedDB(userId: string) {
  const name = `referat-db-u-${userId}`;
  // Reopen if the active user changed (a different user signed in this session) so
  // we never serve one user's data from another's cached connection.
  if (!dbPromise || openName !== name) {
    openName = name;
    dbPromise = openDB<ReferatDB>(name, 1, {
      upgrade(db) {
        db.createObjectStore('meetings', { keyPath: 'id' });
        const transcripts = db.createObjectStore('transcripts', { keyPath: 'id' });
        transcripts.createIndex('by-meeting', 'meetingId');
        const minutes = db.createObjectStore('minutes', { keyPath: 'id' });
        minutes.createIndex('by-meeting', 'meetingId');
        db.createObjectStore('audio', { keyPath: 'meetingId' });
      },
    });
    // One-time: discard the legacy origin-scoped database that leaked across users.
    // Its records can't be attributed to a single user, so they are not migrated.
    if (!legacyCleaned) {
      legacyCleaned = true;
      void deleteDB('referat-db').catch(() => {});
    }
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
