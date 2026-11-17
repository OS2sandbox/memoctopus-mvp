import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// Scratch audio: where a Teams recording is downloaded and transcoded (one
// directory per run under AUDIO_STORAGE_PATH/teams-tmp), and where the ffmpeg
// decoder copies its input (os2taletiltekst-audio-* in the OS temp dir). Each run
// removes its own in a `finally`, which a crash, a deploy or an OOM skips — and
// what is left is meeting audio, hundreds of MB of it, that nothing else deletes.

/** Prefix decodeToMono16k (src/lib/audio/decode-server.ts) gives its temp directories. */
const DECODER_SCRATCH_PREFIX = 'os2taletiltekst-audio-';

/**
 * Scratch untouched for this long belongs to a run that died. Far wider than a
 * run's longest stretch (a 20-minute download, then a transcode), because the
 * Teams scratch sits on the shared volume and another instance may be mid-run.
 */
export const SCRATCH_STALE_MS = 60 * 60 * 1000;

/** Where the pipeline downloads and transcodes a recording, one directory per run. */
export function teamsScratchRoot(): string {
  const base = process.env.AUDIO_STORAGE_PATH?.trim() || path.join(process.cwd(), 'audio-storage');
  return path.join(base, 'teams-tmp');
}

/** Newest modification time of a directory and the files directly in it. */
async function lastTouched(dir: string): Promise<number> {
  let newest = (await fs.stat(dir)).mtimeMs;
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    const stat = await fs.stat(path.join(dir, name)).catch(() => null);
    if (stat) newest = Math.max(newest, stat.mtimeMs);
  }
  return newest;
}

async function clearIn(dir: string, matches: (name: string) => boolean, now: number): Promise<number> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return 0; // nothing has ever been written there
  }
  let cleared = 0;
  for (const name of names.filter(matches)) {
    const at = path.join(dir, name);
    try {
      if (now - (await lastTouched(at)) < SCRATCH_STALE_MS) continue;
      await fs.rm(at, { recursive: true, force: true });
      cleared += 1;
    } catch {
      // Gone already, or not ours to read: leave it.
    }
  }
  return cleared;
}

/**
 * Removes scratch audio left behind by runs that died. Best effort; never throws.
 * Run once at start-up, from the pending sweeper.
 */
export async function clearStaleScratch(now: number = Date.now(), osTmpDir: string = os.tmpdir()): Promise<void> {
  const cleared =
    (await clearIn(teamsScratchRoot(), () => true, now))
    + (await clearIn(osTmpDir, (name) => name.startsWith(DECODER_SCRATCH_PREFIX), now));
  if (cleared > 0) {
    console.log(`[scratch] removed ${cleared} scratch director${cleared === 1 ? 'y' : 'ies'} left by runs that died`);
  }
}
