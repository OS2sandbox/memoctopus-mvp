import { describe, it, expect } from 'vitest';
import { flattenOrgTree, indentedLabel, selfAndDescendants } from './org-tree';

const u = (uuid: string, name: string, parentUuid: string | null = null) => ({ uuid, name, parentUuid });

describe('flattenOrgTree', () => {
  it('orders depth-first with siblings by name', () => {
    const rows = flattenOrgTree([
      u('c', 'Skole', 'a'),
      u('b', 'Børn', 'a'),
      u('a', 'Kommune'),
      u('d', 'Børnehave', 'b'),
    ]);
    expect(rows.map((r) => [r.unit.uuid, r.depth])).toEqual([
      ['a', 0],
      ['b', 1],
      ['d', 2],
      ['c', 1],
    ]);
  });

  it('treats a unit with a missing parent as a root', () => {
    const rows = flattenOrgTree([u('x', 'Skjult forælder', 'ghost'), u('y', 'Barn', 'x')]);
    expect(rows.map((r) => [r.unit.uuid, r.depth])).toEqual([
      ['x', 0],
      ['y', 1],
    ]);
  });

  it('terminates on a cycle and still lists every unit once', () => {
    const rows = flattenOrgTree([u('a', 'A', 'b'), u('b', 'B', 'a'), u('r', 'Rod')]);
    expect(rows.map((r) => r.unit.uuid).sort()).toEqual(['a', 'b', 'r']);
  });

  it('terminates on a self-parent', () => {
    const rows = flattenOrgTree([u('a', 'A', 'a')]);
    expect(rows).toEqual([{ unit: u('a', 'A', 'a'), depth: 0 }]);
  });

  it('handles an empty list', () => {
    expect(flattenOrgTree([])).toEqual([]);
  });

  it('caps the depth of a very deep chain', () => {
    const units = Array.from({ length: 200 }, (_, i) => u(`n${i}`, `N${i}`, i === 0 ? null : `n${i - 1}`));
    const rows = flattenOrgTree(units);
    expect(rows).toHaveLength(200);
    expect(Math.max(...rows.map((r) => r.depth))).toBeLessThanOrEqual(64);
  });
});

describe('selfAndDescendants', () => {
  it('returns the unit and all descendants', () => {
    const units = [u('a', 'A'), u('b', 'B', 'a'), u('c', 'C', 'b'), u('d', 'D')];
    expect([...selfAndDescendants(units, 'a')].sort()).toEqual(['a', 'b', 'c']);
  });

  it('terminates on a cycle', () => {
    const units = [u('a', 'A', 'b'), u('b', 'B', 'a')];
    expect([...selfAndDescendants(units, 'a')].sort()).toEqual(['a', 'b']);
  });
});

describe('indentedLabel', () => {
  it('leaves roots as they are and indents children', () => {
    expect(indentedLabel('Rod', 0)).toBe('Rod');
    expect(indentedLabel('Barn', 2)).toBe('\u2003\u2003└ Barn');
  });
});
