import { HviskeProvider } from '@/lib/ai/transcription';
import { decodeToMono16k, encodeMono16kWav } from '@/lib/audio/decode-server';
import { cleanTranscribedText } from '@/lib/audio/hallucinations';
import { splitTextWithIntervals, type VadInterval } from '@/lib/audio/vad-batch';
import { DEFAULT_SPEAKER_LABEL } from '@/lib/audio/speaker-labels';
import type { TranscriptSegment } from '@/types';
import { planCueBatches, type CueBatch } from './cue-batches';
import { fillSpeakerNames } from './name-speakers';
import type { VttCue } from './vtt';

// Transcribes a Teams recording along Microsoft's own transcript cues — see
// cue-batches.ts for why the generic spliced-VAD path loses most of a Teams
// recording. Each slice is a contiguous stretch of the recording covering one
// group of cues; hviske supplies the Danish text, the cues supply the timing and
// the real speaker names.

const SAMPLE_RATE = 16_000;

/** Same per-request budget as the VAD fan-out: requests queue on the GPU box. */
const BATCH_TIMEOUT_MS = 60_000;

let _provider: HviskeProvider | null = null;
function getProvider(): HviskeProvider {
  if (!_provider) _provider = new HviskeProvider();
  return _provider;
}

/** Test seam — the pipeline test swaps in a provider that never leaves the process. */
export function setCueTranscriptionProvider(provider: HviskeProvider | null): void {
  _provider = provider;
}

function concurrency(taskCount: number): number {
  const env = Number(process.env.HVISKE_BATCH_CONCURRENCY);
  return Number.isFinite(env) && env > 0 ? Math.min(env, taskCount) : taskCount;
}

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
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

/**
 * The batch's cues as the intervals `splitTextWithIntervals` divides text over.
 * The "wav timeline" here is the cues laid end to end, so a line's share of the
 * batch's words lands on the cue that was being spoken at that point — and that
 * cue's speaker is then the line's speaker, exactly, with no overlap guessing.
 */
function cueIntervals(batch: CueBatch): { intervals: VadInterval[]; total: number } {
  let offset = 0;
  const intervals = batch.cues.map((cue) => {
    const duration = Math.max(cue.end - cue.start, 0.01);
    const interval: VadInterval = {
      originalStart: cue.start,
      originalEnd: cue.end,
      wavOffset: offset,
      wavDuration: duration,
    };
    offset += duration;
    return interval;
  });
  return { intervals, total: offset };
}

/**
 * The cue a produced segment sits in — the one it overlaps most.
 *
 * Only cues that actually carry a display name are considered. Teams emits the
 * occasional cue with no `<v Name>` span, and letting one of those win the
 * overlap put a `Taler 1` in the middle of a meeting whose speakers we knew.
 * A batch with no named cue at all falls back to the nearest named cue by
 * distance, and failing that to the placeholder, which fillSpeakerNames then
 * resolves from the surrounding segments.
 */
function speakerAt(batch: CueBatch, start: number, end: number): string {
  const named = batch.cues.filter((cue) => cue.speaker);
  if (named.length === 0) return DEFAULT_SPEAKER_LABEL;

  let best: VttCue | null = null;
  let bestOverlap = 0;
  for (const cue of named) {
    const overlap = Math.min(end, cue.end) - Math.max(start, cue.start);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = cue;
    }
  }
  if (best) return best.speaker!;

  // No overlap with any named cue: take the closest one in time.
  let nearest = named[0];
  let shortest = Infinity;
  for (const cue of named) {
    const gap = start > cue.end ? start - cue.end : cue.start - end;
    if (gap < shortest) {
      shortest = gap;
      nearest = cue;
    }
  }
  return nearest.speaker!;
}

export interface CueTranscriptionResult {
  segments: TranscriptSegment[];
  /** Slices attempted, and how many came back with nothing usable. */
  batches: number;
  emptyBatches: number;
}

/**
 * Transcribes `buffer` (the transcoded Teams recording) slice by slice along
 * `cues`, returning segments carrying the cues' own speaker display names.
 *
 * Failure of one slice is not failure of the meeting: the slice is retried once
 * and then given up on, exactly as the VAD fan-out does, so one bad request
 * costs its own few seconds of audio rather than the whole referat.
 */
export async function transcribeAlongCues(
  buffer: Buffer,
  cues: VttCue[],
): Promise<CueTranscriptionResult> {
  const samples = await decodeToMono16k(buffer);
  const durationSeconds = samples.length / SAMPLE_RATE;
  const batches = planCueBatches(cues, durationSeconds);
  if (batches.length === 0) return { segments: [], batches: 0, emptyBatches: 0 };

  const transcribeOne = async (batch: CueBatch): Promise<TranscriptSegment[]> => {
    const from = Math.max(0, Math.floor(batch.start * SAMPLE_RATE));
    const to = Math.min(samples.length, Math.ceil(batch.end * SAMPLE_RATE));
    if (to <= from) return [];

    const wav = encodeMono16kWav(samples.subarray(from, to));
    const { text } = await getProvider().transcribeRaw(wav, 'audio/wav', {
      timeoutMs: BATCH_TIMEOUT_MS,
    });
    const cleaned = cleanTranscribedText(text ?? '');
    if (!cleaned) return [];

    const { intervals, total } = cueIntervals(batch);
    return splitTextWithIntervals(cleaned, intervals, total).map((segment) => ({
      ...segment,
      speaker: speakerAt(batch, segment.start, segment.end),
    }));
  };

  const perBatch: TranscriptSegment[][] = Array.from({ length: batches.length }, () => []);
  const failed: number[] = [];

  await runWithConcurrency(
    batches.map((batch, i) => async () => {
      try {
        perBatch[i] = await transcribeOne(batch);
      } catch (err) {
        console.error(`[teams/transcribe-cues] slice ${i} failed (will retry):`, err);
        failed.push(i);
      }
    }),
    concurrency(batches.length),
  );

  await Promise.all(
    failed.map(async (i) => {
      try {
        perBatch[i] = await transcribeOne(batches[i]);
      } catch (err) {
        console.error(`[teams/transcribe-cues] slice ${i} failed permanently:`, err);
        perBatch[i] = [];
      }
    }),
  );

  const segments = fillSpeakerNames(perBatch.flat().sort((a, b) => a.start - b.start));
  return {
    segments,
    batches: batches.length,
    emptyBatches: perBatch.filter((s) => s.length === 0).length,
  };
}
