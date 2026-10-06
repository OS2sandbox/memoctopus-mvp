import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MEANINGLESS_CHARS_CLASS } from '@/lib/db/schema';
import { INVISIBLE_SOURCE, changeNoteLength, meaningfulLength, stripInvisible } from './change-note';

describe('changeNoteLength (shared by the server schema and the UI counter)', () => {
  it('does not count interior whitespace', () => {
    expect(changeNoteLength(`a${' '.repeat(9)}b`)).toBe(2);
    expect(changeNoteLength(`a${' '.repeat(9)}b`)).toBeLessThan(10);
  });
  it('does not count invisible characters', () => {
    expect(changeNoteLength('​'.repeat(10))).toBe(0);
    expect(changeNoteLength('\u0001'.repeat(10))).toBe(0);
    expect(changeNoteLength('abcde­͏ㅤfghij')).toBe(10);
  });
  it('counts code points, not UTF-16 units', () => {
    expect(changeNoteLength('😀😀😀😀😀')).toBe(5);
    expect(meaningfulLength('😀 😀')).toBe(2);
  });
  it('keeps newlines and tabs in the text but not in the count', () => {
    expect(stripInvisible('  a\nb\tc  ')).toBe('a\nb\tc');
    expect(changeNoteLength('a\nb\tc')).toBe(3);
  });
});

// The table CHECKs use MEANINGLESS_CHARS_CLASS. It must ignore exactly what the app ignores
// (the INVISIBLE regex plus White_Space); otherwise a value the app rejects, or one it strips to
// nothing, could be written with SQL, or a value the app accepts be refused by the database.
// The expected class is derived here from the TS regex, so the two cannot drift silently.
function expectedClass(): string {
  const invisible = new RegExp(INVISIBLE_SOURCE, 'u');
  const white = /\p{White_Space}/u;
  const meaningless = (cp: number) => {
    const ch = String.fromCodePoint(cp);
    return invisible.test(ch) || white.test(ch) || ch === '\n' || ch === '\r' || ch === '\t';
  };
  const esc = (c: number) =>
    c > 0xffff ? `\\U${c.toString(16).toUpperCase().padStart(8, '0')}` : `\\u${c.toString(16).toUpperCase().padStart(4, '0')}`;
  const ranges: Array<[number, number]> = [];
  let start = -1;
  for (let cp = 1; cp <= 0x110000; cp++) {
    const m = cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) && meaningless(cp);
    if (m && start < 0) start = cp;
    if (!m && start >= 0) {
      ranges.push([start, cp - 1]);
      start = -1;
    }
  }
  const body = ranges
    .map(([a, b]) => (a === b ? esc(a) : b === a + 1 ? esc(a) + esc(b) : `${esc(a)}-${esc(b)}`))
    .join('');
  return `'[${body}]'`;
}

describe('MEANINGLESS_CHARS_CLASS', () => {
  it('equals the class derived from the app regex (regenerate it if this fails)', () => {
    expect(MEANINGLESS_CHARS_CLASS).toBe(expectedClass());
  });

  it('covers the code points that were once missing', () => {
    for (const cp of [0x1, 0x8, 0xe, 0x1f, 0x7f, 0x84, 0x86, 0x9f, 0x600, 0x605, 0x61c, 0x6dd, 0x70f, 0x890, 0x891, 0x8e2, 0xfff0, 0xfffb, 0x110bd, 0x110cd, 0x13430, 0x1343f, 0x1bca0, 0x1bca3, 0x1d173, 0x1d17a]) {
      const ch = String.fromCodePoint(cp);
      expect(new RegExp(INVISIBLE_SOURCE, 'u').test(ch), cp.toString(16)).toBe(true);
    }
  });

  it('is the literal written in migration 0003 and in its snapshot', () => {
    const literal = MEANINGLESS_CHARS_CLASS.slice(1, -1);
    const sql = readFileSync('drizzle/0003_central_templates.sql', 'utf8');
    expect(sql.split(literal).length - 1).toBe(2);
    const snapshot = readFileSync('drizzle/meta/0003_snapshot.json', 'utf8');
    expect(snapshot.split(literal.replace(/\\/g, '\\\\')).length - 1).toBe(2);
  });
});
