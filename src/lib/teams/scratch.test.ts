import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { clearStaleScratch, SCRATCH_STALE_MS, teamsScratchRoot } from './scratch';

// A crash, a deploy or an OOM mid-run leaves the recording's mp4 and wav (and
// the decoder's copy) behind: hundreds of MB of meeting audio nobody deletes.

let base: string;
let osTmp: string;
const NOW = Date.now();

async function entry(dir: string, name: string, ageMs: number): Promise<string> {
  const at = path.join(dir, name);
  await fs.mkdir(at, { recursive: true });
  await fs.writeFile(path.join(at, 'recording.mp4'), 'lyd');
  const when = new Date(NOW - ageMs);
  await fs.utimes(path.join(at, 'recording.mp4'), when, when);
  await fs.utimes(at, when, when);
  return at;
}

async function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(() => true, () => false);
}

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'scratch-test-storage-'));
  osTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'scratch-test-os-'));
  vi.stubEnv('AUDIO_STORAGE_PATH', base);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(base, { recursive: true, force: true });
  await fs.rm(osTmp, { recursive: true, force: true });
});

describe('clearStaleScratch', () => {
  it("removes a dead run's scratch, and the decoder's, but not a run still going", async () => {
    const root = teamsScratchRoot();
    const dead = await entry(root, 'meet-1-abc123', SCRATCH_STALE_MS + 60_000);
    const live = await entry(root, 'meet-2-def456', 60_000);
    const deadDecode = await entry(osTmp, 'os2taletiltekst-audio-x1', SCRATCH_STALE_MS + 60_000);
    const liveDecode = await entry(osTmp, 'os2taletiltekst-audio-x2', 60_000);
    const someoneElses = await entry(osTmp, 'other-app-stuff', SCRATCH_STALE_MS * 10);

    await clearStaleScratch(NOW, osTmp);

    expect(await exists(dead)).toBe(false);
    expect(await exists(deadDecode)).toBe(false);
    expect(await exists(live)).toBe(true);
    expect(await exists(liveDecode)).toBe(true);
    expect(await exists(someoneElses)).toBe(true);
  });

  it('judges a run by its newest file: a download still being written is alive', async () => {
    const root = teamsScratchRoot();
    const dir = await entry(root, 'meet-3-ghi789', SCRATCH_STALE_MS + 60_000);
    await fs.writeFile(path.join(dir, 'recording.wav'), 'lyd'); // written just now

    await clearStaleScratch(NOW, osTmp);

    expect(await exists(dir)).toBe(true);
  });

  it('is fine with nothing there at all', async () => {
    await expect(clearStaleScratch(NOW, path.join(osTmp, 'missing'))).resolves.toBeUndefined();
  });
});
