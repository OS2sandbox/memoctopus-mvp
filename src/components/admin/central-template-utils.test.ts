import { describe, it, expect } from 'vitest';
import { changeNoteSchema } from '@/lib/skabeloner/central-schemas';
import {
  audienceEntries,
  changedContentFields,
  diffPrincipals,
  diffTargets,
  noteLength,
  noteProblem,
  principalKey,
  principalsEqual,
  targetsWithinOwner,
  truncateAudience,
  viewAgainstCatalogue,
} from './central-template-utils';

describe('noteProblem', () => {
  it('trims and counts code points like the server', () => {
    expect(noteProblem('   kort   ')).toBe('Beskriv ændringen (mindst 10 tegn)');
    expect(noteProblem('123456789')).not.toBeNull();
    expect(noteProblem('1234567890')).toBeNull();
    expect(noteLength('😀😀😀😀😀')).toBe(5);
    expect(noteProblem('😀😀😀😀😀')).not.toBeNull();
    expect(noteProblem('x'.repeat(2001))).toMatch(/for lang/);
  });
});

describe('noteLength matches the server counter', () => {
  it('does not count interior whitespace or invisible characters', () => {
    expect(noteLength(`a${' '.repeat(9)}b`)).toBe(2);
    expect(noteProblem(`a${' '.repeat(9)}b`)).not.toBeNull();
    expect(noteLength('\u200B'.repeat(10))).toBe(0);
    expect(noteProblem('\u200B'.repeat(10))).not.toBeNull();
    expect(noteProblem('abcde\u200Bfghij')).toBeNull();
  });
  it('gives the same number as the schema for any input', () => {
    for (const raw of ['  hej  verden og mere  ', '😀'.repeat(7), 'a\u00A0b\u3164c', 'x\n\ny\tz']) {
      const parsed = changeNoteSchema.safeParse(raw);
      expect(noteProblem(raw) === null).toBe(parsed.success);
    }
  });
});

describe('diff helpers', () => {
  it('lists changed content fields by name', () => {
    const a = {
      name: 'a',
      description: '',
      prompt: 'p',
      includeDeltagere: false,
      includeBeslutningspunkter: false,
      includeDagsorden: false,
      includeDato: false,
      allowUserInstruction: false,
      allowToggleOverrides: false,
    };
    expect(changedContentFields(a, { ...a, prompt: 'q', includeDato: true })).toEqual(['prompt', 'includeDato']);
  });

  it('classifies added, removed and changed targets', () => {
    const d = diffTargets(
      [
        { orgUnitUuid: 'a', includeDescendants: true },
        { orgUnitUuid: 'b', includeDescendants: true },
      ],
      [
        { orgUnitUuid: 'b', includeDescendants: false },
        { orgUnitUuid: 'c', includeDescendants: true },
      ],
    );
    expect(d.added.map((t) => t.orgUnitUuid)).toEqual(['c']);
    expect(d.removed.map((t) => t.orgUnitUuid)).toEqual(['a']);
    expect(d.changed.map((t) => t.orgUnitUuid)).toEqual(['b']);
  });

  it('drops targets outside the owner subtree, and all when there is no owner', () => {
    const units = [
      { uuid: 'r', name: 'R', parentUuid: null },
      { uuid: 'c', name: 'C', parentUuid: 'r' },
      { uuid: 'x', name: 'X', parentUuid: null },
    ];
    const t = [
      { orgUnitUuid: 'c', includeDescendants: true },
      { orgUnitUuid: 'x', includeDescendants: true },
    ];
    expect(targetsWithinOwner(units, 'r', t)).toEqual([t[0]]);
    expect(targetsWithinOwner(units, '', t)).toEqual([]);
  });
});

describe('role/group targets', () => {
  type Kind = 'role' | 'group';
  const role = (identifier: string, name = identifier, status: 'active' | 'inactive' | 'unknown' = 'active') => ({ kind: 'role' as Kind, identifier, name, status });
  const group = (identifier: string) => ({ kind: 'group' as Kind, identifier, name: identifier, status: 'active' as const });

  it('a role and a group with the same identifier are different targets', () => {
    expect(principalKey(role('x'))).not.toBe(principalKey(group('x')));
    expect(diffPrincipals([role('x')], [group('x')])).toEqual({ added: [group('x')], removed: [role('x')] });
  });

  it('diffs added and removed, and ignores order and name/status', () => {
    expect(principalsEqual([role('a'), group('b')], [group('b'), role('a', 'Andet navn', 'inactive')])).toBe(true);
    expect(diffPrincipals([role('a')], [role('a'), role('b')])).toEqual({ added: [role('b')], removed: [] });
  });

  it('re-reads a target against the catalogue: its name wins; withdrawn is inactive; missing is unknown', () => {
    const cat = new Map([
      [principalKey(role('a')), { kind: 'role' as const, identifier: 'a', name: 'Nyt navn', source: 'config' as const, active: true }],
      [principalKey(role('b')), { kind: 'role' as const, identifier: 'b', name: 'B', source: 'rollekatalog' as const, active: false }],
    ]);
    expect(viewAgainstCatalogue(role('a', 'Gammelt navn'), cat)).toEqual(role('a', 'Nyt navn'));
    expect(viewAgainstCatalogue(role('b'), cat).status).toBe('inactive');
    expect(viewAgainstCatalogue(role('c', 'Borte'), cat)).toEqual(role('c', 'Borte', 'unknown'));
    // Without a name the identifier is shown.
    expect(viewAgainstCatalogue({ kind: 'group', identifier: 'zz' }, cat).name).toBe('zz');
  });

  it('names the whole audience: roles and groups first, then units; flags withdrawn ones', () => {
    const entries = audienceEntries(
      { principalTargets: [role('a', 'Sagsbehandler'), role('b', 'Gammel', 'inactive'), group('g')], targets: [{ orgUnitUuid: 'u1', includeDescendants: true }, { orgUnitUuid: 'u2', includeDescendants: false }] },
      (u) => (u === 'u1' ? 'Børn' : 'Ukendt enhed'),
    );
    expect(entries.map((e) => e.label)).toEqual([
      'Rolle: Sagsbehandler',
      'Rolle: Gammel',
      'Gruppe: g',
      'Enhed: Børn (inkl. underenheder)',
      'Enhed: Ukendt enhed',
    ]);
    expect(entries.map((e) => e.flagged)).toEqual([false, true, false, false, false]);
  });

  it('truncates to N with the rest counted, and shows flagged entries first so they are never hidden', () => {
    const entries = audienceEntries(
      { principalTargets: [role('a'), role('b'), role('c'), role('d'), role('e', 'E', 'unknown')], targets: [] },
      () => '',
    );
    const t = truncateAudience(entries, 3);
    expect(t.shown.map((e) => e.label)).toEqual(['Rolle: E', 'Rolle: a', 'Rolle: b']);
    expect(t.more).toHaveLength(2);
    expect(truncateAudience(entries, 10).more).toEqual([]);
    expect(truncateAudience([], 3)).toEqual({ shown: [], more: [] });
  });
});
