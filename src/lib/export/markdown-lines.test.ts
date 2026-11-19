import { describe, it, expect } from 'vitest';
import { parseInline, parseLines, runsToPlainText } from './markdown-lines';

describe('parseInline', () => {
  it('returns plain text as a single unstyled run', () => {
    expect(parseInline('Vi besluttede at gå videre.')).toEqual([
      { text: 'Vi besluttede at gå videre.' },
    ]);
  });

  it('parses bold', () => {
    expect(parseInline('en **vigtig** beslutning')).toEqual([
      { text: 'en ' },
      { text: 'vigtig', bold: true },
      { text: ' beslutning' },
    ]);
  });

  it('parses italic', () => {
    expect(parseInline('en *lille* detalje')).toEqual([
      { text: 'en ' },
      { text: 'lille', italic: true },
      { text: ' detalje' },
    ]);
  });

  it('parses bold+italic via triple asterisks', () => {
    expect(parseInline('***begge dele***')).toEqual([
      { text: 'begge dele', bold: true, italic: true },
    ]);
  });

  it('parses italic nested inside bold', () => {
    expect(parseInline('**fed med *kursiv* indeni**')).toEqual([
      { text: 'fed med ', bold: true },
      { text: 'kursiv', bold: true, italic: true },
      { text: ' indeni', bold: true },
    ]);
  });

  it('parses code spans and ignores markdown inside them', () => {
    expect(parseInline('kør `npm **test**` nu')).toEqual([
      { text: 'kør ' },
      { text: 'npm **test**', code: true },
      { text: ' nu' },
    ]);
  });

  it('keeps unmatched markers as literal text', () => {
    expect(parseInline('2 * 3 er ikke kursiv')).toEqual([
      { text: '2 * 3 er ikke kursiv' },
    ]);
    expect(runsToPlainText(parseInline('en ** der aldrig lukkes'))).toBe('en ** der aldrig lukkes');
  });

  it('treats editor-escaped punctuation as literal characters', () => {
    // The rich-text editor serialises a typed "*" as "\*" — data, not a marker.
    expect(parseInline('\\*ikke kursiv\\*')).toEqual([{ text: '*ikke kursiv*' }]);
    expect(parseInline('a \\* b * c * d')).toEqual([
      { text: 'a * b ' },
      { text: ' c ', italic: true },
      { text: ' d' },
    ]);
  });

  it('a line starting with an escaped list marker stays plain text', () => {
    const [line] = parseLines('1\\. ikke en liste');
    expect(line.kind).toBe('text');
    expect(runsToPlainText(line.runs)).toBe('1. ikke en liste');
  });

  it('never swallows user characters', () => {
    const inputs = ['**a**b*c*', '***x', 'a*b**c***d', '`x` og `y`'];
    for (const input of inputs) {
      const stripped = input.replace(/\*|`/g, '');
      expect(runsToPlainText(parseInline(input)).replace(/\*|`/g, '')).toBe(stripped);
    }
  });
});

describe('parseLines', () => {
  it('classifies headings, bullets, ordered items and text', () => {
    const lines = parseLines('## Punkter\n- et punkt\n1. første\nalmindelig tekst');
    expect(lines.map((l) => l.kind)).toEqual(['heading', 'bullet', 'ordered', 'text']);
  });

  it('keeps inline styling inside every line kind', () => {
    const lines = parseLines('## **Fed** overskrift\n- et *kursivt* punkt\n1. en **fed** beslutning');
    expect(lines[0].runs).toContainEqual({ text: 'Fed', bold: true });
    expect(lines[1].runs).toContainEqual({ text: 'kursivt', italic: true });
    expect(lines[2].runs).toContainEqual({ text: 'fed', bold: true });
  });

  it('keeps the source numeral on ordered items', () => {
    const [a, b, c] = parseLines('1. et\n2. to\n3. tre');
    expect([a, b, c].map((l) => l.kind === 'ordered' && l.number)).toEqual([1, 2, 3]);
  });

  it('groups consecutive ordered items into one list', () => {
    const lines = parseLines('1. et\n2. to');
    expect(lines.map((l) => l.kind === 'ordered' && l.group)).toEqual([0, 0]);
  });

  it('starts a new group when a second list begins', () => {
    // Two lists separated only by a blank line: the restart at 1 splits them.
    const adjacent = parseLines('1. et\n2. to\n\n1. ny liste');
    expect(adjacent.map((l) => l.kind === 'ordered' && l.group)).toEqual([0, 0, 1]);

    // And a paragraph in between splits them regardless of numbering.
    const separated = parseLines('1. et\n\ntekst imellem\n\n2. fortsat');
    expect(separated.map((l) => (l.kind === 'ordered' ? l.group : l.kind))).toEqual([0, 'text', 1]);
  });

  it('a bullet between ordered items splits the list', () => {
    const lines = parseLines('1. et\n- punkt\n1. ny');
    expect(lines.map((l) => (l.kind === 'ordered' ? l.group : l.kind))).toEqual([0, 'bullet', 1]);
  });

  it('drops blank lines', () => {
    expect(parseLines('en\n\n\nto')).toHaveLength(2);
  });
});
