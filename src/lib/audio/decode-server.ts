import { spawn } from 'child_process';

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
