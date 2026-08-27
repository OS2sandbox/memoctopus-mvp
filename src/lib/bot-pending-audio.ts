import fs from 'fs/promises';
import path from 'path';
import type { TranscriptSegment } from '@/types';

// Transient server-side hand-off for Teams-bot recordings.
//
// The bot records server-side and POSTs the finished audio to /api/bot/audio-upload.
// Meetings live in the user's browser IndexedDB, so the server cannot persist the
// transcript itself — instead it stashes the audio here briefly, keyed by meetingId,
// until the user's browser polls /api/bot/audio/[meetingId] and pulls it down into
// IndexedDB (where the normal client-side transcription pipeline takes over).
//
// Files are deleted as soon as the client downloads them; a TTL sweep drops anything
// the client never collected (e.g. the tab was closed).

const TTL_MS = 60 * 60 * 1000; // 1 hour

function rootDir(): string {
  const base = process.env.AUDIO_STORAGE_PATH ?? path.join(process.cwd(), 'audio-storage');
  return path.join(base, 'bot-pending');
}

function assertSafeId(meetingId: string): void {
  if (!/^[\w-]+$/.test(meetingId)) {
    throw new Error(`Invalid meetingId: ${meetingId}`);
  }
}

function audioPath(meetingId: string): string {
  return path.join(rootDir(), `${meetingId}.audio`);
}

function metaPath(meetingId: string): string {
  return path.join(rootDir(), `${meetingId}.meta.json`);
}

function transcriptPath(meetingId: string): string {
  return path.join(rootDir(), `${meetingId}.transcript.json`);
}

export interface PendingMeta {
  mimeType: string;
  participants: string[];
  durationSeconds: number | null;
  hasRecording: boolean;
  createdAt: number;
}

// Server-side transcription result for a bot recording. Written as 'processing'
// the moment the audio lands (so the client knows work is underway), then
// overwritten with 'ready' + segments or 'failed'. Like the audio stash, this is
// transient: the client pulls it into IndexedDB and it is deleted.
export interface PendingTranscript {
  status: 'processing' | 'ready' | 'failed';
  segments?: TranscriptSegment[];
  /** Whether speaker turns were merged in (false → client may diarize itself). */
  diarized?: boolean;
  createdAt: number;
}

// Best-effort cleanup of entries older than the TTL.
async function sweep(): Promise<void> {
  try {
    const dir = rootDir();
    const entries = await fs.readdir(dir);
    const now = Date.now();
    await Promise.all(
      entries
        .filter((f) => f.endsWith('.meta.json') || f.endsWith('.transcript.json'))
        .map(async (f) => {
          try {
            const meta = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) as { createdAt: number };
            if (now - meta.createdAt > TTL_MS) {
              const id = f.replace(/\.(meta|transcript)\.json$/, '');
              await deletePendingAudio(id);
              await deletePendingTranscript(id);
            }
          } catch { /* ignore malformed/raced entries */ }
        }),
    );
  } catch { /* dir may not exist yet */ }
}

export async function storePendingAudio(
  meetingId: string,
  buffer: Buffer,
  meta: Omit<PendingMeta, 'createdAt'>,
): Promise<void> {
  assertSafeId(meetingId);
  await fs.mkdir(rootDir(), { recursive: true });
  await sweep();
  const full: PendingMeta = { ...meta, createdAt: Date.now() };
  await fs.writeFile(audioPath(meetingId), buffer);
  await fs.writeFile(metaPath(meetingId), JSON.stringify(full));
}

// Records that the bot finished with no usable recording (e.g. never admitted,
// or the user aborted). The client polls and shows a cancelled state.
export async function markNoRecording(meetingId: string): Promise<void> {
  assertSafeId(meetingId);
  await fs.mkdir(rootDir(), { recursive: true });
  const meta: PendingMeta = {
    mimeType: '',
    participants: [],
    durationSeconds: null,
    hasRecording: false,
    createdAt: Date.now(),
  };
  await fs.writeFile(metaPath(meetingId), JSON.stringify(meta));
}

export async function readPendingMeta(meetingId: string): Promise<PendingMeta | null> {
  assertSafeId(meetingId);
  try {
    return JSON.parse(await fs.readFile(metaPath(meetingId), 'utf8')) as PendingMeta;
  } catch {
    return null;
  }
}

export async function readPendingAudio(meetingId: string): Promise<Buffer | null> {
  assertSafeId(meetingId);
  try {
    return await fs.readFile(audioPath(meetingId));
  } catch {
    return null;
  }
}

export async function deletePendingAudio(meetingId: string): Promise<void> {
  assertSafeId(meetingId);
  await Promise.all([
    fs.unlink(audioPath(meetingId)).catch(() => {}),
    fs.unlink(metaPath(meetingId)).catch(() => {}),
  ]);
}

export async function storePendingTranscript(
  meetingId: string,
  transcript: Omit<PendingTranscript, 'createdAt'>,
): Promise<void> {
  assertSafeId(meetingId);
  await fs.mkdir(rootDir(), { recursive: true });
  const full: PendingTranscript = { ...transcript, createdAt: Date.now() };
  await fs.writeFile(transcriptPath(meetingId), JSON.stringify(full));
}

export async function readPendingTranscript(meetingId: string): Promise<PendingTranscript | null> {
  assertSafeId(meetingId);
  try {
    return JSON.parse(await fs.readFile(transcriptPath(meetingId), 'utf8')) as PendingTranscript;
  } catch {
    return null;
  }
}

export async function deletePendingTranscript(meetingId: string): Promise<void> {
  assertSafeId(meetingId);
  await fs.unlink(transcriptPath(meetingId)).catch(() => {});
}
