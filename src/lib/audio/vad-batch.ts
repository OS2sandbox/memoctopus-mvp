import type { TranscriptSegment } from '@/types';

// 27 s: hviske processes up to ~30 s windows reliably; leaves headroom for VAD pre/post-roll padding.
export const BATCH_DURATION_S = 27;
// 20 workers: enough to saturate a GPU server without overwhelming it on long recordings.
export const BATCH_CONCURRENCY = 20;
export const MAX_WORDS_PER_LINE = 20;

export type VadInterval = {
  originalStart: number;
  originalEnd: number;
  wavOffset: number;
  wavDuration: number;
};

export type ReadyBatch = {
  wav: Blob;
  intervals: VadInterval[];
  totalWavDuration: number;
};

export type VadBatchState = {
  pendingAudio: Float32Array[];
  pendingIntervals: VadInterval[];
  pendingWavDuration: number;
  readyBatches: ReadyBatch[];
};

export function newVadBatchState(): VadBatchState {
  return { pendingAudio: [], pendingIntervals: [], pendingWavDuration: 0, readyBatches: [] };
}

export function float32ToWavBlob(samples: Float32Array, startSample = 0, endSample?: number): Blob {
  const src = samples.subarray(startSample, endSample);
  const numSamples = src.length;
  const dataBytes = numSamples * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const ws = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true);
  ws(8, 'WAVE'); ws(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16_000, true); v.setUint32(28, 32_000, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, dataBytes, true);
  let off = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, src[i]));
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([buf], { type: 'audio/wav' });
}

export function sealCurrentBatch(state: VadBatchState): void {
  if (state.pendingAudio.length === 0) return;
  const totalSamples = state.pendingAudio.reduce((n, a) => n + a.length, 0);
  const combined = new Float32Array(totalSamples);
  let off = 0;
  for (const a of state.pendingAudio) { combined.set(a, off); off += a.length; }
  const wav = float32ToWavBlob(combined);
  state.readyBatches.push({ wav, intervals: state.pendingIntervals, totalWavDuration: state.pendingWavDuration });
  state.pendingAudio = [];
  state.pendingIntervals = [];
  state.pendingWavDuration = 0;
}

export function mapWavTime(wavT: number, intervals: VadInterval[]): number {
  for (const iv of intervals) {
    if (iv.wavDuration === 0) continue;
    if (wavT >= iv.wavOffset && wavT <= iv.wavOffset + iv.wavDuration) {
      return iv.originalStart + ((wavT - iv.wavOffset) / iv.wavDuration) * (iv.originalEnd - iv.originalStart);
    }
  }
  if (intervals.length === 0) return 0;
  if (wavT <= intervals[0].wavOffset) return intervals[0].originalStart;
  return intervals[intervals.length - 1].originalEnd;
}

export function splitTextWithIntervals(
  text: string,
  intervals: VadInterval[],
  totalWavDuration: number,
): TranscriptSegment[] {
  if (!text.trim() || intervals.length === 0) return [];
  const punctChunks = (text.trim().match(/[^.!?]+[.!?]+/g) ?? [text.trim()]).map(s => s.trim()).filter(Boolean);
  const sentences: string[] = [];
  for (const chunk of punctChunks) {
    const words = chunk.split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i += MAX_WORDS_PER_LINE) {
      sentences.push(words.slice(i, i + MAX_WORDS_PER_LINE).join(' '));
    }
  }
  if (sentences.length === 0) return [];
  const wordCounts = sentences.map(s => s.split(/\s+/).filter(Boolean).length);
  const totalWords = Math.max(1, wordCounts.reduce((a, b) => a + b, 0));
  let elapsed = 0;
  return sentences.map((sentence, i) => {
    const segDur = (wordCounts[i] / totalWords) * totalWavDuration;
    const wavStart = elapsed;
    elapsed += segDur;
    return {
      speaker: 'Taler 1',
      start: mapWavTime(wavStart, intervals),
      end: mapWavTime(elapsed, intervals),
      text: sentence,
    };
  });
}

export async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
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
