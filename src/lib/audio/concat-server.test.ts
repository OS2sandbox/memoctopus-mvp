import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { concatToMono16kFlac } from './concat-server';
import { decodeToMono16k, encodeMono16kWav } from './decode-server';

// Runs the real ffmpeg. Where it is not installed (some CI images), the
// cases are skipped rather than mocked: a mocked ffmpeg would prove nothing
// about the joined file.
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

const TEMP_PREFIX = 'os2taletiltekst-concat-';

async function concatTempDirs(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith(TEMP_PREFIX));
}

function tone(seconds: number): Buffer {
  const samples = new Float32Array(Math.round(seconds * 16_000));
  for (let i = 0; i < samples.length; i++) samples[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 16_000);
  return encodeMono16kWav(samples);
}

describe.skipIf(!hasFfmpeg)('concatToMono16kFlac', () => {
  it('joins two WAVs into one FLAC as long as both together and leaves no temp dir', async () => {
    const before = await concatTempDirs();

    const flac = await concatToMono16kFlac([tone(0.5), tone(0.25)]);

    expect(flac.subarray(0, 4).toString('ascii')).toBe('fLaC');
    const samples = await decodeToMono16k(flac);
    expect(samples.length / 16_000).toBeCloseTo(0.75, 2);
    expect(await concatTempDirs()).toEqual(before);
  });

  it('removes the temp dir when ffmpeg cannot read an input', async () => {
    const before = await concatTempDirs();

    await expect(concatToMono16kFlac([tone(0.25), Buffer.from('not audio')])).rejects.toThrow(/ffmpeg/);
    expect(await concatTempDirs()).toEqual(before);
  });
});
