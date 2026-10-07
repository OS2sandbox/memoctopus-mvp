// The role catalogue refresh against a scripted connection and a faked client: what runs in
// which order, what is never written, and that only short codes come out. The behaviour that
// needs a database (upsert, deactivation, RESTRICT, a real lock) is in catalogue-sync.pg.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientLike, SqlResult } from '@/lib/authz/pg-runner';

vi.mock('@/lib/db', () => ({ pool: {}, db: {} }));

import { runCatalogueRefresh, emptyCatalogueCounts } from './catalogue-sync';
import { RollekatalogError } from './errors';
import type { RkRoleCatalogue } from './client';
import type { SyncEnv } from './sync-run';

type Reply = SqlResult<Record<string, unknown>> | Error | undefined;

function fakeEnv(script: (sql: string, params: readonly unknown[] | undefined) => Reply) {
  const log: Array<{ conn: number; sql: string; params: readonly unknown[] | undefined }> = [];
  const released: Array<{ conn: number; destroy: boolean }> = [];
  let n = 0;
  const env: SyncEnv = {
    schema: 'public',
    connect: async (): Promise<ClientLike> => {
      const conn = ++n;
      return {
        query: async (sql, params) => {
          const flat = sql.replace(/\s+/g, ' ').trim();
          log.push({ conn, sql: flat, params });
          const reply = script(flat, params);
          if (reply instanceof Error) throw reply;
          return (reply ?? { rows: [], rowCount: 0 }) as unknown as SqlResult<never>;
        },
        release: (destroy) => void released.push({ conn, destroy: destroy === true }),
      };
    },
  };
  return { env, log, released, sqls: () => log.map((l) => l.sql) };
}

const rows = (r: Array<Record<string, unknown>>): Reply => ({ rows: r, rowCount: r.length });

/** An answer for everything the run needs: lock, the base count, nothing leaving, N upserts. */
function script(over: (sql: string) => Reply = () => undefined) {
  return (sql: string): Reply => {
    const o = over(sql);
    if (o !== undefined) return o;
    if (sql.includes('pg_try_advisory_lock')) return rows([{ ok: true }]);
    if (sql.includes('pg_advisory_unlock')) return rows([{ ok: true }]);
    if (sql.includes('SELECT count(*)::int AS n')) return rows([{ n: 4 }]);
    if (sql.includes('RETURNING (xmax = 0) AS inserted')) return rows([{ inserted: true }, { inserted: false }, { inserted: false }]);
    return undefined;
  };
}

const catalogue = (roles: string[], groups: string[] = [], skipped = 0): RkRoleCatalogue => ({
  roles: { entries: roles.map((i) => ({ kind: 'role' as const, identifier: i, name: `Navn ${i}` })), skipped },
  groups: { entries: groups.map((i) => ({ kind: 'group' as const, identifier: i, name: `Gruppe ${i}` })), skipped: 0 },
});
const clientOf = (c: RkRoleCatalogue | Error) => ({
  getRoleCatalogue: vi.fn(async () => {
    if (c instanceof Error) throw c;
    return c;
  }),
});

beforeEach(() => {
  vi.stubEnv('ROLLEKATALOG_URL', 'https://rk.example.dk');
  vi.stubEnv('ROLLEKATALOG_READ_API_KEY', 'read-key-value');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('runCatalogueRefresh', () => {
  it('locks, fetches, writes in one transaction, unlocks, and reports counts', async () => {
    const f = fakeEnv(script());
    const client = clientOf(catalogue(['a', 'b'], ['g'], 2));
    const r = await runCatalogueRefresh({ trigger: 'cron' }, { env: f.env, client });

    expect(r).toEqual({ status: 'success', counts: { fetched: 3, added: 1, updated: 2, deactivated: 0, skipped: 2 }, errorCode: null });
    const sqls = f.sqls();
    expect(sqls[0]).toContain('pg_try_advisory_lock');
    // The transaction runs on its own connection while the lock connection stays open.
    const tx = f.log.filter((l) => l.conn === 2).map((l) => l.sql);
    expect(tx[0]).toBe('BEGIN');
    expect(tx.at(-1)).toBe('COMMIT');
    expect(sqls.at(-1)).toContain('pg_advisory_unlock');
    expect(f.released.every((x) => !x.destroy)).toBe(true);
    expect(client.getRoleCatalogue).toHaveBeenCalledTimes(1);
  });

  it('writes only source=rollekatalog rows, never deletes, and passes the values as parameters', async () => {
    const f = fakeEnv(script());
    await runCatalogueRefresh({ trigger: 'cron' }, { env: f.env, client: clientOf(catalogue(['a'], ['g'])) });
    const writes = f.log.filter((l) => /^(INSERT|UPDATE|DELETE)/.test(l.sql));
    expect(writes.map((w) => w.sql.split(' ')[0])).toEqual(['INSERT', 'UPDATE']);
    for (const w of writes) {
      expect(w.sql).toContain("source = 'rollekatalog'");
      expect(w.sql).not.toMatch(/\bDELETE\b/);
    }
    expect(f.sqls().join('\n')).not.toMatch(/DELETE FROM/);
    const insert = writes[0];
    expect(insert.params).toEqual([['role', 'group'], ['a', 'g'], ['Navn a', 'Gruppe g']]);
    expect(insert.sql).not.toContain('Navn a');
  });

  it('an empty list of ONE read kind aborts while active rollekatalog entries of that kind exist, even when forced', async () => {
    for (const force of [false, true]) {
      const f = fakeEnv(script((sql) => (sql.startsWith('SELECT kind, count(*)::int AS cnt') ? rows([{ kind: 'group', cnt: 2 }, { kind: 'role', cnt: 5 }]) : undefined)));
      const r = await runCatalogueRefresh({ trigger: 'manual', force }, { env: f.env, client: clientOf(catalogue(['a'], [])) });
      expect(r).toEqual({ status: 'aborted', counts: emptyCatalogueCounts(), errorCode: 'empty_response' });
      expect(f.sqls().some((s) => s.startsWith('INSERT') || s.startsWith('UPDATE'))).toBe(false);
      expect(f.log.filter((l) => l.conn === 2).map((l) => l.sql).at(-1)).toBe('ROLLBACK');
    }
  });

  it('an empty list is fine when no active entry of that kind exists, and when that kind is switched off (none)', async () => {
    const f = fakeEnv(script((sql) => (sql.startsWith('SELECT kind, count(*)::int AS cnt') ? rows([{ kind: 'group', cnt: 2 }]) : undefined)));
    const off: RkRoleCatalogue = { ...catalogue(['a'], []), read: { roles: true, groups: false } };
    const r = await runCatalogueRefresh({ trigger: 'cron' }, { env: f.env, client: clientOf(off) });
    expect(r.status).toBe('success');
    // Only the kinds that were read take part in the removal judgement and the deactivation.
    const gone = f.log.find((l) => l.sql.startsWith('SELECT e.kind, e.identifier'))!;
    expect(gone.params?.[2]).toEqual(['role']);
    const deactivate = f.log.find((l) => l.sql.startsWith('UPDATE'))!;
    expect(deactivate.params?.[2]).toEqual(['role']);

    const g = fakeEnv(script());
    expect((await runCatalogueRefresh({ trigger: 'cron' }, { env: g.env, client: clientOf(catalogue(['a'], [])) })).status).toBe('success');
  });

  it('leaves a key that exists as a config row out of the upsert (config wins)', async () => {
    const f = fakeEnv(script((sql) => (sql === "SELECT kind, identifier FROM external_roles WHERE source = 'config'" || sql.includes("WHERE source = 'config'") ? rows([{ kind: 'role', identifier: 'a' }]) : undefined)));
    const r = await runCatalogueRefresh({ trigger: 'cron' }, { env: f.env, client: clientOf(catalogue(['a', 'b'], ['g'])) });
    expect(r.status).toBe('success');
    const insert = f.log.find((l) => l.sql.startsWith('INSERT'))!;
    expect(insert.params).toEqual([['role', 'group'], ['b', 'g'], ['Navn b', 'Gruppe g']]);
    // The answer still counts what Rollekatalog sent.
    expect(r.counts.fetched).toBe(3);
  });

  it.each([
    ['no URL', 'ROLLEKATALOG_URL', '', 'not_configured'],
    ['no READ key', 'ROLLEKATALOG_READ_API_KEY', '', 'not_configured'],
    ['an insecure URL', 'ROLLEKATALOG_URL', 'http://rk.example.dk', 'insecure_url'],
  ])('%s: error, and nothing is connected, locked or fetched', async (_l, name, value, code) => {
    vi.stubEnv(name, value);
    const f = fakeEnv(script());
    const client = clientOf(catalogue(['a']));
    expect(await runCatalogueRefresh({ trigger: 'manual' }, { env: f.env, client })).toEqual({
      status: 'error',
      counts: emptyCatalogueCounts(),
      errorCode: code,
    });
    expect(f.log).toHaveLength(0);
    expect(client.getRoleCatalogue).not.toHaveBeenCalled();
  });

  it('an overlapping run answers already_running without fetching or writing', async () => {
    const f = fakeEnv(script((s) => (s.includes('pg_try_advisory_lock') ? rows([{ ok: false }]) : undefined)));
    const client = clientOf(catalogue(['a']));
    const r = await runCatalogueRefresh({ trigger: 'cron' }, { env: f.env, client });
    expect(r).toMatchObject({ status: 'already_running', errorCode: 'already_running' });
    expect(client.getRoleCatalogue).not.toHaveBeenCalled();
    expect(f.sqls().some((s) => s.startsWith('INSERT') || s === 'BEGIN')).toBe(false);
    expect(f.released).toEqual([{ conn: 1, destroy: false }]);
  });

  it('an empty answer aborts (empty_response) before any write, whatever the force flag', async () => {
    for (const force of [false, true]) {
      const f = fakeEnv(script());
      const r = await runCatalogueRefresh({ trigger: 'manual', force }, { env: f.env, client: clientOf(catalogue([], [])) });
      expect(r).toEqual({ status: 'aborted', counts: emptyCatalogueCounts(), errorCode: 'empty_response' });
      expect(f.sqls().some((s) => s === 'BEGIN' || s.startsWith('INSERT'))).toBe(false);
      expect(f.sqls().at(-1)).toContain('pg_advisory_unlock');
    }
  });

  it.each([
    ['timeout'],
    ['network'],
    ['unauthorized'],
    ['forbidden'],
    ['not_found'],
    ['server_error'],
    ['invalid_response'],
    ['too_large'],
  ] as const)('a fetch failure (%s) is an error with that short code, nothing is written, and the lock is released', async (code) => {
    const f = fakeEnv(script());
    const r = await runCatalogueRefresh({ trigger: 'cron' }, { env: f.env, client: clientOf(new RollekatalogError(code)) });
    expect(r).toEqual({ status: 'error', counts: emptyCatalogueCounts(), errorCode: code });
    expect(f.sqls().some((s) => s === 'BEGIN')).toBe(false);
    expect(f.sqls().at(-1)).toContain('pg_advisory_unlock');
  });

  it('an unexpected throw becomes code unexpected and never carries its message out', async () => {
    const f = fakeEnv(script());
    const r = await runCatalogueRefresh({ trigger: 'cron' }, { env: f.env, client: clientOf(new Error('boom read-key-value https://rk.example.dk')) });
    expect(r.errorCode).toBe('unexpected');
    expect(JSON.stringify(r)).not.toMatch(/boom|read-key-value|rk\.example/);
    expect(JSON.stringify((console.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toMatch(/boom|read-key-value|rk\.example/);
  });

  it('a database failure rolls back, reports db_error, and logs a label only', async () => {
    const f = fakeEnv(script((s) => (s.includes('RETURNING (xmax = 0)') ? new Error('relation "x" does not exist') : undefined)));
    const r = await runCatalogueRefresh({ trigger: 'cron' }, { env: f.env, client: clientOf(catalogue(['a'])) });
    expect(r).toEqual({ status: 'error', counts: emptyCatalogueCounts(), errorCode: 'db_error' });
    expect(f.log.filter((l) => l.conn === 2).map((l) => l.sql).at(-1)).toBe('ROLLBACK');
    expect(JSON.stringify((console.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('relation');
  });

  describe('removal threshold', () => {
    // 20 active entries, 5 of them leave: 25 % (default limit 30) trips nothing; 8 leave: 40 % does.
    const withGone = (n: number, base = 20) =>
      script((s) => {
        if (s.includes('SELECT count(*)::int AS n')) return rows([{ n: base }]);
        if (s.startsWith('SELECT e.kind, e.identifier')) return rows(Array.from({ length: n }, (_, i) => ({ kind: 'role', identifier: `gone${i}` })));
        return undefined;
      });

    it('aborts when too many entries would be deactivated, unless forced', async () => {
      const a = fakeEnv(withGone(8));
      const r = await runCatalogueRefresh({ trigger: 'cron' }, { env: a.env, client: clientOf(catalogue(['a'])) });
      expect(r).toEqual({ status: 'aborted', counts: emptyCatalogueCounts(), errorCode: 'removal_threshold' });
      expect(a.sqls().some((s) => s.startsWith('INSERT') || s.startsWith('UPDATE'))).toBe(false);
      expect(a.log.filter((l) => l.conn === 2).map((l) => l.sql).at(-1)).toBe('ROLLBACK');

      const b = fakeEnv(withGone(8));
      const forced = await runCatalogueRefresh({ trigger: 'manual', force: true }, { env: b.env, client: clientOf(catalogue(['a'])) });
      expect(forced.status).toBe('success');
      expect(forced.counts.deactivated).toBe(8);
    });

    it('passes below the threshold, and always allows a few removals from a small catalogue', async () => {
      const a = fakeEnv(withGone(5));
      expect((await runCatalogueRefresh({ trigger: 'cron' }, { env: a.env, client: clientOf(catalogue(['a'])) })).status).toBe('success');
      // 3 of 5 is 60 %, but within the absolute allowance of 3.
      const b = fakeEnv(withGone(3, 5));
      expect((await runCatalogueRefresh({ trigger: 'cron' }, { env: b.env, client: clientOf(catalogue(['a'])) })).status).toBe('success');
      const c = fakeEnv(withGone(4, 5));
      expect((await runCatalogueRefresh({ trigger: 'cron' }, { env: c.env, client: clientOf(catalogue(['a'])) })).status).toBe('aborted');
    });

    it('honours ROLLEKATALOG_SYNC_MAX_REMOVAL_PERCENT', async () => {
      vi.stubEnv('ROLLEKATALOG_SYNC_MAX_REMOVAL_PERCENT', '50');
      const f = fakeEnv(withGone(8));
      expect((await runCatalogueRefresh({ trigger: 'cron' }, { env: f.env, client: clientOf(catalogue(['a'])) })).status).toBe('success');
    });
  });
});
