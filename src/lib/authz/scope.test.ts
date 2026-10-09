import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('@/lib/db', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

import { FAKE_PRINCIPAL_ADMIN, makePrincipal } from '@/test/helpers';
import type { Principal } from './types';
import { MAX_ORG_DEPTH, isOrgUnitWithinScope, orgSubtreeUuids, orgUnitsInScope } from './scope';

const A = 'aaaa0000-0000-4000-8000-00000000000a';
const B = 'bbbb0000-0000-4000-8000-00000000000b';
const C = 'cccc0000-0000-4000-8000-00000000000c';

function scoped(roots: Array<{ orgUnitUuid: string; includeDescendants: boolean }>, over: Partial<Principal> = {}) {
  return makePrincipal({
    capabilities: ['template.use', 'template.manage'],
    scopes: { 'template.manage': { global: false, roots } },
    ...over,
  });
}

beforeEach(() => query.mockReset());

describe('isOrgUnitWithinScope', () => {
  it('global scope short-circuits without touching the DB', async () => {
    expect(await isOrgUnitWithinScope(FAKE_PRINCIPAL_ADMIN, 'template.manage', A)).toBe(true);
    expect(query).not.toHaveBeenCalled();
  });

  it('is false without the capability, even if a scope entry exists', async () => {
    const p = scoped([{ orgUnitUuid: A, includeDescendants: true }], { capabilities: ['template.use'] });
    expect(await isOrgUnitWithinScope(p, 'template.manage', A)).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('is false for a disabled principal', async () => {
    const p = { ...FAKE_PRINCIPAL_ADMIN, disabled: true };
    expect(await isOrgUnitWithinScope(p, 'template.manage', A)).toBe(false);
  });

  it('is false for an empty scope (null-scope bygger) without a query', async () => {
    expect(await isOrgUnitWithinScope(scoped([]), 'template.manage', A)).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a malformed uuid without a query', async () => {
    const p = scoped([{ orgUnitUuid: A, includeDescendants: true }]);
    expect(await isOrgUnitWithinScope(p, 'template.manage', "x'; DROP TABLE org_units;--")).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('uses bound parameters, a schema-qualified table, UNION and a depth cap', async () => {
    query.mockResolvedValue({ rows: [{ uuid: C }, { uuid: B }, { uuid: A }] });
    const p = scoped([{ orgUnitUuid: A, includeDescendants: true }]);
    await isOrgUnitWithinScope(p, 'template.manage', C);
    const [text, params] = query.mock.calls[0];
    expect(text).toContain('public.org_units');
    expect(text).toMatch(/\bUNION\b(?!\s+ALL)/);
    expect(text).not.toMatch(/UNION\s+ALL/);
    expect(text).toContain('$1::uuid');
    expect(params).toEqual([C, MAX_ORG_DEPTH]);
    expect(text).not.toContain(C);
  });

  it('covers a descendant of a root with descendants', async () => {
    query.mockResolvedValue({ rows: [{ uuid: C }, { uuid: B }, { uuid: A }] });
    expect(await isOrgUnitWithinScope(scoped([{ orgUnitUuid: A, includeDescendants: true }]), 'template.manage', C)).toBe(true);
  });

  it('does not cover a descendant when includeDescendants is false, but covers the root itself', async () => {
    const p = scoped([{ orgUnitUuid: A, includeDescendants: false }]);
    query.mockResolvedValueOnce({ rows: [{ uuid: C }, { uuid: A }] });
    expect(await isOrgUnitWithinScope(p, 'template.manage', C)).toBe(false);
    query.mockResolvedValueOnce({ rows: [{ uuid: A }] });
    expect(await isOrgUnitWithinScope(p, 'template.manage', A)).toBe(true);
  });

  it('does not cover a sibling or a parent', async () => {
    const p = scoped([{ orgUnitUuid: B, includeDescendants: true }]);
    query.mockResolvedValueOnce({ rows: [{ uuid: C }, { uuid: A }] }); // sibling chain: C -> A
    expect(await isOrgUnitWithinScope(p, 'template.manage', C)).toBe(false);
    query.mockResolvedValueOnce({ rows: [{ uuid: A }] }); // parent
    expect(await isOrgUnitWithinScope(p, 'template.manage', A)).toBe(false);
  });

  it('an unknown unit (no rows) is never in scope, even if its id equals a root', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await isOrgUnitWithinScope(scoped([{ orgUnitUuid: A, includeDescendants: true }]), 'template.manage', A)).toBe(false);
  });

  it('compares uuids case-insensitively', async () => {
    query.mockResolvedValue({ rows: [{ uuid: A }] });
    expect(
      await isOrgUnitWithinScope(scoped([{ orgUnitUuid: A.toUpperCase(), includeDescendants: false }]), 'template.manage', A),
    ).toBe(true);
  });
});

describe('orgSubtreeUuids', () => {
  it('returns an empty set for no roots without a query', async () => {
    expect((await orgSubtreeUuids([])).size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it('skips malformed root ids', async () => {
    expect((await orgSubtreeUuids([{ orgUnitUuid: 'nope', includeDescendants: true }])).size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it('runs a recursive UNION query for descendant roots and an existence query for exact roots', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ uuid: A }, { uuid: B }] })
      .mockResolvedValueOnce({ rows: [{ uuid: C }] });
    const out = await orgSubtreeUuids([
      { orgUnitUuid: A, includeDescendants: true },
      { orgUnitUuid: C, includeDescendants: false },
    ]);
    expect([...out].sort()).toEqual([A, B, C]);
    const [text, params] = query.mock.calls[0];
    expect(text).toContain('WITH RECURSIVE');
    expect(text).not.toMatch(/UNION\s+ALL/);
    expect(params).toEqual([[A], MAX_ORG_DEPTH]);
    expect(query.mock.calls[1][1]).toEqual([[C]]);
  });
});

describe('orgUnitsInScope', () => {
  it('global => { all: true } without a query', async () => {
    expect(await orgUnitsInScope(FAKE_PRINCIPAL_ADMIN, 'audit.read')).toEqual({ all: true });
    expect(query).not.toHaveBeenCalled();
  });

  it('no scope => empty', async () => {
    expect(await orgUnitsInScope(scoped([]), 'template.manage')).toEqual({ all: false, uuids: [] });
    expect(await orgUnitsInScope(makePrincipal(), 'template.manage')).toEqual({ all: false, uuids: [] });
  });

  it('expands the roots', async () => {
    query.mockResolvedValue({ rows: [{ uuid: A }, { uuid: B }] });
    const r = await orgUnitsInScope(scoped([{ orgUnitUuid: A, includeDescendants: true }]), 'template.manage');
    expect(r).toEqual({ all: false, uuids: [A, B] });
  });
});
