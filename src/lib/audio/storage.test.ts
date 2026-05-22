import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs/promises';
import path from 'path';
import {
  ensureUserAudioDir,
  saveAudioFile,
  readAudioFile,
  deleteAudioFile,
  audioFileExists,
} from './storage';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'referat-test-'));
  process.env.AUDIO_STORAGE_PATH = tmpRoot;
});

afterEach(async () => {
  delete process.env.AUDIO_STORAGE_PATH;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ─── ensureUserAudioDir ───────────────────────────────────────────────────────

describe('ensureUserAudioDir', () => {
  it('creates the user directory', async () => {
    await ensureUserAudioDir('user-abc');
    const stat = await fs.stat(path.join(tmpRoot, 'user-abc'));
    expect(stat.isDirectory()).toBe(true);
  });

  it('is idempotent — calling twice does not throw', async () => {
    await ensureUserAudioDir('user-abc');
    await expect(ensureUserAudioDir('user-abc')).resolves.not.toThrow();
  });

  it('creates nested path when storage root does not yet exist', async () => {
    process.env.AUDIO_STORAGE_PATH = path.join(tmpRoot, 'deep', 'nested');
    await ensureUserAudioDir('user-xyz');
    const stat = await fs.stat(path.join(tmpRoot, 'deep', 'nested', 'user-xyz'));
    expect(stat.isDirectory()).toBe(true);
  });
});

// ─── saveAudioFile ────────────────────────────────────────────────────────────

describe('saveAudioFile', () => {
  it('returns sizeBytes matching the buffer length', async () => {
    const buf = Buffer.from('audio content here');
    const { sizeBytes } = await saveAudioFile('u1', buf, 'rec.webm');
    expect(sizeBytes).toBe(buf.byteLength);
  });

  it('returns a filename with the original extension', async () => {
    const buf = Buffer.from('x');
    const { filename } = await saveAudioFile('u1', buf, 'recording.mp3');
    expect(filename).toMatch(/\.mp3$/);
  });

  it('defaults to .webm when filename has no extension', async () => {
    const buf = Buffer.from('x');
    const { filename } = await saveAudioFile('u1', buf, 'noextension');
    expect(filename).toMatch(/\.webm$/);
  });

  it('actually writes the file to disk', async () => {
    const buf = Buffer.from('hello world');
    const { filename } = await saveAudioFile('u1', buf, 'test.webm');
    const onDisk = await fs.readFile(path.join(tmpRoot, 'u1', filename));
    expect(onDisk.toString()).toBe('hello world');
  });

  it('generates unique filenames for multiple saves', async () => {
    const buf = Buffer.from('x');
    const r1 = await saveAudioFile('u1', buf, 'a.webm');
    const r2 = await saveAudioFile('u1', buf, 'a.webm');
    expect(r1.filename).not.toBe(r2.filename);
  });

  it('isolates files per user', async () => {
    const buf = Buffer.from('data');
    await saveAudioFile('user-a', buf, 'f.webm');
    await saveAudioFile('user-b', buf, 'f.webm');
    const dirA = await fs.readdir(path.join(tmpRoot, 'user-a'));
    const dirB = await fs.readdir(path.join(tmpRoot, 'user-b'));
    expect(dirA).toHaveLength(1);
    expect(dirB).toHaveLength(1);
  });
});

// ─── readAudioFile ────────────────────────────────────────────────────────────

describe('readAudioFile', () => {
  it('reads back the bytes that were saved', async () => {
    const original = Buffer.from('this is the audio bytes');
    const { filename } = await saveAudioFile('u1', original, 'test.webm');
    const read = await readAudioFile('u1', filename);
    expect(read.toString()).toBe('this is the audio bytes');
  });

  it('throws ENOENT when file does not exist', async () => {
    await expect(readAudioFile('u1', 'missing.webm')).rejects.toThrow();
  });
});

// ─── deleteAudioFile ──────────────────────────────────────────────────────────

describe('deleteAudioFile', () => {
  it('removes an existing file', async () => {
    const buf = Buffer.from('delete me');
    const { filename } = await saveAudioFile('u1', buf, 'del.webm');
    await deleteAudioFile('u1', filename);
    expect(await audioFileExists('u1', filename)).toBe(false);
  });

  it('does not throw when the file is already gone (idempotent)', async () => {
    await expect(deleteAudioFile('u1', 'ghost.webm')).resolves.not.toThrow();
  });
});

// ─── audioFileExists ──────────────────────────────────────────────────────────

describe('audioFileExists', () => {
  it('returns true for an existing file', async () => {
    const buf = Buffer.from('exists');
    const { filename } = await saveAudioFile('u1', buf, 'check.webm');
    expect(await audioFileExists('u1', filename)).toBe(true);
  });

  it('returns false for a missing file', async () => {
    expect(await audioFileExists('u1', 'nope.webm')).toBe(false);
  });
});
