import fs from 'fs/promises';
import path from 'path';
import type { TranscriptSegment } from '@/types';

// Transient server-side hand-off for artifacts produced without a browser present.
//
// The Graph pipeline collects a meeting's recording and transcript from Teams long
// after whoever armed it has closed the tab. Meetings live in the user's browser
// IndexedDB, so the server cannot persist them itself. It stashes them here instead,
// keyed by meetingId, until the browser pulls them down into IndexedDB (through
// /api/meetings/[id]/pending-meta and /pending-transcript), where the normal
// client-side pipeline takes over.
//
// Reading is not consuming. The IndexedDB copy is the only durable one, so the
// stash is deleted only when the browser acknowledges that it has saved the
// transcript (DELETE on /pending-transcript, see acknowledgePendingTranscript).
// Deleting on read would lose the transcript for good whenever the tab crashed, or
// the response was lost, between the read and the save.
//
// Anything the browser never acknowledges is dropped once it is older than the TTL
// by a timer (pending-sweeper.ts, started from instrumentation.ts) that runs whether
// or not any meeting is being processed, so the retention is bounded and does not
// depend on what else the server happens to be doing.

const TTL_MS = 60 * 60 * 1000; // 1 hour

// A 'processing' stash is a run that is still working, and its owner file was
// written when it began, so on a long meeting both can outlast the TTL. They are
// spared until they are older than this, which is deliberately far wider than the
// pipeline's own 30 minute "this run is dead" rule (PROCESSING_STALE_MS): the sweep
// must never beat a merely slow run to its files, only reap the remains of a dead one.
const RUN_IN_PROGRESS_MAX_MS = 6 * 60 * 60 * 1000;

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

// Server-side transcription result of a Teams meeting. Written as 'processing' when
// a run starts (so the client knows work is underway), then overwritten with 'ready'
// + segments or 'failed'. Transient: the client pulls it into IndexedDB and
// acknowledges it, and it is deleted (or, if never acknowledged, swept after the TTL).
export interface PendingTranscript {
  status: 'processing' | 'ready' | 'failed';
  segments?: TranscriptSegment[];
  /** Whether speaker turns were merged in (false → client may diarize itself). */
  diarized?: boolean;
  createdAt: number;
}

type StashKind = 'meta' | 'transcript' | 'owner';
const STASH_FILE = /^(.+)\.(meta|transcript|owner)\.json$/;

/**
 * When a stash file was written: its own `createdAt`, or, when it has none that is a
 * number (half-written right now, malformed, or missing), its modification time.
 * Ignoring such a file would judge the entry by an older sibling and delete a
 * transcript that is being written this very moment, and a NaN would make the entry
 * look infinitely old. Null means the file is gone.
 */
async function fileTime(file: string, rec: { createdAt?: unknown } | null): Promise<number | null> {
  if (typeof rec?.createdAt === 'number' && Number.isFinite(rec.createdAt)) return rec.createdAt;
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Drops entries the client never collected. Best effort: it never throws.
 *
 * An entry (all the files sharing a meetingId) is judged as a whole, by its newest
 * file. Judging files one by one would delete a transcript that has just finished
 * because the owner file beside it was written when the run began, hours earlier.
 *
 * Two kinds of entry are never removed:
 *  - `exceptId`, the meeting a caller is writing right now;
 *  - a run still in progress, i.e. a 'processing' transcript that is not yet absurdly
 *    old. The owner file is written once at the start, while the download, transcode
 *    and ASR that follow can outlast the TTL on a long meeting. Sweeping blind would
 *    delete it, and since the hand-off routes deny by default without an owner, a
 *    successful transcription would become uncollectable. This has to be decided
 *    from what is on disk rather than by the caller: the timer has no run of its own
 *    to exclude, and another instance may be the one running.
 */
export async function sweepExpired(exceptId?: string): Promise<void> {
  try {
    const dir = rootDir();
    const entries = await fs.readdir(dir);
    const now = Date.now();

    const byId = new Map<string, Partial<Record<StashKind, string>>>();
    for (const f of entries) {
      const m = STASH_FILE.exec(f);
      if (!m || m[1] === exceptId) continue;
      byId.set(m[1], { ...byId.get(m[1]), [m[2] as StashKind]: f });
    }

    let swept = 0;
    await Promise.all(
      [...byId].map(async ([id, files]) => {
        let newest = 0;
        let inProgress = false;
        for (const f of Object.values(files)) {
          const file = path.join(dir, f);
          let rec: { createdAt?: unknown; status?: string } | null = null;
          try {
            rec = JSON.parse(await fs.readFile(file, 'utf8'));
          } catch (err) {
            // ENOENT: the file went away between readdir and read. Anything else
            // (half-written, malformed) is aged by its modification time below.
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
              console.error('[pending-artifacts] sweep: unreadable file, aging it by mtime', f, err);
            }
          }
          const at = await fileTime(file, rec);
          if (at === null) continue;
          newest = Math.max(newest, at);
          if (f.endsWith('.transcript.json') && rec?.status === 'processing') {
            inProgress = now - at <= RUN_IN_PROGRESS_MAX_MS;
          }
        }
        if (newest === 0 || inProgress || now - newest <= TTL_MS) return;
        await deletePendingMeta(id);
        await deletePendingTranscript(id);
        await fs.unlink(ownerPath(id)).catch(() => {});
        swept += 1;
      }),
    );
    if (swept > 0) console.log(`[pending-artifacts] swept ${swept} uncollected entr${swept === 1 ? 'y' : 'ies'} past the TTL`);
  } catch { /* dir may not exist yet */ }
}

/**
 * The browser has saved the transcript into IndexedDB: the server copy (and the
 * meta record and owner binding that go with it) has done its job and is removed.
 * Idempotent, and it leaves a run in progress alone, so a stale acknowledgement can
 * never delete the result of a re-collect that is under way.
 */
export async function acknowledgePendingTranscript(meetingId: string): Promise<void> {
  assertSafeId(meetingId);
  if ((await readPendingTranscript(meetingId))?.status === 'processing') return;
  await deletePendingMeta(meetingId);
  await deletePendingTranscript(meetingId);
  await fs.unlink(ownerPath(meetingId)).catch(() => {});
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
  // The timer in pending-sweeper.ts is what bounds retention. This inline sweep is
  // only a fallback for a process where the instrumentation hook never ran, and it
  // applies the same rules, so it cannot delete anything the timer would not.
  await sweepExpired(meetingId);
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
