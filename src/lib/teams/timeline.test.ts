import { describe, it, expect } from 'vitest';
import {
  SAME_START_TOLERANCE_MS,
  artifactSpan,
  joinPieces,
  labelPart,
  leftoverCues,
  placeTranscript,
  startOf,
  takeCuesFor,
} from './timeline';
import type { VttCue } from './vtt';

const T0 = Date.parse('2026-09-08T10:00:00Z');
const cue = (start: number, end: number, text = `${start}`, speaker = 'Mette'): VttCue => ({ speaker, start, end, text });
const seg = (start: number, end: number, text = `${start}`, speaker = 'Mette') => ({ speaker, start, end, text });

describe('artifactSpan', () => {
  it('reads createdDateTime as the start and endDateTime as the end', () => {
    expect(artifactSpan({ createdDateTime: '2026-09-08T10:00:00Z', endDateTime: '2026-09-08T10:30:00Z' })).toEqual({
      start: T0,
      end: T0 + 30 * 60_000,
    });
  });

  it('drops a start that comes after the end — it cannot be a start', () => {
    expect(artifactSpan({ createdDateTime: '2026-09-08T10:40:00Z', endDateTime: '2026-09-08T10:30:00Z' }).start).toBeNull();
  });

  it("treats Graph's year-1 zero as missing", () => {
    expect(artifactSpan({ createdDateTime: '0001-01-01T00:00:00Z', endDateTime: null })).toEqual({ start: null, end: null });
  });
});

describe('startOf', () => {
  it('prefers the reported start', () => {
    expect(startOf({ start: T0, end: T0 + 1000 }, 999)).toBe(T0);
  });

  it('falls back to the end minus the content', () => {
    expect(startOf({ start: null, end: T0 + 60_000 }, 60)).toBe(T0);
  });

  it('gives up without either', () => {
    expect(startOf({ start: null, end: null }, 60)).toBeNull();
    expect(startOf({ start: null, end: T0 }, null)).toBeNull();
  });
});

describe('takeCuesFor', () => {
  it('leaves the cues alone for a transcript started with the recording', () => {
    // Graph's two timestamps differ by a second or so even then.
    const t = placeTranscript(T0 + 2000, [cue(1, 3), cue(5, 8)]);

    expect(takeCuesFor([t], { start: T0, end: T0 + 60_000 })).toEqual([cue(1, 3), cue(5, 8)]);
  });

  it("moves a later transcript's cues onto the recording's clock", () => {
    // Transcription restarted five minutes into a recording that kept running.
    const t = placeTranscript(T0 + 5 * 60_000, [cue(1, 3)]);

    expect(takeCuesFor([t], { start: T0, end: T0 + 10 * 60_000 })).toEqual([cue(301, 303, '1')]);
  });

  it('gives each cue to the recording its middle falls in, and never twice', () => {
    // One transcript running through two recordings with a pause between them.
    const t = placeTranscript(T0, [cue(10, 20, 'a'), cue(130, 140, 'b'), cue(400, 410, 'c')]);
    const first = { start: T0, end: T0 + 60_000 };
    const second = { start: T0 + 120_000, end: T0 + 240_000 };

    expect(takeCuesFor([t], first).map((c) => c.text)).toEqual(['a']);
    expect(takeCuesFor([t], second)).toEqual([cue(10, 20, 'b')]);
    expect(takeCuesFor([t], first)).toEqual([]);
    expect(leftoverCues(t).map((c) => c.text)).toEqual(['c']);
  });

  it('allows for the timestamps being a little off when the starts match', () => {
    const t = placeTranscript(T0, [cue(59, 61)]);

    expect(takeCuesFor([t], { start: T0, end: T0 + 50_000 + SAME_START_TOLERANCE_MS - 1000 })).toHaveLength(1);
  });
});

describe('joinPieces', () => {
  it('lays the pieces end to end on the first one\'s clock, in order', () => {
    const { segments, durationSeconds } = joinPieces([
      { start: T0 + 300_000, segments: [seg(0, 4, 'second')] },
      { start: T0, segments: [seg(2, 5, 'first')] },
    ]);

    expect(segments).toEqual([seg(2, 5, 'first'), seg(300, 304, 'second')]);
    expect(durationSeconds).toBe(304);
  });

  it('ignores empty pieces when deciding where the meeting starts', () => {
    const { segments } = joinPieces([
      { start: T0 - 3_600_000, segments: [] },
      { start: T0, segments: [seg(1, 2)] },
    ]);

    expect(segments).toEqual([seg(1, 2)]);
  });

  it('says so when there is nothing', () => {
    expect(joinPieces([])).toEqual({ segments: [], durationSeconds: null });
  });
});

describe('labelPart', () => {
  it('marks anonymous speakers from the second diarized recording on', () => {
    const named = new Set(['Mette']);
    const segments = [seg(0, 1, 'x', 'Taler 1'), seg(1, 2, 'y', 'Mette')];

    expect(labelPart(segments, 1, named)).toBe(segments);
    expect(labelPart(segments, 2, named).map((s) => s.speaker)).toEqual(['Taler 1 (del 2)', 'Mette']);
  });
});
