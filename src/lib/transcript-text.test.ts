import { describe, it, expect } from 'vitest';
import { transcriptToText } from './transcript-text';
import type { TranscriptSegment } from '@/types';

const seg = (speaker: string, text: string): TranscriptSegment => ({ speaker, start: 0, end: 1, text });

describe('transcriptToText', () => {
  it.each<[string, TranscriptSegment[], string]>([
    ['no segments', [], ''],
    ['one segment', [seg('Anna', 'Hej.')], 'Anna: Hej.'],
    [
      'merges consecutive segments by one speaker',
      [seg('Anna', 'Hej.'), seg('Anna', 'Velkommen.')],
      'Anna: Hej. Velkommen.',
    ],
    [
      'puts a blank line between speakers',
      [seg('Anna', 'Hej.'), seg('Bo', 'Tak.'), seg('Anna', 'Godt.')],
      'Anna: Hej.\n\nBo: Tak.\n\nAnna: Godt.',
    ],
    [
      'skips segments with no text',
      [seg('Anna', ' Hej. '), seg('Bo', '  '), seg('Anna', 'Igen.')],
      'Anna: Hej. Igen.',
    ],
  ])('%s', (_name, segments, expected) => {
    expect(transcriptToText(segments)).toBe(expected);
  });
});
