import { describe, expect, it } from 'vitest';
import { INVISIBLE_SOURCE, LOCAL_CHANGE_NOTE_MAX, changeNoteLength, meaningfulLength, parseLocalChangeNote, stripInvisible } from './change-note';

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

describe('INVISIBLE_SOURCE', () => {
  it('covers the code points that were once missing', () => {
    for (const cp of [0x1, 0x8, 0xe, 0x1f, 0x7f, 0x84, 0x86, 0x9f, 0x600, 0x605, 0x61c, 0x6dd, 0x70f, 0x890, 0x891, 0x8e2, 0xfff0, 0xfffb, 0x110bd, 0x110cd, 0x13430, 0x1343f, 0x1bca0, 0x1bca3, 0x1d173, 0x1d17a]) {
      const ch = String.fromCodePoint(cp);
      expect(new RegExp(INVISIBLE_SOURCE, 'u').test(ch), cp.toString(16)).toBe(true);
    }
  });
});

describe('parseLocalChangeNote (the optional note of a personal template edit)', () => {
  it('is optional: absent, null, blank and invisible-only all mean no note', () => {
    for (const raw of [undefined, null, '', '   ', '\u200b \u200b', '\n\t']) {
      expect(parseLocalChangeNote(raw), String(raw)).toEqual({ ok: true, note: null });
    }
  });

  it('has no minimum length, unlike the mandatory note of a central template', () => {
    expect(parseLocalChangeNote('ok')).toEqual({ ok: true, note: 'ok' });
  });

  it('keeps interior newlines, strips invisible characters and makes the text NFC', () => {
    expect(parseLocalChangeNote('  a\u200bb\nc  ')).toEqual({ ok: true, note: 'ab\nc' });
    expect(parseLocalChangeNote('e\u0301')).toEqual({ ok: true, note: '\u00e9' });
  });

  it('rejects a non-string, an over-long note, NUL and a lone surrogate', () => {
    expect(parseLocalChangeNote(1)).toMatchObject({ ok: false });
    expect(parseLocalChangeNote({})).toMatchObject({ ok: false });
    expect(parseLocalChangeNote('x'.repeat(LOCAL_CHANGE_NOTE_MAX + 1))).toMatchObject({ ok: false });
    expect(parseLocalChangeNote('x'.repeat(LOCAL_CHANGE_NOTE_MAX))).toMatchObject({ ok: true });
    expect(parseLocalChangeNote('a\u0000b')).toMatchObject({ ok: false });
    expect(parseLocalChangeNote('a\ud800b')).toMatchObject({ ok: false });
  });

  it('gives Danish messages that do not echo the input', () => {
    const r = parseLocalChangeNote('hemmelig\u0000');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toContain('hemmelig');
  });
});
