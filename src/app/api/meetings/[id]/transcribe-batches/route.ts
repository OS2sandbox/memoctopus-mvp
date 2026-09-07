import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { prepareVadBatches, transcribeVadBatches, transcribeEnsemble, isEnsembleDiarization } from '@/lib/audio/vad-batch-server';
import type { TranscriptSegment } from '@/types';

interface Params {
  params: Promise<{ id: string }>;
}

// Decoding + VAD + the hviske fan-out can exceed serverless defaults for long
// recordings; the self-hosted deployment has no such cap.
export const maxDuration = 300;

export type TranscribeBatchesEvent =
  | { type: 'meta'; totalBatches: number; totalSpeechSeconds: number }
  | { type: 'batch'; segments: TranscriptSegment[]; batchSeconds: number; completedBatches: number; totalBatches: number }
  // `diarized: true` signals the segments already carry real speaker labels (the
  // ensemble endpoint diarized inline), so no separate diarization pass is needed.
  | { type: 'done'; segments: TranscriptSegment[]; failedSeconds: number; diarized?: boolean }
  | { type: 'error'; message: string };

// Batch transcription for the upload and bot-recording paths. The client uploads
// the ORIGINAL compressed recording once; the server decodes it with ffmpeg, runs
// VAD, and dispatches all 27 s batches to hviske simultaneously (Node has no
// browser-style per-origin connection cap, so the fan-out is bounded by hviske
// throughput, not by the transport). Progress streams back as NDJSON so the client
// can keep its live preview. No persistence — the client stores the transcript in
// IndexedDB, same as the per-utterance path.
export async function POST(req: NextRequest, { params }: Params) {
  const { id: _id } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const formData = await req.formData();
  const audioFile = formData.get('audio') as File | null;
  if (!audioFile) return NextResponse.json({ error: 'Missing audio' }, { status: 400 });

  const buffer = Buffer.from(await audioFile.arrayBuffer());
  if (buffer.length < 2_000) {
    return NextResponse.json({ error: 'Audio too short' }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: TranscribeBatchesEvent) =>
        controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));

      const t0 = Date.now();
      try {
        // Ensemble path: one call returns diarized, timestamped segments — no VAD
        // fan-out, no separate diarization pass. Emitted as a single batch so the
        // existing client (live preview + store) keeps working unchanged.
        if (isEnsembleDiarization()) {
          const segments = await transcribeEnsemble(buffer, audioFile.type || 'audio/wav');
          const speechSeconds = segments.length ? segments[segments.length - 1].end : 0;
          send({ type: 'meta', totalBatches: 1, totalSpeechSeconds: speechSeconds });
          send({ type: 'batch', segments, batchSeconds: speechSeconds, completedBatches: 1, totalBatches: 1 });
          console.log(
            `[transcribe-batches] ensemble: ${buffer.length} bytes → ${segments.length} diarized segments ` +
            `(${Math.round(speechSeconds)} s) in ${Date.now() - t0} ms`,
          );
          send({ type: 'done', segments, failedSeconds: 0, diarized: true });
          return;
        }

        const batches = await prepareVadBatches(buffer);
        const totalSpeechSeconds = batches.reduce((s, b) => s + b.totalWavDuration, 0);
        send({ type: 'meta', totalBatches: batches.length, totalSpeechSeconds });

        const result = await transcribeVadBatches(batches, (e) => {
          send({
            type: 'batch',
            segments: e.segments,
            batchSeconds: e.batchSeconds,
            completedBatches: e.completedBatches,
            totalBatches: e.totalBatches,
          });
        });

        console.log(
          `[transcribe-batches] ${buffer.length} bytes → ${result.totalBatches} batches ` +
          `(${Math.round(totalSpeechSeconds)} s speech) in ${Date.now() - t0} ms` +
          (result.failedSeconds > 0 ? ` — ${Math.round(result.failedSeconds)} s FAILED` : ''),
        );
        send({ type: 'done', segments: result.segments, failedSeconds: result.failedSeconds });
      } catch (err) {
        console.error(`[transcribe-batches] failed after ${Date.now() - t0} ms:`, err);
        send({ type: 'error', message: err instanceof Error ? err.message : 'Transcription failed' });
      } finally {
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      // Disable proxy buffering so progress lines reach the client promptly.
      'X-Accel-Buffering': 'no',
    },
  });
}
