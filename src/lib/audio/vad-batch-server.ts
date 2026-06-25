import { HviskeProvider, isEnsembleDiarization } from '@/lib/ai/transcription';
import { energyVAD } from '@/lib/audio/vad-client';
import {
  BATCH_DURATION_S,
  newVadBatchState,
  sealCurrentBatch,
  splitTextWithIntervals,
  type ReadyBatch,
  type VadInterval,
} from '@/lib/audio/vad-batch';
import { decodeToMono16k } from '@/lib/audio/decode-server';
import type { TranscriptSegment } from '@/types';

const SAMPLE_RATE = 16_000;
// Per-request timeout for batch transcription. Longer than the live-caption 20 s
// because at full fan-out individual requests queue on the hviske server.
const BATCH_TIMEOUT_MS = 60_000;

let _provider: HviskeProvider | null = null;
function getProvider() {
  if (!_provider) _provider = new HviskeProvider();
  return _provider;
}

export { isEnsembleDiarization };

// Ensemble path: one call to the transcription server returns diarized, timestamped
// segments — no VAD batching, no separate diarization pass. Used when
// HVISKE_DIARIZE=true (platform.syv.ai). See HviskeProvider.transcribeEnsemble.
export async function transcribeEnsemble(buffer: Buffer, mimeType: string): Promise<TranscriptSegment[]> {
  return getProvider().transcribeEnsemble(buffer, mimeType);
}

// Mirror of the hallucination guard in /api/meetings/[id]/utterance.
function isHallucinatedRepetition(text: string): boolean {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 4) return false;
  const freq: Record<string, number> = {};
  for (const w of words) freq[w] = (freq[w] ?? 0) + 1;
  if (Math.max(...Object.values(freq)) / words.length > 0.5) return true;
  let streak = 1;
  for (let i = 1; i < words.length; i++) {
    if (words[i] === words[i - 1]) { if (++streak >= 3) return true; } else streak = 1;
  }
  return false;
}

// How many batch requests to keep in flight at once. Defaults to "all of them" —
// Node's undici has no per-origin connection cap (unlike the browser's ~6 on
// HTTP/1.1), and the hviske server queues internally. Set HVISKE_BATCH_CONCURRENCY
// as backpressure if the GPU box degrades under unbounded fan-out.
function batchConcurrency(taskCount: number): number {
  const env = Number(process.env.HVISKE_BATCH_CONCURRENCY);
  return Number.isFinite(env) && env > 0 ? Math.min(env, taskCount) : taskCount;
}

async function runWithConcurrencyServer<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  const queue = tasks.map((task, i) => ({ task, i }));
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    let item: typeof queue[0] | undefined;
    while ((item = queue.shift()) !== undefined) {
      results[item.i] = await item.task();
    }
  });
  await Promise.all(workers);
  return results;
}

export interface BatchEvent {
  segments: TranscriptSegment[];
  batchSeconds: number;
  completedBatches: number;
  totalBatches: number;
  failed: boolean;
}

export interface VadBatchResult {
  segments: TranscriptSegment[];
  totalBatches: number;
  totalSpeechSeconds: number;
  /** Seconds of speech that failed transcription even after the retry pass. */
  failedSeconds: number;
}

// Decode + VAD only — exposed so callers can report batch counts before fan-out.
export async function prepareVadBatches(buffer: Buffer): Promise<ReadyBatch[]> {
  const samples = await decodeToMono16k(buffer);
  const state = newVadBatchState();

  for (const seg of energyVAD(samples, SAMPLE_RATE)) {
    const interval: VadInterval = {
      originalStart: seg.start,
      originalEnd: seg.end,
      wavOffset: state.pendingWavDuration,
      wavDuration: seg.audio.length / SAMPLE_RATE,
    };
    state.pendingAudio.push(seg.audio);
    state.pendingIntervals.push(interval);
    state.pendingWavDuration += interval.wavDuration;
    if (state.pendingWavDuration >= BATCH_DURATION_S) sealCurrentBatch(state);
  }
  sealCurrentBatch(state);
  return state.readyBatches;
}

async function transcribeOneBatch(batch: ReadyBatch): Promise<TranscriptSegment[]> {
  const wavBuf = Buffer.from(await batch.wav.arrayBuffer());
  const { text } = await getProvider().transcribeRaw(wavBuf, 'audio/wav', { timeoutMs: BATCH_TIMEOUT_MS });
  if (!text || isHallucinatedRepetition(text)) return [];
  return splitTextWithIntervals(text, batch.intervals, batch.totalWavDuration);
}

// Server-side equivalent of the VAD batch pipeline in upload-confirm.client.tsx.
// Decodes audio with ffmpeg, strips silence, splits into 27 s chunks, and dispatches
// ALL batches to hviske simultaneously. Batches that error are retried once in a
// second pass after the first wave drains, so a transient failure neither blocks a
// lane for the whole run nor silently drops 27 s of audio.
export async function transcribeVadBatches(
  batches: ReadyBatch[],
  onBatch?: (event: BatchEvent) => void,
): Promise<VadBatchResult> {
  const totalSpeechSeconds = batches.reduce((s, b) => s + b.totalWavDuration, 0);
  if (batches.length === 0) {
    return { segments: [], totalBatches: 0, totalSpeechSeconds: 0, failedSeconds: 0 };
  }

  let completed = 0;
  const failedIndices: number[] = [];
  const perBatch: TranscriptSegment[][] = Array.from({ length: batches.length }, () => []);

  const tasks = batches.map((batch, i) => async () => {
    try {
      perBatch[i] = await transcribeOneBatch(batch);
    } catch (err) {
      console.error(`[vad-batch-server] batch ${i} failed (will retry):`, err);
      failedIndices.push(i);
      return;
    }
    onBatch?.({
      segments: perBatch[i],
      batchSeconds: batch.totalWavDuration,
      completedBatches: ++completed,
      totalBatches: batches.length,
      failed: false,
    });
  });

  await runWithConcurrencyServer(tasks, batchConcurrency(tasks.length));

  // Second pass: one application-level retry of everything that failed.
  let failedSeconds = 0;
  await Promise.all(failedIndices.map(async (i) => {
    let failed = false;
    try {
      perBatch[i] = await transcribeOneBatch(batches[i]);
    } catch (err) {
      console.error(`[vad-batch-server] batch ${i} failed permanently:`, err);
      perBatch[i] = [];
      failedSeconds += batches[i].totalWavDuration;
      failed = true;
    }
    onBatch?.({
      segments: perBatch[i],
      batchSeconds: batches[i].totalWavDuration,
      completedBatches: ++completed,
      totalBatches: batches.length,
      failed,
    });
  }));

  const segments = perBatch.flat().sort((a, b) => a.start - b.start);
  return { segments, totalBatches: batches.length, totalSpeechSeconds, failedSeconds };
}

// Convenience wrapper retained for callers that just want the segments.
export async function transcribeWithVadBatches(buffer: Buffer): Promise<TranscriptSegment[]> {
  const batches = await prepareVadBatches(buffer);
  const { segments } = await transcribeVadBatches(batches);
  return segments;
}
