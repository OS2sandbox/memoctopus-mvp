import { describe, it, expect } from 'vitest';
import { diffLines, hasChanges, splitLines, MAX_DIFF_CELLS } from './diff';

const compact = (r: ReturnType<typeof diffLines>) =>
  r.lines.map((l) => (l.type === 'equal' ? ' ' : l.type === 'insert' ? '+' : '-') + l.text);

describe('splitLines', () => {
  it('returns no lines for an empty string and normalises CRLF', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a\r\nb\rc')).toEqual(['a', 'b', 'c']);
  });
});

describe('diffLines', () => {
  it('reports identical text as all equal', () => {
    const r = diffLines('a\nb\nc', 'a\nb\nc');
    expect(compact(r)).toEqual([' a', ' b', ' c']);
    expect(hasChanges(r)).toBe(false);
    expect(r.approximate).toBe(false);
  });

  it('handles an insertion', () => {
    expect(compact(diffLines('a\nc', 'a\nb\nc'))).toEqual([' a', '+b', ' c']);
  });

  it('handles a deletion', () => {
    expect(compact(diffLines('a\nb\nc', 'a\nc'))).toEqual([' a', '-b', ' c']);
  });

  it('handles a replacement as delete then insert', () => {
    const r = diffLines('a\nb\nc', 'a\nX\nc');
    expect(compact(r)).toEqual([' a', '-b', '+X', ' c']);
    expect(hasChanges(r)).toBe(true);
  });

  it('treats empty before as all inserts and empty after as all deletes', () => {
    expect(compact(diffLines('', 'a\nb'))).toEqual(['+a', '+b']);
    expect(compact(diffLines('a\nb', ''))).toEqual(['-a', '-b']);
    expect(diffLines('', '').lines).toEqual([]);
  });

  it('finds the longest common subsequence across interleaved changes', () => {
    const r = diffLines('1\n2\n3\n4\n5', '2\n3\nX\n5\n6');
    expect(compact(r)).toEqual(['-1', ' 2', ' 3', '-4', '+X', ' 5', '+6']);
  });

  it('reconstructs both sides exactly', () => {
    const before = 'x\ny\nz\nx\ny';
    const after = 'y\nx\nz\nz\ny';
    const r = diffLines(before, after);
    expect(
      r.lines
        .filter((l) => l.type !== 'insert')
        .map((l) => l.text)
        .join('\n'),
    ).toBe(before);
    expect(
      r.lines
        .filter((l) => l.type !== 'delete')
        .map((l) => l.text)
        .join('\n'),
    ).toBe(after);
  });

  it('distinguishes a blank line from no line', () => {
    expect(compact(diffLines('a\n\nb', 'a\nb'))).toEqual([' a', '-', ' b']);
  });

  it('falls back to a wholesale replacement of the middle when the input is too large', () => {
    const before = ['head', ...Array.from({ length: 1500 }, (_, i) => `a${i}`), 'tail'].join('\n');
    const after = ['head', ...Array.from({ length: 1500 }, (_, i) => `b${i}`), 'tail'].join('\n');
    const r = diffLines(before, after);
    expect(r.approximate).toBe(true);
    expect(r.lines[0]).toEqual({ type: 'equal', text: 'head' });
    expect(r.lines.at(-1)).toEqual({ type: 'equal', text: 'tail' });
    expect(r.lines.filter((l) => l.type === 'delete')).toHaveLength(1500);
    expect(r.lines.filter((l) => l.type === 'insert')).toHaveLength(1500);
  });

  it('stays exact (and quick) for large inputs that mostly share head and tail', () => {
    const lines = Array.from({ length: 20000 }, (_, i) => `line ${i}`);
    const changed = [...lines];
    changed[10000] = 'edited';
    const r = diffLines(lines.join('\n'), changed.join('\n'));
    expect(r.approximate).toBe(false);
    expect(r.lines.filter((l) => l.type !== 'equal')).toHaveLength(2);
  });

  it('honours a custom cell limit', () => {
    expect(diffLines('a\nb\nc', 'x\ny\nz', 4).approximate).toBe(true);
    expect(diffLines('a\nb\nc', 'x\ny\nz', MAX_DIFF_CELLS).approximate).toBe(false);
  });
});
