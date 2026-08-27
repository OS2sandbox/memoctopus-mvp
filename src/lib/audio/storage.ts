import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';

function getStorageRoot(): string {
  return process.env.AUDIO_STORAGE_PATH ?? path.join(process.cwd(), 'audio-storage');
}

function getUserAudioDir(userId: string): string {
  return path.join(getStorageRoot(), userId);
}

function assertSafeFilename(filename: string): void {
  if (!/^[\w.-]+$/.test(filename)) {
    throw new Error(`Invalid audio filename: ${filename}`);
  }
}

export async function ensureUserAudioDir(userId: string): Promise<void> {
  const dir = getUserAudioDir(userId);
  await fs.mkdir(dir, { recursive: true });
}

export async function saveAudioFile(
  userId: string,
  buffer: Buffer,
  originalName: string,
): Promise<{ filename: string; sizeBytes: number }> {
  await ensureUserAudioDir(userId);

  const ext = path.extname(originalName) || '.webm';
  const hash = crypto.randomBytes(16).toString('hex');
  const filename = `${Date.now()}-${hash}${ext}`;
  const filepath = path.join(getUserAudioDir(userId), filename);

  await fs.writeFile(filepath, buffer);

  return {
    filename,
    sizeBytes: buffer.byteLength,
  };
}

export async function readAudioFile(userId: string, filename: string): Promise<Buffer> {
  assertSafeFilename(filename);
  const filepath = path.join(getUserAudioDir(userId), filename);
  return fs.readFile(filepath);
}

export async function deleteAudioFile(userId: string, filename: string): Promise<void> {
  assertSafeFilename(filename);
  const filepath = path.join(getUserAudioDir(userId), filename);
  try {
    await fs.unlink(filepath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}

export function getAudioFilePath(userId: string, filename: string): string {
  assertSafeFilename(filename);
  return path.join(getUserAudioDir(userId), filename);
}

export function createAudioReadStream(
  userId: string,
  filename: string,
  opts?: { start?: number; end?: number },
): fsSync.ReadStream {
  return fsSync.createReadStream(getAudioFilePath(userId, filename), opts);
}

export async function audioFileExists(userId: string, filename: string): Promise<boolean> {
  assertSafeFilename(filename);
  const filepath = path.join(getUserAudioDir(userId), filename);
  try {
    await fs.access(filepath);
    return true;
  } catch {
    return false;
  }
}
