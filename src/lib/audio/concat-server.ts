import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { runFfmpeg } from './decode-server';

// Joins several recordings of one meeting, in the order given, into one 16 kHz
// mono FLAC, so the upload pipeline transcribes and diarizes them as a single
// file (one diarization pass keeps the speakers consistent across the parts).
//
// The inputs go through temp files rather than pipes because some M4A/MP4 files
// need a seekable input (see decodeToMono16k). The output goes to a temp file too:
// FLAC written to a pipe has no total-sample count in its header, which it gets
// when ffmpeg can seek back. FLAC rather than mp4 because the diarization service
// decodes its upload from a pipe. The temp dir is removed whatever happens, so
// nothing of the meeting stays on disk.
export async function concatToMono16kFlac(inputs: Buffer[]): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'os2taletiltekst-concat-'));

  try {
    const inputPaths = inputs.map((_, i) => join(dir, `input-${i}`));
    await Promise.all(inputs.map((buffer, i) => writeFile(inputPaths[i], buffer)));

    // Each part is resampled to one format first: the concat filter needs every
    // segment in the same sample rate and channel layout.
    const normalise = inputs.map((_, i) => `[${i}:a]aresample=16000,aformat=channel_layouts=mono[a${i}]`);
    const joined = `${inputs.map((_, i) => `[a${i}]`).join('')}concat=n=${inputs.length}:v=0:a=1[out]`;
    const outputPath = join(dir, 'joined.flac');

    await runFfmpeg(
      [
        '-loglevel', 'error', '-nostdin',
        ...inputPaths.flatMap((path) => ['-i', path]),
        '-filter_complex', [...normalise, joined].join(';'),
        '-map', '[out]',
        '-ar', '16000', '-ac', '1', '-c:a', 'flac',
        outputPath,
      ],
      { context: 'Joining uploaded audio files' },
    );

    return await readFile(outputPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
