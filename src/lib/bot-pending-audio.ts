import fs from 'fs/promises';
import path from 'path';
import type { TranscriptSegment } from '@/types';
import { safeLogError } from '@/lib/audit/safe-log';
import { recordServerEvent, recordEvent, UUID_RE } from '@/lib/audit/record';
import type { HeaderSource } from '@/lib/audit/request-context';

// Transient server-side hand-off for Teams-bot recordings.
//
// The bot records server-side and POSTs the finished audio to /api/bot/audio-upload.
// Meetings live in the user's browser IndexedDB, so the server cannot persist the
// transcript itself — instead it stashes the audio here briefly, keyed by meetingId,
// until the user's browser polls /api/bot/audio/[meetingId] and pulls it down into
// IndexedDB (where the normal client-side transcription pipeline takes over).
//
// Files are deleted as soon as the client downloads them; a TTL sweep drops anything
// the client never collected (e.g. the tab was closed). Both deletions of the AUDIO
// are recorded as bot.audio_delete (source 'system', trigger handoff | ttl). The sweep
// is opportunistic: it runs when the next recording is stored, not on a timer.

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

function ownerPath(meetingId: string): string {
  return path.join(rootDir(), `${meetingId}.owner.json`);
}

// Ownership binding for a bot recording. Meetings live in the client's IndexedDB
// (no server meetings table), so the only server-side record of WHO owns a meetingId
// is written here at session-create time. Every client-facing bot route checks it so
// one authenticated user can't pull down (or control) another user's recording by
// supplying their meetingId. Without this the stash is keyed by meetingId alone.
export async function setBotMeetingOwner(meetingId: string, userId: string): Promise<void> {
  assertSafeId(meetingId);
  await fs.mkdir(rootDir(), { recursive: true });
  await fs.writeFile(ownerPath(meetingId), JSON.stringify({ userId, createdAt: Date.now() }));
}

export async function getBotMeetingOwner(meetingId: string): Promise<string | null> {
  assertSafeId(meetingId);
  try {
    const { userId } = JSON.parse(await fs.readFile(ownerPath(meetingId), 'utf8')) as { userId: string };
    return userId ?? null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      safeLogError('bot-pending-audio readOwner failed', err);
    }
    return null;
  }
}

// True only when meetingId is owned by exactly this user. Missing owner → false
// (deny by default), so an unbound or expired meetingId is never readable.
export async function assertBotMeetingOwner(meetingId: string, userId: string): Promise<boolean> {
  return (await getBotMeetingOwner(meetingId)) === userId;
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
    const handled = new Set<string>();
    await Promise.all(
      entries
        .filter((f) => f.endsWith('.meta.json') || f.endsWith('.transcript.json') || f.endsWith('.owner.json'))
        .map(async (f) => {
          try {
            const meta = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) as { createdAt: number };
            if (now - meta.createdAt > TTL_MS) {
              const id = f.replace(/\.(meta|transcript|owner)\.json$/, '');
              // One id has up to three files: handle it once so the deletion is recorded once.
              if (handled.has(id)) return;
              handled.add(id);
              // Read before the owner file goes: the owner is the person the deletion is on behalf of.
              const owner = await getBotMeetingOwner(id);
              await deletePendingAudio(id, { trigger: 'ttl', actorUserId: owner });
              await deletePendingTranscript(id);
              await fs.unlink(ownerPath(id)).catch(() => {});
            }
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
              safeLogError('bot-pending-audio sweep: skipping malformed/inaccessible entry', err);
            }
          }
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
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      safeLogError('bot-pending-audio readPendingMeta failed', err);
    }
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

export interface PendingAudioDeleteAudit {
  trigger: 'handoff' | 'ttl';
  /** The person the stash belonged to (the collecting user, or the owner for a sweep). */
  actorUserId?: string | null;
  /** The request that caused the deletion, when there is one (a sweep has none). */
  req?: HeaderSource;
}

/**
 * Deletes the stashed recording and its meta. With `audit`, a bot.audio_delete event is
 * recorded (best effort, never throws) but only when an audio FILE was actually removed:
 * a no-recording marker has none. Returns whether one was.
 */
export async function deletePendingAudio(meetingId: string, audit?: PendingAudioDeleteAudit): Promise<boolean> {
  assertSafeId(meetingId);
  const [removed] = await Promise.all([
    fs.unlink(audioPath(meetingId)).then(() => true, () => false),
    fs.unlink(metaPath(meetingId)).catch(() => {}),
  ]);
  if (removed && audit) {
    // The id came from a URL or a file name: it is an entity only when it is a well-formed UUID.
    const event = {
      type: 'bot.audio_delete' as const,
      source: 'system' as const,
      actorUserId: audit.actorUserId ?? null,
      ...(UUID_RE.test(meetingId) ? { entityId: meetingId } : {}),
      details: { trigger: audit.trigger },
    };
    await (audit.req ? recordServerEvent(audit.req, event) : recordEvent(event));
  }
  return removed;
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
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      safeLogError('bot-pending-audio readPendingTranscript failed', err);
    }
    return null;
  }
}

export async function deletePendingTranscript(meetingId: string): Promise<void> {
  assertSafeId(meetingId);
  await fs.unlink(transcriptPath(meetingId)).catch(() => {});
}
