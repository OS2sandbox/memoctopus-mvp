import { spawn } from 'child_process';

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
  buf.writeUInt32LE(16, 16);       // PCM fmt chunk size
  buf.writeUInt16LE(1, 20);        // audio format = PCM
  buf.writeUInt16LE(1, 22);        // channels = mono
  buf.writeUInt32LE(16_000, 24);   // sample rate
  buf.writeUInt32LE(32_000, 28);   // byte rate = 16000 * 1 * 2
  buf.writeUInt16LE(2, 32);        // block align
  buf.writeUInt16LE(16, 34);       // bits per sample
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

// Decode any audio format to 16 kHz mono Float32 PCM using ffmpeg.
// Used server-side where AudioContext / OfflineAudioContext are unavailable.
export async function decodeToMono16k(buffer: Buffer): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-ar', '16000',
      '-ac', '1',
      '-f', 'f32le',
      'pipe:1',
    ]);

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let settled = false;

    ff.stdout.on('data', (chunk: Buffer) => outChunks.push(chunk));
    ff.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));
    ff.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (err.code === 'ENOENT') {
        reject(new Error(
          'ffmpeg not found on PATH. Audio decoding for transcription requires ffmpeg. ' +
          'Install it locally (macOS: `brew install ffmpeg`); the production Docker image already includes it.',
        ));
        return;
      }
      reject(err);
    });
    ff.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        const msg = Buffer.concat(errChunks).toString().trim();
        reject(new Error(`ffmpeg exited ${code}: ${msg}`));
        return;
      }
      const raw = Buffer.concat(outChunks);
      const ab = new ArrayBuffer(raw.byteLength);
      new Uint8Array(ab).set(raw);
      resolve(new Float32Array(ab));
    });

    // Guard against EPIPE when the process failed to spawn (e.g. ffmpeg
    // missing) — writing to a dead stdin throws synchronously/asynchronously.
    ff.stdin.on('error', () => { /* surfaced via ff.on('error') */ });
    try {
      ff.stdin.write(buffer);
      ff.stdin.end();
    } catch { /* surfaced via ff.on('error') */ }
  });
}
