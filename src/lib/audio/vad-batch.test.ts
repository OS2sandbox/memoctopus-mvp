import { describe, it, expect } from 'vitest';
import {
  float32ToWavBlob,
  sealCurrentBatch,
  newVadBatchState,
  mapWavTime,
  splitTextWithIntervals,
  runWithConcurrency,
  MAX_WORDS_PER_LINE,
  BATCH_DURATION_S,
  BATCH_CONCURRENCY,
  type VadInterval,
  type VadBatchState,
} from './vad-batch';
import { DEFAULT_SPEAKER_LABEL } from './speaker-labels';

// ─── newVadBatchState ─────────────────────────────────────────────────────────

describe('newVadBatchState', () => {
  it('returns empty pending audio array', () => {
    const state = newVadBatchState();
    expect(state.pendingAudio).toEqual([]);
  });

  it('returns empty pending intervals array', () => {
    const state = newVadBatchState();
    expect(state.pendingIntervals).toEqual([]);
  });

  it('returns zero pendingWavDuration', () => {
    const state = newVadBatchState();
    expect(state.pendingWavDuration).toBe(0);
  });

  it('returns empty readyBatches array', () => {
    const state = newVadBatchState();
    expect(state.readyBatches).toEqual([]);
  });

  it('returns independent state objects on successive calls', () => {
    const a = newVadBatchState();
    const b = newVadBatchState();
    a.pendingAudio.push(new Float32Array([1, 2, 3]));
    expect(b.pendingAudio).toHaveLength(0);
  });
});

// ─── float32ToWavBlob ─────────────────────────────────────────────────────────

describe('float32ToWavBlob', () => {
  it('returns a Blob with audio/wav type', () => {
    const blob = float32ToWavBlob(new Float32Array([0, 0.5, -0.5]));
    expect(blob.type).toBe('audio/wav');
  });

  it('produces exactly 44 header bytes + 2 bytes per sample', () => {
    const samples = new Float32Array(100);
    const blob = float32ToWavBlob(samples);
    expect(blob.size).toBe(44 + 100 * 2);
  });

  it('writes RIFF chunk id at offset 0', async () => {
    const blob = float32ToWavBlob(new Float32Array(8));
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    expect(riff).toBe('RIFF');
  });

  it('writes WAVE format marker at offset 8', async () => {
    const blob = float32ToWavBlob(new Float32Array(8));
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const wave = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    expect(wave).toBe('WAVE');
  });

  it('writes fmt  sub-chunk id at offset 12', async () => {
    const blob = float32ToWavBlob(new Float32Array(8));
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const fmt = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    expect(fmt).toBe('fmt ');
  });

  it('writes data sub-chunk id at offset 36', async () => {
    const blob = float32ToWavBlob(new Float32Array(8));
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const data = String.fromCharCode(bytes[36], bytes[37], bytes[38], bytes[39]);
    expect(data).toBe('data');
  });

  it('encodes sample rate 16000 Hz at offset 24', async () => {
    const blob = float32ToWavBlob(new Float32Array(8));
    const buf = await blob.arrayBuffer();
    const v = new DataView(buf);
    expect(v.getUint32(24, true)).toBe(16_000);
  });

  it('encodes byte rate 32000 at offset 28', async () => {
    const blob = float32ToWavBlob(new Float32Array(8));
    const buf = await blob.arrayBuffer();
    const v = new DataView(buf);
    expect(v.getUint32(28, true)).toBe(32_000);
  });

  it('encodes 1 channel at offset 22', async () => {
    const blob = float32ToWavBlob(new Float32Array(8));
    const buf = await blob.arrayBuffer();
    const v = new DataView(buf);
    expect(v.getUint16(22, true)).toBe(1);
  });

  it('encodes 16-bit depth at offset 34', async () => {
    const blob = float32ToWavBlob(new Float32Array(8));
    const buf = await blob.arrayBuffer();
    const v = new DataView(buf);
    expect(v.getUint16(34, true)).toBe(16);
  });

  it('encodes PCM format (1) at offset 20', async () => {
    const blob = float32ToWavBlob(new Float32Array(8));
    const buf = await blob.arrayBuffer();
    const v = new DataView(buf);
    expect(v.getUint16(20, true)).toBe(1);
  });

  it('encodes block align of 2 at offset 32', async () => {
    const blob = float32ToWavBlob(new Float32Array(8));
    const buf = await blob.arrayBuffer();
    const v = new DataView(buf);
    expect(v.getUint16(32, true)).toBe(2);
  });

  it('writes correct RIFF chunk size (36 + dataBytes) at offset 4', async () => {
    const numSamples = 50;
    const blob = float32ToWavBlob(new Float32Array(numSamples));
    const buf = await blob.arrayBuffer();
    const v = new DataView(buf);
    expect(v.getUint32(4, true)).toBe(36 + numSamples * 2);
  });

  it('writes correct data chunk size at offset 40', async () => {
    const numSamples = 50;
    const blob = float32ToWavBlob(new Float32Array(numSamples));
    const buf = await blob.arrayBuffer();
    const v = new DataView(buf);
    expect(v.getUint32(40, true)).toBe(numSamples * 2);
  });

  it('clips and converts full positive amplitude to near max int16', async () => {
    const blob = float32ToWavBlob(new Float32Array([1.0]));
    const buf = await blob.arrayBuffer();
    const v = new DataView(buf);
    const sample = v.getInt16(44, true);
    expect(sample).toBe(0x7fff);
  });

  it('clips and converts full negative amplitude to min int16', async () => {
    const blob = float32ToWavBlob(new Float32Array([-1.0]));
    const buf = await blob.arrayBuffer();
    const v = new DataView(buf);
    const sample = v.getInt16(44, true);
    expect(sample).toBe(-0x8000);
  });

  it('converts silence (0.0) to int16 zero', async () => {
    const blob = float32ToWavBlob(new Float32Array([0.0]));
    const buf = await blob.arrayBuffer();
    const v = new DataView(buf);
    expect(v.getInt16(44, true)).toBe(0);
  });

  it('clips over-range values to ±1 before conversion', async () => {
    const blob = float32ToWavBlob(new Float32Array([2.0, -2.0]));
    const buf = await blob.arrayBuffer();
    const v = new DataView(buf);
    expect(v.getInt16(44, true)).toBe(0x7fff);
    expect(v.getInt16(46, true)).toBe(-0x8000);
  });

  it('uses startSample and endSample slice correctly', () => {
    const full = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);
    const sliced = float32ToWavBlob(full, 1, 3);
    // 2 samples → 44 + 4 bytes
    expect(sliced.size).toBe(44 + 4);
  });

  it('produces same size blob as default when startSample=0, endSample=length', () => {
    const samples = new Float32Array(10);
    const a = float32ToWavBlob(samples);
    const b = float32ToWavBlob(samples, 0, 10);
    expect(a.size).toBe(b.size);
  });

  it('handles empty sample array gracefully (44-byte header only)', () => {
    const blob = float32ToWavBlob(new Float32Array(0));
    expect(blob.size).toBe(44);
  });
});

// ─── sealCurrentBatch ─────────────────────────────────────────────────────────

describe('sealCurrentBatch', () => {
  it('does nothing when pendingAudio is empty', () => {
    const state = newVadBatchState();
    sealCurrentBatch(state);
    expect(state.readyBatches).toHaveLength(0);
  });

  it('appends a ReadyBatch to readyBatches', () => {
    const state = newVadBatchState();
    state.pendingAudio.push(new Float32Array([0.1, 0.2]));
    state.pendingIntervals.push({ originalStart: 0, originalEnd: 1, wavOffset: 0, wavDuration: 0.125 });
    state.pendingWavDuration = 0.125;
    sealCurrentBatch(state);
    expect(state.readyBatches).toHaveLength(1);
  });

  it('resets pendingAudio to empty array after sealing', () => {
    const state = newVadBatchState();
    state.pendingAudio.push(new Float32Array([0.5]));
    state.pendingWavDuration = 1;
    sealCurrentBatch(state);
    expect(state.pendingAudio).toHaveLength(0);
  });

  it('resets pendingIntervals to empty array after sealing', () => {
    const state = newVadBatchState();
    state.pendingAudio.push(new Float32Array([0.5]));
    state.pendingIntervals.push({ originalStart: 0, originalEnd: 2, wavOffset: 0, wavDuration: 1 });
    state.pendingWavDuration = 1;
    sealCurrentBatch(state);
    expect(state.pendingIntervals).toHaveLength(0);
  });

  it('resets pendingWavDuration to 0 after sealing', () => {
    const state = newVadBatchState();
    state.pendingAudio.push(new Float32Array([0.5]));
    state.pendingWavDuration = 5.5;
    sealCurrentBatch(state);
    expect(state.pendingWavDuration).toBe(0);
  });

  it('stores the correct totalWavDuration in the ReadyBatch', () => {
    const state = newVadBatchState();
    state.pendingAudio.push(new Float32Array(10));
    state.pendingWavDuration = 3.14;
    sealCurrentBatch(state);
    expect(state.readyBatches[0].totalWavDuration).toBe(3.14);
  });

  it('stores the intervals reference in the ReadyBatch', () => {
    const state = newVadBatchState();
    const iv: VadInterval = { originalStart: 10, originalEnd: 20, wavOffset: 0, wavDuration: 2 };
    state.pendingAudio.push(new Float32Array(4));
    state.pendingIntervals.push(iv);
    state.pendingWavDuration = 2;
    sealCurrentBatch(state);
    expect(state.readyBatches[0].intervals).toHaveLength(1);
    expect(state.readyBatches[0].intervals[0]).toEqual(iv);
  });

  it('produces a wav Blob in the ReadyBatch', () => {
    const state = newVadBatchState();
    state.pendingAudio.push(new Float32Array([0.1, 0.2, 0.3]));
    state.pendingWavDuration = 1;
    sealCurrentBatch(state);
    const batch = state.readyBatches[0];
    expect(batch.wav).toBeInstanceOf(Blob);
    expect(batch.wav.type).toBe('audio/wav');
  });

  it('concatenates multiple pendingAudio arrays into one wav', () => {
    const state = newVadBatchState();
    state.pendingAudio.push(new Float32Array([0.1, 0.2]));
    state.pendingAudio.push(new Float32Array([0.3, 0.4, 0.5]));
    state.pendingWavDuration = 2;
    sealCurrentBatch(state);
    // 5 samples total → 44 + 10 bytes
    expect(state.readyBatches[0].wav.size).toBe(44 + 10);
  });

  it('accumulates multiple batches on successive calls', () => {
    const state = newVadBatchState();

    state.pendingAudio.push(new Float32Array([0.1]));
    state.pendingWavDuration = 1;
    sealCurrentBatch(state);

    state.pendingAudio.push(new Float32Array([0.2]));
    state.pendingWavDuration = 2;
    sealCurrentBatch(state);

    expect(state.readyBatches).toHaveLength(2);
  });
});

// ─── mapWavTime ───────────────────────────────────────────────────────────────

describe('mapWavTime', () => {
  const singleInterval: VadInterval[] = [
    { originalStart: 10, originalEnd: 20, wavOffset: 0, wavDuration: 5 },
  ];

  it('returns 0 when intervals is empty', () => {
    expect(mapWavTime(3, [])).toBe(0);
  });

  it('maps the start of an interval to originalStart', () => {
    expect(mapWavTime(0, singleInterval)).toBe(10);
  });

  it('maps the end of an interval to originalEnd', () => {
    expect(mapWavTime(5, singleInterval)).toBe(20);
  });

  it('interpolates midpoint correctly', () => {
    // wavT=2.5 is halfway through wavDuration=5 → midpoint of [10,20] = 15
    expect(mapWavTime(2.5, singleInterval)).toBe(15);
  });

  it('returns originalStart when wavT is before first interval offset', () => {
    const iv: VadInterval[] = [{ originalStart: 5, originalEnd: 15, wavOffset: 2, wavDuration: 4 }];
    expect(mapWavTime(0, iv)).toBe(5);
  });

  it('returns last originalEnd when wavT is beyond all intervals', () => {
    expect(mapWavTime(100, singleInterval)).toBe(20);
  });

  it('skips intervals with zero wavDuration', () => {
    const intervals: VadInterval[] = [
      { originalStart: 5, originalEnd: 5, wavOffset: 0, wavDuration: 0 },
      { originalStart: 10, originalEnd: 20, wavOffset: 0, wavDuration: 5 },
    ];
    // Second interval covers wavT=2.5 → midpoint of [10,20] = 15
    expect(mapWavTime(2.5, intervals)).toBe(15);
  });

  it('maps across multiple intervals — picks the correct one', () => {
    const intervals: VadInterval[] = [
      { originalStart: 0, originalEnd: 10, wavOffset: 0, wavDuration: 5 },
      { originalStart: 15, originalEnd: 25, wavOffset: 5, wavDuration: 5 },
    ];
    // wavT=7.5 is in second interval (5..10), midpoint → 15 + 5 = 20
    expect(mapWavTime(7.5, intervals)).toBe(20);
  });

  it('handles exact boundary wavT=wavOffset+wavDuration (inclusive end)', () => {
    const iv: VadInterval[] = [{ originalStart: 100, originalEnd: 200, wavOffset: 3, wavDuration: 7 }];
    expect(mapWavTime(10, iv)).toBe(200);
  });
});

// ─── splitTextWithIntervals ───────────────────────────────────────────────────

describe('splitTextWithIntervals', () => {
  const basicInterval: VadInterval[] = [
    { originalStart: 0, originalEnd: 10, wavOffset: 0, wavDuration: 10 },
  ];

  it('returns empty array for empty text', () => {
    expect(splitTextWithIntervals('', basicInterval, 10)).toEqual([]);
  });

  it('returns empty array for whitespace-only text', () => {
    expect(splitTextWithIntervals('   ', basicInterval, 10)).toEqual([]);
  });

  it('returns empty array when intervals is empty', () => {
    expect(splitTextWithIntervals('Hello world', [], 10)).toEqual([]);
  });

  it('returns segments with DEFAULT_SPEAKER_LABEL', () => {
    const segs = splitTextWithIntervals('Hello world.', basicInterval, 10);
    expect(segs.length).toBeGreaterThan(0);
    for (const seg of segs) {
      expect(seg.speaker).toBe(DEFAULT_SPEAKER_LABEL);
    }
  });

  it('produces a single segment for a short sentence', () => {
    const segs = splitTextWithIntervals('Hello world.', basicInterval, 10);
    expect(segs).toHaveLength(1);
    expect(segs[0].text).toBe('Hello world.');
  });

  it('segment start is less than or equal to segment end', () => {
    const segs = splitTextWithIntervals('One two three four five.', basicInterval, 10);
    for (const seg of segs) {
      expect(seg.start).toBeLessThanOrEqual(seg.end);
    }
  });

  it('first segment start maps to beginning of original timeline', () => {
    const segs = splitTextWithIntervals('Word one two three four.', basicInterval, 10);
    expect(segs[0].start).toBeCloseTo(0, 5);
  });

  it('last segment end maps to end of original timeline', () => {
    const segs = splitTextWithIntervals('A B C D E F.', basicInterval, 10);
    expect(segs[segs.length - 1].end).toBeCloseTo(10, 5);
  });

  it('splits a sentence at MAX_WORDS_PER_LINE boundary', () => {
    // Build a sentence with MAX_WORDS_PER_LINE + 1 words, no punctuation except final dot
    const words = Array.from({ length: MAX_WORDS_PER_LINE + 1 }, (_, i) => `word${i}`);
    const text = words.join(' ') + '.';
    const segs = splitTextWithIntervals(text, basicInterval, 10);
    // Should be split into 2 segments
    expect(segs).toHaveLength(2);
    expect(segs[0].text.split(/\s+/).length).toBe(MAX_WORDS_PER_LINE);
    expect(segs[1].text.split(/\s+/).length).toBe(1);
  });

  it('splits multiple punctuated sentences into separate segments', () => {
    const segs = splitTextWithIntervals('First sentence. Second sentence.', basicInterval, 10);
    expect(segs).toHaveLength(2);
  });

  it('consecutive segment start equals previous segment end', () => {
    const segs = splitTextWithIntervals('First sentence. Second sentence.', basicInterval, 10);
    // elapsed is accumulated, so seg[1].start is effectively mapWavTime of elapsed after first chunk
    expect(segs[1].start).toBeCloseTo(segs[0].end, 10);
  });

  it('proportionally allocates duration based on word count', () => {
    // Two sentences with 1 and 3 words respectively (4 total)
    // Sentence 1 gets 1/4, Sentence 2 gets 3/4 of 10s
    const iv: VadInterval[] = [{ originalStart: 0, originalEnd: 10, wavOffset: 0, wavDuration: 10 }];
    const segs = splitTextWithIntervals('A. B C D.', iv, 10);
    expect(segs).toHaveLength(2);
    const dur1 = segs[0].end - segs[0].start;
    const dur2 = segs[1].end - segs[1].start;
    // Ratio should be approximately 1:3
    expect(dur2 / dur1).toBeCloseTo(3, 1);
  });

  it('handles text without punctuation as a single block', () => {
    const segs = splitTextWithIntervals('word1 word2 word3', basicInterval, 10);
    expect(segs).toHaveLength(1);
    expect(segs[0].text).toBe('word1 word2 word3');
  });

  it('handles multiple question marks and exclamations', () => {
    const segs = splitTextWithIntervals('Hello? Goodbye!', basicInterval, 5);
    expect(segs).toHaveLength(2);
  });
});

// ─── runWithConcurrency ───────────────────────────────────────────────────────

describe('runWithConcurrency', () => {
  it('returns empty array for empty task list', async () => {
    const results = await runWithConcurrency([], 4);
    expect(results).toEqual([]);
  });

  it('returns results in input order regardless of completion order', async () => {
    // Task i completes after (3-i)*10ms delay — so task 0 takes longest
    const delays = [30, 20, 10];
    const tasks = delays.map((d, i) => () => new Promise<number>(res => setTimeout(() => res(i), d)));
    const results = await runWithConcurrency(tasks, 3);
    expect(results).toEqual([0, 1, 2]);
  });

  it('resolves all tasks with limit = 1 (serial execution)', async () => {
    const order: number[] = [];
    const tasks = [0, 1, 2, 3].map(i => async () => { order.push(i); return i; });
    const results = await runWithConcurrency(tasks, 1);
    expect(results).toEqual([0, 1, 2, 3]);
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it('resolves all tasks with limit >= task count (full parallelism)', async () => {
    const tasks = [10, 20, 30].map(v => async () => v);
    const results = await runWithConcurrency(tasks, 10);
    expect(results).toEqual([10, 20, 30]);
  });

  it('does not exceed concurrency limit', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const limit = 3;
    const tasks = Array.from({ length: 9 }, (_, i) => async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise<void>(res => setTimeout(res, 5));
      concurrent--;
      return i;
    });
    await runWithConcurrency(tasks, limit);
    expect(maxConcurrent).toBeLessThanOrEqual(limit);
  });

  it('returns correct result count', async () => {
    const tasks = Array.from({ length: 7 }, (_, i) => async () => i * 2);
    const results = await runWithConcurrency(tasks, 3);
    expect(results).toHaveLength(7);
  });

  it('each result value matches its task index', async () => {
    const tasks = Array.from({ length: 5 }, (_, i) => async () => i * i);
    const results = await runWithConcurrency(tasks, 2);
    expect(results).toEqual([0, 1, 4, 9, 16]);
  });

  it('works with a single task', async () => {
    const results = await runWithConcurrency([async () => 42], 5);
    expect(results).toEqual([42]);
  });

  it('handles limit larger than task count without error', async () => {
    const tasks = [async () => 1, async () => 2];
    const results = await runWithConcurrency(tasks, 100);
    expect(results).toEqual([1, 2]);
  });
});

// ─── exported constants ───────────────────────────────────────────────────────

describe('exported constants', () => {
  it('BATCH_DURATION_S is 27', () => {
    expect(BATCH_DURATION_S).toBe(27);
  });

  it('BATCH_CONCURRENCY is 20', () => {
    expect(BATCH_CONCURRENCY).toBe(20);
  });

  it('MAX_WORDS_PER_LINE is 20', () => {
    expect(MAX_WORDS_PER_LINE).toBe(20);
  });
});
