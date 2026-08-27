import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockTranscribeRaw = vi.hoisted(() => vi.fn());

vi.mock('@/lib/ai/transcription', () => ({
  HviskeProvider: class {
    transcribeRaw = mockTranscribeRaw;
  },
}));

vi.mock('@/lib/audio/decode-server', () => ({
  decodeToMono16k: vi.fn(),
}));

import { transcribeVadBatches, type BatchEvent } from './vad-batch-server';
import type { ReadyBatch } from './vad-batch';

function makeBatch(startSecond: number, durationS = 27): ReadyBatch {
  return {
    wav: new Blob([new Uint8Array(100)], { type: 'audio/wav' }),
    intervals: [{
      originalStart: startSecond,
      originalEnd: startSecond + durationS,
      wavOffset: 0,
      wavDuration: durationS,
    }],
    totalWavDuration: durationS,
  };
}

beforeEach(() => {
  mockTranscribeRaw.mockReset();
  delete process.env.HVISKE_BATCH_CONCURRENCY;
});

describe('transcribeVadBatches', () => {
  it('returns empty result for zero batches', async () => {
    const result = await transcribeVadBatches([]);
    expect(result).toEqual({ segments: [], totalBatches: 0, totalSpeechSeconds: 0, failedSeconds: 0 });
  });

  it('dispatches ALL batches simultaneously by default', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    mockTranscribeRaw.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { text: 'hej med dig', latencyMs: 5 };
    });

    const batches = Array.from({ length: 30 }, (_, i) => makeBatch(i * 27));
    await transcribeVadBatches(batches);
    expect(maxInFlight).toBe(30);
  });

  it('respects HVISKE_BATCH_CONCURRENCY as backpressure', async () => {
    process.env.HVISKE_BATCH_CONCURRENCY = '4';
    let inFlight = 0;
    let maxInFlight = 0;
    mockTranscribeRaw.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return { text: 'hej', latencyMs: 2 };
    });

    await transcribeVadBatches(Array.from({ length: 12 }, (_, i) => makeBatch(i * 27)));
    expect(maxInFlight).toBeLessThanOrEqual(4);
  });

  it('sorts segments across out-of-order batch completions', async () => {
    const texts = ['første batch.', 'anden batch.'];
    let call = 0;
    mockTranscribeRaw.mockImplementation(async () => {
      const i = call++;
      // First batch resolves LAST.
      await new Promise((r) => setTimeout(r, i === 0 ? 10 : 1));
      return { text: texts[i], latencyMs: 1 };
    });

    const { segments } = await transcribeVadBatches([makeBatch(0), makeBatch(27)]);
    expect(segments.map((s) => s.text)).toEqual(['første batch.', 'anden batch.']);
    expect(segments[0].start).toBeLessThan(segments[1].start);
  });

  it('retries failed batches once after the first wave instead of dropping them', async () => {
    let attempts = 0;
    mockTranscribeRaw.mockImplementation(async () => {
      if (attempts++ === 0) throw new Error('timeout');
      return { text: 'reddet batch', latencyMs: 1 };
    });

    const { segments, failedSeconds } = await transcribeVadBatches([makeBatch(0)]);
    expect(attempts).toBe(2);
    expect(failedSeconds).toBe(0);
    expect(segments.map((s) => s.text).join(' ')).toBe('reddet batch');
  });

  it('reports permanently failed seconds rather than silently dropping audio', async () => {
    mockTranscribeRaw.mockRejectedValue(new Error('server down'));

    const { segments, failedSeconds } = await transcribeVadBatches([makeBatch(0)]);
    expect(segments).toEqual([]);
    expect(failedSeconds).toBe(27);
  });

  it('emits one progress event per batch with running counts', async () => {
    mockTranscribeRaw.mockResolvedValue({ text: 'hej', latencyMs: 1 });
    const events: BatchEvent[] = [];

    await transcribeVadBatches([makeBatch(0), makeBatch(27), makeBatch(54)], (e) => events.push(e));

    expect(events).toHaveLength(3);
    expect(events.map((e) => e.completedBatches).sort()).toEqual([1, 2, 3]);
    expect(events.every((e) => e.totalBatches === 3)).toBe(true);
  });

  it('filters hallucinated repetitions to empty segments', async () => {
    mockTranscribeRaw.mockResolvedValue({ text: 'ja ja ja ja ja ja', latencyMs: 1 });
    const { segments } = await transcribeVadBatches([makeBatch(0)]);
    expect(segments).toEqual([]);
  });
});
