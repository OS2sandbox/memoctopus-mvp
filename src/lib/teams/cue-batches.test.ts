import { describe, it, expect } from 'vitest';
import {
  CUE_GAP_SECONDS,
  CUE_PAD_SECONDS,
  MAX_BATCH_SECONDS,
  MIN_BATCH_SECONDS,
  planCueBatches,
} from './cue-batches';
import type { VttCue } from './vtt';

const cue = (start: number, end: number, text = 'noget', speaker = 'Mette Hansen'): VttCue =>
  ({ start, end, text, speaker });

describe('planCueBatches', () => {
  it('has nothing to do without cues', () => {
    expect(planCueBatches([], 100)).toEqual([]);
    expect(planCueBatches([cue(0, 1, '')], 100)).toEqual([]);
  });

  it('keeps cues separated by a breath in one contiguous slice', () => {
    const batches = planCueBatches([cue(10, 12), cue(13, 15), cue(17, 19)], 60);

    expect(batches).toHaveLength(1);
    expect(batches[0].cues).toHaveLength(3);
    expect(batches[0].start).toBeCloseTo(10 - CUE_PAD_SECONDS);
    expect(batches[0].end).toBeCloseTo(19 + CUE_PAD_SECONDS);
  });

  it('starts a new slice across a long silence', () => {
    const batches = planCueBatches([cue(5, 7), cue(7 + CUE_GAP_SECONDS + 1, 40)], 120);
    expect(batches).toHaveLength(2);
  });

  // The whole reason for cutting here rather than with the VAD: the audio between
  // two cues of one slice is kept, so hviske sees real conversation and not a splice.
  it('never drops the audio between the cues of a slice', () => {
    const [batch] = planCueBatches([cue(10, 11), cue(14, 15)], 60);
    expect(batch.end - batch.start).toBeGreaterThan(5);
  });

  it('splits a slice that would run past the model window', () => {
    const cues = Array.from({ length: 20 }, (_, i) => cue(i * 3, i * 3 + 2));
    const batches = planCueBatches(cues, 120);

    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      const span = batch.cues[batch.cues.length - 1].end - batch.cues[0].start;
      expect(span).toBeLessThanOrEqual(MAX_BATCH_SECONDS);
    }
  });

  // A lone two-word cue is where the model invents subtitle credits.
  it('pads a very short slice out with surrounding audio', () => {
    const [batch] = planCueBatches([cue(30, 30.4)], 120);
    expect(batch.end - batch.start).toBeGreaterThanOrEqual(MIN_BATCH_SECONDS - 1e-9);
  });

  it('never pads past the ends of the recording', () => {
    const [first] = planCueBatches([cue(0.1, 0.3)], 60);
    expect(first.start).toBe(0);

    const [last] = planCueBatches([cue(59.5, 59.9)], 60);
    expect(last.end).toBeLessThanOrEqual(60);
    expect(last.start).toBeGreaterThanOrEqual(0);
  });

  it('drops cues Teams gave a broken timing', () => {
    const batches = planCueBatches([cue(10, 5), cue(20, 22)], 60);
    expect(batches).toHaveLength(1);
    expect(batches[0].cues[0].start).toBe(20);
  });

  it('orders cues Graph returned out of sequence', () => {
    const [batch] = planCueBatches([cue(12, 14), cue(10, 11)], 60);
    expect(batch.cues.map((c) => c.start)).toEqual([10, 12]);
  });

  it('works without a known duration', () => {
    const [batch] = planCueBatches([cue(1, 3)], null);
    expect(batch.end).toBeGreaterThan(3);
  });
});
