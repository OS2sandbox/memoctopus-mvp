import { HviskeProvider } from '@/lib/ai/transcription';
import { energyVAD } from '@/lib/audio/vad-client';
import {
  BATCH_DURATION_S,
  BATCH_CONCURRENCY,
  newVadBatchState,
  sealCurrentBatch,
  splitTextWithIntervals,
  runWithConcurrency,
  type VadInterval,
} from '@/lib/audio/vad-batch';
import { decodeToMono16k } from '@/lib/audio/decode-server';
import type { TranscriptSegment } from '@/types';

const SAMPLE_RATE = 16_000;

let _provider: HviskeProvider | null = null;
function getProvider() {
  if (!_provider) _provider = new HviskeProvider();
  return _provider;
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

// Server-side equivalent of the VAD batch pipeline in upload-confirm.client.tsx.
// Decodes audio with ffmpeg, strips silence, splits into 27 s chunks, and
// transcribes all batches in parallel via HviskeProvider.transcribeRaw().
export async function transcribeWithVadBatches(buffer: Buffer): Promise<TranscriptSegment[]> {
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

  if (state.readyBatches.length === 0) return [];

  const provider = getProvider();
  const tasks = state.readyBatches.map((batch) => async (): Promise<TranscriptSegment[]> => {
    const wavBuf = Buffer.from(await batch.wav.arrayBuffer());
    const { text } = await provider.transcribeRaw(wavBuf, 'audio/wav');
    if (!text || isHallucinatedRepetition(text)) return [];
    return splitTextWithIntervals(text, batch.intervals, batch.totalWavDuration);
  });

  const results = await runWithConcurrency(tasks, BATCH_CONCURRENCY);
  return results.flat().sort((a, b) => a.start - b.start);
}
