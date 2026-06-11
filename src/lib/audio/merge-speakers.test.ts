import { describe, it, expect } from 'vitest';
import { assignSpeakers } from './merge-speakers';
import type { TranscriptSegment } from '@/types';
import type { SpeakerTurn } from '@/lib/ai/diarization';

function seg(start: number, end: number, text = 'x'): TranscriptSegment {
  return { speaker: 'Taler 1', start, end, text };
}

describe('assignSpeakers', () => {
  it('returns segments unchanged when there are no turns', () => {
    const segments = [seg(0, 2), seg(2, 4)];
    const result = assignSpeakers(segments, []);
    expect(result).toEqual(segments);
  });

  it('labels clean alternating turns as Taler 1 / Taler 2', () => {
    const segments = [seg(0, 2), seg(2, 4), seg(4, 6)];
    const turns: SpeakerTurn[] = [
      { speaker: 'SPEAKER_00', start: 0, end: 2 },
      { speaker: 'SPEAKER_01', start: 2, end: 4 },
      { speaker: 'SPEAKER_00', start: 4, end: 6 },
    ];
    const result = assignSpeakers(segments, turns);
    expect(result.map((s) => s.speaker)).toEqual(['Taler 1', 'Taler 2', 'Taler 1']);
  });

  it('picks the turn with maximum overlap when turns overlap the segment', () => {
    // First segment establishes SPEAKER_00 as Taler 1. The second segment [4,14]
    // overlaps SPEAKER_00 for 1s and SPEAKER_01 for 9s → must resolve to Taler 2.
    const segments = [seg(0, 3), seg(4, 14)];
    const turns: SpeakerTurn[] = [
      { speaker: 'SPEAKER_00', start: 0, end: 5 },
      { speaker: 'SPEAKER_01', start: 5, end: 16 },
    ];
    const result = assignSpeakers(segments, turns);
    expect(result.map((s) => s.speaker)).toEqual(['Taler 1', 'Taler 2']);
  });

  it('remaps labels by first appearance, not by raw label order', () => {
    // SPEAKER_05 appears first → becomes Taler 1; SPEAKER_02 second → Taler 2.
    const segments = [seg(0, 2), seg(2, 4)];
    const turns: SpeakerTurn[] = [
      { speaker: 'SPEAKER_05', start: 0, end: 2 },
      { speaker: 'SPEAKER_02', start: 2, end: 4 },
    ];
    const result = assignSpeakers(segments, turns);
    expect(result.map((s) => s.speaker)).toEqual(['Taler 1', 'Taler 2']);
  });

  it('inherits the previous speaker for a segment with no overlapping turn', () => {
    const segments = [seg(0, 2), seg(5, 6) /* gap, no turn */, seg(8, 10)];
    const turns: SpeakerTurn[] = [
      { speaker: 'SPEAKER_00', start: 0, end: 2 },
      { speaker: 'SPEAKER_01', start: 8, end: 10 },
    ];
    const result = assignSpeakers(segments, turns);
    // Middle segment has no overlap → keeps the prior speaker (Taler 1).
    expect(result.map((s) => s.speaker)).toEqual(['Taler 1', 'Taler 1', 'Taler 2']);
  });

  it('leaves a leading no-overlap segment untouched when there is no prior speaker', () => {
    const segments = [seg(0, 1) /* before any turn */, seg(5, 7)];
    const turns: SpeakerTurn[] = [{ speaker: 'SPEAKER_00', start: 5, end: 7 }];
    const result = assignSpeakers(segments, turns);
    expect(result[0].speaker).toBe('Taler 1'); // unchanged default
    expect(result[1].speaker).toBe('Taler 1'); // first mapped speaker
  });

  it('keeps speaker labels stable when a speaker recurs later in the meeting', () => {
    // A → B → A → C: the returning speaker must reuse its first label, not get a new one.
    const segments = [seg(0, 2), seg(2, 4), seg(4, 6), seg(6, 8)];
    const turns: SpeakerTurn[] = [
      { speaker: 'SPEAKER_00', start: 0, end: 2 },
      { speaker: 'SPEAKER_01', start: 2, end: 4 },
      { speaker: 'SPEAKER_00', start: 4, end: 6 },
      { speaker: 'SPEAKER_02', start: 6, end: 8 },
    ];
    const result = assignSpeakers(segments, turns);
    expect(result.map((s) => s.speaker)).toEqual(['Taler 1', 'Taler 2', 'Taler 1', 'Taler 3']);
  });

  it('does not mutate the input segments', () => {
    const segments = [seg(0, 2)];
    const turns: SpeakerTurn[] = [{ speaker: 'SPEAKER_03', start: 0, end: 2 }];
    assignSpeakers(segments, turns);
    expect(segments[0].speaker).toBe('Taler 1');
  });
});
