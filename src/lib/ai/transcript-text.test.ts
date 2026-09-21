import { describe, it, expect } from 'vitest';
import {
  mergeSpeakerTurns,
  renderTurns,
  splitTurns,
  type Turn,
} from './transcript-text';
import type { TranscriptSegment } from '@/types';

const seg = (speaker: string, start: number, text: string): TranscriptSegment => ({
  speaker,
  start,
  end: start + 1,
  text,
});

describe('mergeSpeakerTurns', () => {
  it('collapses consecutive segments from the same speaker, keeping the first start', () => {
    const turns = mergeSpeakerTurns([
      seg('Taler 1', 0, 'Hej'),
      seg('Taler 1', 4, 'og velkommen'),
      seg('Taler 2', 9, 'Tak'),
      seg('Taler 1', 12, 'Nu starter vi'),
    ]);
    expect(turns).toEqual([
      { speaker: 'Taler 1', start: 0, text: 'Hej og velkommen' },
      { speaker: 'Taler 2', start: 9, text: 'Tak' },
      { speaker: 'Taler 1', start: 12, text: 'Nu starter vi' },
    ]);
  });

  it('returns an empty list for no segments', () => {
    expect(mergeSpeakerTurns([])).toEqual([]);
  });
});

describe('renderTurns', () => {
  it('renders one line per turn with speaker and m:ss timestamp', () => {
    const turns: Turn[] = [
      { speaker: 'Taler 1', start: 65, text: 'Hej' },
      { speaker: 'Taler 2', start: 70, text: 'Tak' },
    ];
    expect(renderTurns(turns)).toBe('[Taler 1] (1:05): Hej\n[Taler 2] (1:10): Tak');
  });
});

describe('splitTurns', () => {
  const turn = (i: number, text: string): Turn => ({
    speaker: `Taler ${(i % 2) + 1}`,
    start: i * 10,
    text,
  });

  it('returns a single part when everything fits', () => {
    const parts = splitTurns([turn(0, 'kort'), turn(1, 'også kort')], 1000);
    expect(parts).toEqual([renderTurns([turn(0, 'kort'), turn(1, 'også kort')])]);
  });

  it('returns no parts for no turns', () => {
    expect(splitTurns([], 1000)).toEqual([]);
  });

  it('splits at turn boundaries and keeps every part within the budget', () => {
    const turns = Array.from({ length: 10 }, (_, i) => turn(i, `ord${i} `.repeat(20).trim()));
    const budget = 300;
    const parts = splitTurns(turns, budget);

    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(budget);
    // Whole turns only: rejoining the parts reproduces the full rendering exactly.
    expect(parts.join('\n')).toBe(renderTurns(turns));
  });

  it('splits a single over-long turn at whitespace, losing no words', () => {
    const words = Array.from({ length: 200 }, (_, i) => `ord${i}`);
    const long: Turn = { speaker: 'Taler 1', start: 30, text: words.join(' ') };
    const budget = 300;
    const parts = splitTurns([long], budget);

    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(budget);
    // Each piece is its own rendered line. Strip the "[Taler 1] (0:30): " prefix from every
    // line and rejoin: the words are intact (independent of how pieces pack into parts).
    const prefix = '[Taler 1] (0:30): ';
    const rejoined = parts
      .flatMap((p) => p.split('\n'))
      .map((line) => line.slice(prefix.length))
      .join(' ');
    expect(rejoined).toBe(long.text);
  });

  it('hard-splits a turn that has no whitespace at all', () => {
    const long: Turn = { speaker: 'Taler 1', start: 0, text: 'x'.repeat(1000) };
    const budget = 300;
    const parts = splitTurns([long], budget);

    for (const p of parts) expect(p.length).toBeLessThanOrEqual(budget);
    const prefix = '[Taler 1] (0:00): ';
    const rejoined = parts
      .flatMap((p) => p.split('\n'))
      .map((line) => line.slice(prefix.length))
      .join('');
    expect(rejoined).toBe(long.text);
  });
});
