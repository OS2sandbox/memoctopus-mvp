import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeRunner } from '@/test/fake-runner';

vi.mock('@/lib/db', () => ({ pool: {} }));
const catalogue = vi.fn();
vi.mock('@/lib/auth/providers', () => ({ authConfigCatalogue: () => catalogue() }));

import { __resetCatalogueSync, syncConfigCatalogue, syncConfigCatalogueOnce } from './external-roles';

beforeEach(() => {
  catalogue.mockReset().mockReturnValue([]);
  __resetCatalogueSync();
});
afterEach(() => vi.restoreAllMocks());

describe('syncConfigCatalogue', () => {
  it('upserts only config-owned rows and deactivates the config rows that left the file, in one transaction under a lock', async () => {
    const { runner, calls } = makeFakeRunner((sql) => (sql.includes('RETURNING 1') ? [{ '?column?': 1 }] : []));
    const out = await syncConfigCatalogue(
      [
        { kind: 'role', identifier: 'r1', name: 'Rolle 1' },
        { kind: 'group', identifier: 'g1', name: 'Gruppe 1' },
      ],
      runner,
    );
    expect(out).toEqual({ upserted: 1, deactivated: 1 });
    const sqls = calls.map((c) => c.sql.replace(/\s+/g, ' ').trim());
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[1]).toMatch(/^SELECT pg_advisory_xact_lock/);
    expect(sqls[2]).toMatch(/^INSERT INTO public\.external_roles/);
    expect(sqls[3]).toMatch(/^UPDATE public\.external_roles/);
    expect(sqls[4]).toBe('COMMIT');
    const upsert = calls[2];
    expect(upsert.sql).toContain("e.source = 'config'"); // never overwrites a Rollekatalog row
    expect(upsert.sql).toContain('active = true');
    expect(upsert.params).toEqual([['role', 'group'], ['r1', 'g1'], ['Rolle 1', 'Gruppe 1']]);
    const deactivate = calls[3];
    expect(deactivate.sql).toContain("e.source = 'config' AND e.active");
    expect(deactivate.sql).toContain('SET active = false');
    expect(deactivate.sql).not.toMatch(/DELETE/i);
    expect(deactivate.params).toEqual([['role', 'group'], ['r1', 'g1']]);
  });

  it('an empty catalogue still runs (it deactivates what the file used to list)', async () => {
    const { runner, calls } = makeFakeRunner();
    await syncConfigCatalogue([], runner);
    expect(calls.some((c) => c.sql.startsWith('UPDATE public.external_roles'))).toBe(true);
  });

  it('reads the catalogue from the auth config by default', async () => {
    catalogue.mockReturnValue([{ kind: 'role', identifier: 'x', name: 'X' }]);
    const { runner, calls } = makeFakeRunner();
    // The default runner is the real pool; pass ours through the second parameter.
    await syncConfigCatalogue(undefined, runner);
    expect(calls.find((c) => c.sql.startsWith('INSERT'))!.params[1]).toEqual(['x']);
  });
});

describe('syncConfigCatalogueOnce', () => {
  it('never throws: a failure is one content-free warning, and it runs once per process', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The default runner needs a real pool; with the pool mocked as {} the call fails, which is the point.
    expect(await syncConfigCatalogueOnce()).toBe('failed');
    expect(await syncConfigCatalogueOnce()).toBe('skipped');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/config catalogue sync failed \(/);
  });
});
