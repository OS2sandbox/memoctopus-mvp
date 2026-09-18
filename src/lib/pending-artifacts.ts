import fs from 'fs/promises';
import path from 'path';
import type { TranscriptSegment } from '@/types';

// Transient server-side hand-off for artifacts produced without a browser present.
//
// The Graph pipeline collects a meeting's recording and transcript from Teams long
// after whoever armed it has closed the tab. Meetings live in the user's browser
// IndexedDB, so the server cannot persist them itself. It stashes them here instead,
// keyed by meetingId, until the browser polls /api/meetings/[id]/pending-audio and
// /pending-transcript and pulls them down into IndexedDB, where the normal
// client-side pipeline takes over.
//
// Files are deleted as soon as the client downloads them; a TTL sweep drops anything
// the client never collected (e.g. the tab was closed).

const TTL_MS = 60 * 60 * 1000; // 1 hour

function rootDir(): string {
  const base = process.env.AUDIO_STORAGE_PATH ?? path.join(process.cwd(), 'audio-storage');
  return path.join(base, 'pending-artifacts');
}

function assertSafeId(meetingId: string): void {
  if (!/^[\w-]+$/.test(meetingId)) {
    throw new Error(`Invalid meetingId: ${meetingId}`);
  }
}

function metaPath(meetingId: string): string {
  return path.join(rootDir(), `${meetingId}.meta.json`);
}

function transcriptPath(meetingId: string): string {
  return path.join(rootDir(), `${meetingId}.transcript.json`);
}

function ownerPath(meetingId: string): string {
  return path.join(rootDir(), `${meetingId}.owner.json`);
}

// Ownership binding for a bot recording. Meetings live in the client's IndexedDB
// (no server meetings table), so the only server-side record of WHO owns a meetingId
// is written here at session-create time. Every client-facing bot route checks it so
// one authenticated user can't pull down (or control) another user's recording by
// supplying their meetingId. Without this the stash is keyed by meetingId alone.
export async function setMeetingOwner(meetingId: string, userId: string): Promise<void> {
  assertSafeId(meetingId);
  await fs.mkdir(rootDir(), { recursive: true });
  await fs.writeFile(ownerPath(meetingId), JSON.stringify({ userId, createdAt: Date.now() }));
}

export async function getMeetingOwner(meetingId: string): Promise<string | null> {
  assertSafeId(meetingId);
  try {
    const { userId } = JSON.parse(await fs.readFile(ownerPath(meetingId), 'utf8')) as { userId: string };
    return userId ?? null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[pending-artifacts] readOwner failed for', meetingId, err);
    }
    return null;
  }
}

// True only when meetingId is owned by exactly this user. Missing owner → false
// (deny by default), so an unbound or expired meetingId is never readable.
export async function assertMeetingOwner(meetingId: string, userId: string): Promise<boolean> {
  return (await getMeetingOwner(meetingId)) === userId;
}

export interface PendingMeta {
  participants: string[];
  durationSeconds: number | null;
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
/**
 * Drop anything the client never collected. `exceptId` is the meeting currently
 * being written, and excluding it is load-bearing rather than an optimisation:
 * the owner file is written once at the start of a run, while the download,
 * transcode and ASR that follow can outlast the TTL on a long meeting. Sweeping
 * blind would then delete the owner file of the very run in progress, and since
 * the hand-off routes deny by default without one, a successful transcription
 * would become uncollectable and the meeting would never finish.
 */
async function sweep(exceptId?: string): Promise<void> {
  try {
    const dir = rootDir();
    const entries = await fs.readdir(dir);
    const now = Date.now();
    await Promise.all(
      entries
        .filter((f) => f.endsWith('.meta.json') || f.endsWith('.transcript.json') || f.endsWith('.owner.json'))
        .filter((f) => f.replace(/\.(meta|transcript|owner)\.json$/, '') !== exceptId)
        .map(async (f) => {
          try {
            const meta = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) as { createdAt: number };
            if (now - meta.createdAt > TTL_MS) {
              const id = f.replace(/\.(meta|transcript|owner)\.json$/, '');
              await deletePendingMeta(id);
              await deletePendingTranscript(id);
              await fs.unlink(ownerPath(id)).catch(() => {});
            }
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
              console.error('[pending-artifacts] sweep: skipping malformed/inaccessible entry', f, err);
            }
          }
        }),
    );
  } catch { /* dir may not exist yet */ }
}


// Records that the run finished with no usable recording: either the meeting was
// transcript-only, or Teams produced no recording at all. The client polls and
// gets `{ status: 'no-recording' }`.
//
// `meta` still matters when there is no audio: Teams' transcript names every
// speaker, and those names are what pre-fills the participant list in
// Gennemgang. Dropping them here would narrow that to the recording modes.
export async function markNoRecording(
  meetingId: string,
  meta: Partial<Pick<PendingMeta, 'participants' | 'durationSeconds'>> = {},
): Promise<void> {
  assertSafeId(meetingId);
  await fs.mkdir(rootDir(), { recursive: true });
  const full: PendingMeta = {
    participants: meta.participants ?? [],
    durationSeconds: meta.durationSeconds ?? null,
    createdAt: Date.now(),
  };
  await fs.writeFile(metaPath(meetingId), JSON.stringify(full));
}

export async function readPendingMeta(meetingId: string): Promise<PendingMeta | null> {
  assertSafeId(meetingId);
  try {
    return JSON.parse(await fs.readFile(metaPath(meetingId), 'utf8')) as PendingMeta;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[pending-artifacts] readPendingMeta failed for', meetingId, err);
    }
    return null;
  }
}


export async function deletePendingMeta(meetingId: string): Promise<void> {
  assertSafeId(meetingId);
  await fs.unlink(metaPath(meetingId)).catch(() => {});
}

export async function storePendingTranscript(
  meetingId: string,
  transcript: Omit<PendingTranscript, 'createdAt'>,
): Promise<void> {
  assertSafeId(meetingId);
  await fs.mkdir(rootDir(), { recursive: true });
  // The TTL sweep hangs off this write because every run reaches it, including a
  // run that ends in `failed`. It used to hang off storePendingAudio, which no
  // run calls any more — and which the bot's failed runs never called either,
  // which is why production's volume still holds meta files from July.
  await sweep(meetingId);
  const full: PendingTranscript = { ...transcript, createdAt: Date.now() };
  await fs.writeFile(transcriptPath(meetingId), JSON.stringify(full));
}

export async function readPendingTranscript(meetingId: string): Promise<PendingTranscript | null> {
  assertSafeId(meetingId);
  try {
    return JSON.parse(await fs.readFile(transcriptPath(meetingId), 'utf8')) as PendingTranscript;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[pending-artifacts] readPendingTranscript failed for', meetingId, err);
    }
    return null;
  }
}

export async function deletePendingTranscript(meetingId: string): Promise<void> {
  assertSafeId(meetingId);
  await fs.unlink(transcriptPath(meetingId)).catch(() => {});
}
