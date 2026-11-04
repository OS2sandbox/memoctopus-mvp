import { describe, it, expect } from 'vitest';
import { fillSpeakerNames } from './name-speakers';
import type { TranscriptSegment } from '@/types';

const seg = (speaker: string, start: number, text = 'noget'): TranscriptSegment =>
  ({ speaker, start, end: start + 1, text });

describe('fillSpeakerNames', () => {
  // The reported bug: a Teams meeting with two named participants opened with
  // "Taler 1" on its first lines and counted it as an unrecognised voice.
  it('names a leading gap after the first speaker that follows it', () => {
    const filled = fillSpeakerNames([
      seg('Taler 1', 17, 'Right.'),
      seg('Taler 1', 18, 'Hallo.'),
      seg('Nikolaj Bach Meineche', 19, 'Hej.'),
    ]);
    expect(filled.map((s) => s.speaker)).toEqual([
      'Nikolaj Bach Meineche',
      'Nikolaj Bach Meineche',
      'Nikolaj Bach Meineche',
    ]);
  });

  it('names a gap in the middle after whoever was last speaking', () => {
    const filled = fillSpeakerNames([
      seg('Simon N', 0),
      seg('Taler 1', 1),
      seg('Nikolaj Bach Meineche', 2),
    ]);
    expect(filled.map((s) => s.speaker)).toEqual(['Simon N', 'Simon N', 'Nikolaj Bach Meineche']);
  });

  it('names a trailing gap after the last known speaker', () => {
    const filled = fillSpeakerNames([seg('Simon N', 0), seg('Taler 2', 1), seg('Taler 2', 2)]);
    expect(filled.map((s) => s.speaker)).toEqual(['Simon N', 'Simon N', 'Simon N']);
  });

  it('leaves a named transcript exactly as it was', () => {
    const segments = [seg('Simon N', 0), seg('Nikolaj Bach Meineche', 1)];
    expect(fillSpeakerNames(segments)).toEqual(segments);
  });

  // Mode 3 — a recording with no Teams transcript. The voices really are
  // unknown, and inventing a name for them would be worse than the placeholder.
  it('leaves placeholders alone when nothing is named', () => {
    const segments = [seg('Taler 1', 0), seg('Taler 2', 1)];
    expect(fillSpeakerNames(segments)).toEqual(segments);
  });

  it('treats an empty speaker as a gap too', () => {
    const filled = fillSpeakerNames([seg('', 0), seg('Simon N', 1)]);
    expect(filled.map((s) => s.speaker)).toEqual(['Simon N', 'Simon N']);
  });

  it('does not mutate its input', () => {
    const segments = [seg('Taler 1', 0), seg('Simon N', 1)];
    fillSpeakerNames(segments);
    expect(segments[0].speaker).toBe('Taler 1');
  });

  it('handles an empty transcript', () => {
    expect(fillSpeakerNames([])).toEqual([]);
  });
});
