import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeRunner } from '@/test/fake-runner';

vi.mock('@/lib/db', () => ({ pool: {} }));
const catalogue = vi.fn();
const catalogueState = vi.fn();
vi.mock('@/lib/auth/providers', () => ({
  authConfigCatalogue: () => catalogue(),
  authConfigCatalogueState: () => catalogueState(),
}));

import { __resetCatalogueSync, syncConfigCatalogue, syncConfigCatalogueOnce } from './external-roles';

beforeEach(() => {
  catalogue.mockReset().mockReturnValue([]);
  catalogueState.mockReset().mockReturnValue('absent');
  __resetCatalogueSync();
});
afterEach(() => {
  __resetCatalogueSync();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('syncConfigCatalogue', () => {
  it('upserts only config-owned rows and deactivates the config rows that left the file, in one transaction under a lock', async () => {
    const { runner, calls } = makeFakeRunner((sql) => (sql.includes('RETURNING 1') ? [{ '?column?': 1 }] : []));
    const out = await syncConfigCatalogue(
      [
        { kind: 'role', identifier: 'r1', name: 'Rolle 1' },
        { kind: 'group', identifier: 'g1', name: 'Gruppe 1' },
      ],
      runner,
      'ok',
    );
    expect(out).toEqual({ upserted: 1, deactivated: 1 });
    const sqls = calls.map((c) => c.sql.replace(/\s+/g, ' ').trim());
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[1]).toMatch(/^SELECT pg_advisory_xact_lock/);
    expect(sqls[2]).toMatch(/^INSERT INTO public\.external_roles/);
    expect(sqls[3]).toMatch(/^UPDATE public\.external_roles/);
    expect(sqls[4]).toBe('COMMIT');
    const upsert = calls[2];
    expect(upsert.sql).toContain("source = 'config'"); // config wins: it takes over a Rollekatalog row with the same key
    expect(upsert.sql).not.toContain('WHERE e.source');
    expect(upsert.sql).toContain('active = true');
    expect(upsert.params).toEqual([['role', 'group'], ['r1', 'g1'], ['Rolle 1', 'Gruppe 1']]);
    const deactivate = calls[3];
    expect(deactivate.sql).toContain("e.source = 'config' AND e.active");
    expect(deactivate.sql).toContain('SET active = false');
    expect(deactivate.sql).not.toMatch(/DELETE/i);
    expect(deactivate.params).toEqual([['role', 'group'], ['r1', 'g1']]);
  });

  it('an ABSENT catalogue section (or no file) deactivates what the file used to list', async () => {
    const { runner, calls } = makeFakeRunner();
    await syncConfigCatalogue([], runner, 'absent');
    expect(calls.some((c) => c.sql.startsWith('UPDATE public.external_roles'))).toBe(true);
  });

  it('NEVER touches the stored catalogue when the section is invalid or unreadable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { runner, calls } = makeFakeRunner();
    expect(await syncConfigCatalogue([], runner, 'invalid')).toEqual({ upserted: 0, deactivated: 0, skipped: 'invalid' });
    // Even a non-empty list is not trusted when the state says the section is unusable.
    expect(await syncConfigCatalogue([{ kind: 'role', identifier: 'r', name: 'R' }], runner, 'invalid')).toMatchObject({ skipped: 'invalid' });
    expect(calls).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).not.toMatch(/\br\b.*R/);
  });

  it('an explicitly EMPTY list does not deactivate anything either: only removing the section does', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { runner, calls } = makeFakeRunner();
    expect(await syncConfigCatalogue([], runner, 'ok')).toEqual({ upserted: 0, deactivated: 0, skipped: 'empty' });
    expect(calls).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('reads the catalogue from the auth config by default', async () => {
    catalogue.mockReturnValue([{ kind: 'role', identifier: 'x', name: 'X' }]);
    catalogueState.mockReturnValue('ok');
    const { runner, calls } = makeFakeRunner();
    // The default runner is the real pool; pass ours through the second parameter.
    await syncConfigCatalogue(undefined, runner);
    expect(calls.find((c) => c.sql.startsWith('INSERT'))!.params[1]).toEqual(['x']);
  });
});

describe('syncConfigCatalogueOnce', () => {
  it('never throws: a failure is one content-free warning per attempt, and is retried (a database blip at boot must not stick)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The default runner needs a real pool; with the pool mocked as {} the call fails, which is the point.
    expect(await syncConfigCatalogueOnce()).toBe('failed');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/config catalogue sync failed \(/);
    // The once-flag was reset, so the next call really tries again instead of reporting 'skipped'.
    expect(await syncConfigCatalogueOnce()).toBe('failed');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('schedules an unref\'d retry with a growing delay, and stops after a number of attempts', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    await syncConfigCatalogueOnce();
    const delays = () => setSpy.mock.calls.map((c) => c[1]);
    expect(delays()).toEqual([5_000]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(delays()).toEqual([5_000, 15_000]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(delays()).toEqual([5_000, 15_000, 45_000]);
    await vi.advanceTimersByTimeAsync(10 * 60_000 * 20);
    expect(delays().length).toBeLessThanOrEqual(9);
    expect(Math.max(...delays().map(Number))).toBeLessThanOrEqual(300_000);
  });

  it('stops retrying and reports done after a success; a second call is skipped', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    catalogueState.mockReturnValue('invalid'); // a successful no-op: nothing is written
    expect(await syncConfigCatalogueOnce()).toMatchObject({ skipped: 'invalid' });
    expect(await syncConfigCatalogueOnce()).toBe('skipped');
  });
});
