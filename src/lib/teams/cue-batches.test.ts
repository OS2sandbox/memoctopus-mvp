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
      // And the slice actually handed to hviske — the cue span plus its padding —
      // still fits the model's ~30 s window. Asserting only the span let padding
      // push the real request past the cap unnoticed.
      expect(batch.end - batch.start).toBeLessThanOrEqual(MAX_BATCH_SECONDS + 2 * CUE_PAD_SECONDS);
    }
  });

  // Teams cues overlap, so two GROUPS can overlap once the cap splits a pair of
  // simultaneous speakers. Clamping each slice to the midpoint between groups
  // then cut real speech off both sides of the split.
  it('keeps a slice whole when the cap splits overlapping speakers', () => {
    const batches = planCueBatches([cue(0, 20, 'x', 'A'), cue(19, 35, 'x', 'B')], 60);

    expect(batches).toHaveLength(2);
    for (const batch of batches) {
      const last = batch.cues.reduce((max, c) => (c.end > max ? c.end : max), batch.cues[0].end);
      expect(batch.start).toBeLessThanOrEqual(batch.cues[0].start);
      expect(batch.end).toBeGreaterThanOrEqual(last);
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

  // Teams transcribes each participant's OWN stream, so two people talking at once
  // are two cues covering the same instant — the grouping must not read that as a
  // negative gap followed by a huge one.
  it('groups overlapping cues from two speakers', () => {
    const batches = planCueBatches(
      [
        cue(39.2, 40.3, 'Velkommen til syddjurs', 'Nikolaj'),
        cue(39.4, 41.2, '5 til udstyring thank you', 'Peter'),
        cue(46.2, 47.5, 'En blå baggrund det her', 'Peter'),
      ],
      90,
    );

    expect(batches).toHaveLength(1);
    expect(batches[0].cues).toHaveLength(3);
    expect(batches[0].end).toBeGreaterThanOrEqual(47.5);
  });

  // Otherwise the padded slices overlap and the same words are transcribed — and
  // then shown — twice. (Only guaranteed for groups separated by silence; when
  // the groups themselves overlap, keeping each slice whole wins — see above.)
  it('never lets two slices cover the same audio', () => {
    const batches = planCueBatches(
      [cue(10, 10.3), cue(30, 30.3), cue(45, 45.2), cue(59, 59.4)],
      70,
    );

    expect(batches).toHaveLength(4);
    for (let i = 1; i < batches.length; i++) {
      expect(batches[i].start).toBeGreaterThanOrEqual(batches[i - 1].end);
    }
    // …and every slice still holds all of its own cues' audio.
    for (const batch of batches) {
      expect(batch.start).toBeLessThanOrEqual(batch.cues[0].start);
      expect(batch.end).toBeGreaterThanOrEqual(batch.cues[batch.cues.length - 1].end);
    }
  });

  it('still pads towards whichever side has room', () => {
    // Two cues 12 s apart: each can only grow into the silence between them.
    const batches = planCueBatches([cue(10, 10.3), cue(22, 22.3)], 60);
    expect(batches[0].end - batches[0].start).toBeGreaterThan(1);
    expect(batches[1].end - batches[1].start).toBeGreaterThan(1);
    expect(batches[0].end).toBeLessThanOrEqual(batches[1].start);
  });

  it('works without a known duration', () => {
    const [batch] = planCueBatches([cue(1, 3)], null);
    expect(batch.end).toBeGreaterThan(3);
  });
});
