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
// the client never collected (e.g. the tab was closed). Every deletion of the AUDIO and of
// the stashed TRANSCRIPT is recorded as bot.audio_delete (source 'system', trigger
// handoff | ttl, object audio | transcript). The sweep runs opportunistically when the
// next recording is stored, and on demand from POST /api/internal/bot-audio/sweep (an
// operator cron, see DEPLOY.md), so the TTL is provable even when no recording follows.

const TTL_MS = 60 * 60 * 1000; // 1 hour: audio, meta and transcript
// The owner binding (who may collect or control a meeting) outlives the data: a bot session
// can run for hours, and the binding must exist when its recording lands. It is removed only
// after this long AND once no stash for the meeting is left, never while a session is live.
const OWNER_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

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

interface OwnerRecord {
  userId: string | null;
  createdAt: number | null;
}

// The owner file, read (and parsed) once. Null when missing or unreadable.
async function readOwnerRecord(meetingId: string): Promise<OwnerRecord | null> {
  try {
    const raw = JSON.parse(await fs.readFile(ownerPath(meetingId), 'utf8')) as { userId?: unknown; createdAt?: unknown };
    return {
      userId: typeof raw.userId === 'string' ? raw.userId : null,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : null,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      safeLogError('bot-pending-audio readOwner failed', err);
    }
    return null;
  }
}

export async function getBotMeetingOwner(meetingId: string): Promise<string | null> {
  assertSafeId(meetingId);
  return (await readOwnerRecord(meetingId))?.userId ?? null;
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

export interface SweepResult {
  /** Recordings deleted because nobody collected them within the TTL. */
  audio: number;
  /** Stashed transcripts deleted for the same reason. */
  transcripts: number;
  /** Owner bindings removed (older than 24 h and nothing left for the meeting). */
  owners: number;
}

async function ageOf(file: string): Promise<number | null> {
  try {
    const { createdAt } = JSON.parse(await fs.readFile(file, 'utf8')) as { createdAt?: unknown };
    return typeof createdAt === 'number' ? Date.now() - createdAt : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      safeLogError('bot-pending-audio sweep: skipping malformed/inaccessible entry', err);
    }
    return null;
  }
}

const SWEEP_CONCURRENCY = 8;
/** The sweep that runs when a recording is stored goes at most this often per process (the cron route has no limit). */
const OPPORTUNISTIC_SWEEP_INTERVAL_MS = 60_000;
let lastOpportunisticSweep = 0;

/** Test only. */
export function __resetSweepThrottle(): void {
  lastOpportunisticSweep = 0;
}

/** One meeting's share of the sweep: its expired data, then its owner binding when nothing is left. */
async function sweepOne(id: string, result: SweepResult): Promise<void> {
  try {
    // Read before anything is deleted: the owner is the person the deletions are on behalf of.
    const ownerRecord = await readOwnerRecord(id);
    const owner = ownerRecord?.userId ?? null;
    const [metaAge, transcriptAge] = await Promise.all([ageOf(metaPath(id)), ageOf(transcriptPath(id))]);
    // A no-recording marker has no audio file: it goes too, but there is nothing to log.
    if (metaAge !== null && metaAge > TTL_MS && (await deletePendingAudio(id, { trigger: 'ttl', actorUserId: owner }))) result.audio += 1;
    if (transcriptAge !== null && transcriptAge > TTL_MS) {
      if (await deletePendingTranscript(id, { trigger: 'ttl', actorUserId: owner })) result.transcripts += 1;
    }
    const ownerAge = ownerRecord?.createdAt != null ? Date.now() - ownerRecord.createdAt : null;
    const dataLeft = [metaPath(id), audioPath(id), transcriptPath(id)];
    const stillThere = (await Promise.all(dataLeft.map((p) => fs.stat(p).then(() => true, () => false)))).some(Boolean);
    if (ownerAge !== null && ownerAge > OWNER_TTL_MS && !stillThere) {
      await fs.unlink(ownerPath(id)).catch(() => {});
      result.owners += 1;
    }
  } catch (err) {
    safeLogError('bot-pending-audio sweep: skipping entry', err);
  }
}

/**
 * Best-effort cleanup. Data (audio, meta, transcript) older than the TTL goes, each deletion
 * recorded once per object; the owner binding is removed only when it is older than 24 h AND
 * the meeting has no data left (so a live session, or a recording not yet collected, keeps its
 * owner). `skipId` is the meeting whose upload triggered the sweep: it is never touched.
 * Meetings are handled in small parallel chunks. Never throws.
 */
export async function sweepPendingBotData(opts: { skipId?: string } = {}): Promise<SweepResult> {
  const result: SweepResult = { audio: 0, transcripts: 0, owners: 0 };
  try {
    const entries = await fs.readdir(rootDir());
    const ids = new Set<string>();
    for (const f of entries) {
      const m = /^(.+)\.(?:meta|transcript|owner)\.json$/.exec(f);
      if (m && /^[\w-]+$/.test(m[1]) && m[1] !== opts.skipId) ids.add(m[1]);
    }
    const all = [...ids];
    for (let i = 0; i < all.length; i += SWEEP_CONCURRENCY) {
      await Promise.all(all.slice(i, i + SWEEP_CONCURRENCY).map((id) => sweepOne(id, result)));
    }
  } catch {
    /* dir may not exist yet */
  }
  return result;
}

export async function storePendingAudio(
  meetingId: string,
  buffer: Buffer,
  meta: Omit<PendingMeta, 'createdAt'>,
): Promise<void> {
  assertSafeId(meetingId);
  await fs.mkdir(rootDir(), { recursive: true });
  // Other meetings' expired data goes; this meeting's own owner binding and files are left alone.
  // At most once a minute: the cron route covers the rest, so a burst of uploads does not rescan the directory each time.
  if (Date.now() - lastOpportunisticSweep >= OPPORTUNISTIC_SWEEP_INTERVAL_MS) {
    lastOpportunisticSweep = Date.now();
    await sweepPendingBotData({ skipId: meetingId });
  }
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

export interface PendingDeleteAudit {
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
export async function deletePendingAudio(meetingId: string, audit?: PendingDeleteAudit): Promise<boolean> {
  assertSafeId(meetingId);
  const [removed] = await Promise.all([
    fs.unlink(audioPath(meetingId)).then(() => true, () => false),
    fs.unlink(metaPath(meetingId)).catch(() => {}),
  ]);
  if (removed && audit) await emitDeleted(meetingId, audit, 'audio');
  return removed;
}

/** One bot.audio_delete (best effort, never throws): the server-held recording or transcript is gone. */
async function emitDeleted(meetingId: string, audit: PendingDeleteAudit, object: 'audio' | 'transcript'): Promise<void> {
  // The id came from a URL or a file name: it is an entity only when it is a well-formed UUID.
  const event = {
    type: 'bot.audio_delete' as const,
    source: 'system' as const,
    actorUserId: audit.actorUserId ?? null,
    ...(UUID_RE.test(meetingId) ? { entityId: meetingId } : {}),
    // 'audio' is the default and stays out of the details, so existing rows and readers are unchanged.
    details: object === 'audio' ? { trigger: audit.trigger } : { trigger: audit.trigger, object },
  };
  await (audit.req ? recordServerEvent(audit.req, event) : recordEvent(event));
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

/**
 * Deletes the stashed transcript. With `audit`, a bot.audio_delete (object transcript) is recorded
 * when a transcript that actually held text (status ready) was removed; a 'processing' or
 * 'failed' marker has no content, so deleting it is not logged. Returns whether a file was removed.
 */
export async function deletePendingTranscript(meetingId: string, audit?: PendingDeleteAudit): Promise<boolean> {
  assertSafeId(meetingId);
  const heldText = audit ? (await readPendingTranscript(meetingId))?.status === 'ready' : false;
  const removed = await fs.unlink(transcriptPath(meetingId)).then(() => true, () => false);
  if (removed && audit && heldText) await emitDeleted(meetingId, audit, 'transcript');
  return removed;
}
