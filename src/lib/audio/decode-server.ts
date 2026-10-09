import { spawn } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// Encode a 16 kHz mono Float32 PCM signal as a 16-bit PCM WAV Buffer.
// Server-side counterpart to float32ToWavBlob (which returns a browser Blob).
export function encodeMono16kWav(samples: Float32Array): Buffer {
  const numSamples = samples.length;
  const dataBytes = numSamples * 2;
  const buf = Buffer.alloc(44 + dataBytes);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16_000, 24);
  buf.writeUInt32LE(32_000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);

  let off = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, off);
    off += 2;
  }

  return buf;
}

/**
 * Runs ffmpeg with the given args, forwarding any stdout chunks to `onStdout`
 * (omit it when ffmpeg writes its output to a file path already in `args`
 * instead of stdout). Rejects with a message naming `context` when the ffmpeg
 * binary itself is missing, or with ffmpeg's own stderr when it exits non-zero.
 *
 * Shared by every ffmpeg-invoking caller in this codebase so the
 * spawn/ENOENT/exit-code handling is not reimplemented at each one.
 */
export function runFfmpeg(
  args: string[],
  { context, onStdout }: { context: string; onStdout?: (chunk: Buffer) => void },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ff = spawn('ffmpeg', args);

    const errChunks: Buffer[] = [];
    let settled = false;

    if (onStdout) ff.stdout?.on('data', (chunk: Buffer) => onStdout(chunk));
    ff.stderr?.on('data', (chunk: Buffer) => errChunks.push(Buffer.from(chunk)));

    ff.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;

      if (err.code === 'ENOENT') {
        reject(
          new Error(
            `ffmpeg not found on PATH. ${context} requires ffmpeg. ` +
              'Install it locally (macOS: `brew install ffmpeg`); the production Docker image already includes it.',
          ),
        );
        return;
      }

      reject(err);
    });

    ff.on('close', (code) => {
      if (settled) return;
      settled = true;

      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(errChunks).toString().trim()}`));
    });
  });
}

// Decode any audio format to 16 kHz mono Float32 PCM using ffmpeg.
//
// Some M4A/MP4 files require seekable input. Feeding them to ffmpeg through
// pipe:0 can decode to zero bytes with "partial file" errors, which then makes
// VAD report 0 seconds of speech. Write the upload to a temporary file first so
// ffmpeg can seek while demuxing.
export async function decodeToMono16k(buffer: Buffer): Promise<Float32Array> {
  const dir = await mkdtemp(join(tmpdir(), 'memoctopus-audio-'));
  const inputPath = join(dir, 'input');

  try {
    await writeFile(inputPath, buffer);

    const outChunks: Buffer[] = [];
    await runFfmpeg(
      ['-loglevel', 'error', '-nostdin', '-i', inputPath, '-ar', '16000', '-ac', '1', '-f', 'f32le', 'pipe:1'],
      { context: 'Audio decoding for transcription', onStdout: (chunk) => outChunks.push(chunk) },
    );

    const raw = Buffer.concat(outChunks);
    const ab = new ArrayBuffer(raw.byteLength);
    new Uint8Array(ab).set(raw);
    return new Float32Array(ab);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
