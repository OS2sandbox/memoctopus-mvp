import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  centralRequest,
  changedContentFields,
  diffTargets,
  noteLength,
  noteProblem,
  targetsWithinOwner,
} from './central-template-utils';

afterEach(() => vi.unstubAllGlobals());

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

describe('centralRequest', () => {
  it('keeps code and currentVersion of a 409 body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'x', code: 'version_conflict', currentVersion: 4 }), { status: 409 }),
        ),
      ),
    );
    expect(await centralRequest('/x')).toEqual({
      ok: false,
      status: 409,
      message: 'x',
      code: 'version_conflict',
      currentVersion: 4,
    });
  });

  it('turns a network failure into a Danish message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('down'))),
    );
    expect(await centralRequest('/x')).toMatchObject({ ok: false, status: 0, message: 'Netværksfejl. Prøv igen.' });
  });
});
