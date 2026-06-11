import { openDB, DBSchema } from 'idb';
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
}

export interface StoredMinutes {
  id: string;
  meetingId: string;
  templateId: string | null;
  content: MinutesContent;
  version: number;
  createdAt: string;
  versions: { id: string; content: MinutesContent; createdAt: string }[];
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

export function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<ReferatDB>('referat-db', 1, {
      upgrade(db) {
        db.createObjectStore('meetings', { keyPath: 'id' });
        const transcripts = db.createObjectStore('transcripts', { keyPath: 'id' });
        transcripts.createIndex('by-meeting', 'meetingId');
        const minutes = db.createObjectStore('minutes', { keyPath: 'id' });
        minutes.createIndex('by-meeting', 'meetingId');
        db.createObjectStore('audio', { keyPath: 'meetingId' });
      },
    });
  }
  return dbPromise;
}
