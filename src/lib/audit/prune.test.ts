import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeRunner } from '@/test/fake-runner';

const recordEvent = vi.hoisted(() => vi.fn(async () => ({ status: 'stored' })));
vi.mock('./record', async (orig) => ({ ...(await orig<typeof import('./record')>()), recordEvent }));
vi.mock('@/lib/db', () => ({ db: {}, pool: { query: vi.fn(), connect: vi.fn() } }));

import { pruneAuditEvents } from './prune';

beforeEach(() => recordEvent.mockClear());

describe('pruneAuditEvents', () => {
  it('sets the transaction-local prune flag before deleting, in the same transaction', async () => {
    const { runner, calls } = makeFakeRunner(() => []);
    await pruneAuditEvents({ olderThanDays: 30, runner });
    const sqls = calls.map((c) => c.sql.replace(/\s+/g, ' ').trim());
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[1]).toBe(`SELECT set_config('audit.allow_prune', 'on', true)`);
    expect(sqls[2]).toMatch(/^DELETE FROM public\.audit_events WHERE id IN \(SELECT id FROM public\.audit_events WHERE occurred_at < \$1 ORDER BY id LIMIT \$2\)$/);
    expect(sqls[3]).toBe('COMMIT');
    expect(calls.slice(0, 4).every((c) => c.tx)).toBe(true);
  });

  it('computes the cutoff from `now` and the retention days', async () => {
    const { runner, calls } = makeFakeRunner(() => []);
    await pruneAuditEvents({ olderThanDays: 90, now: new Date('2026-10-05T12:00:00Z'), batchSize: 10, runner });
    const del = calls.find((c) => c.sql.includes('DELETE'))!;
    expect(del.params[0]).toEqual(new Date('2026-07-07T12:00:00Z'));
    expect(del.params[1]).toBe(10);
  });

  it('deletes in batches until a short batch and returns the total', async () => {
    const counts = [3, 3, 1];
    const calls: string[] = [];
    const runner = {
      query: vi.fn(),
      transaction: async (fn: (tx: { query: (s: string) => Promise<unknown> }) => Promise<unknown>) =>
        fn({
          query: async (sql: string) => {
            calls.push(sql);
            return sql.includes('DELETE') ? { rows: [], rowCount: counts.shift() } : { rows: [], rowCount: 1 };
          },
        }),
    };
    const total = await pruneAuditEvents({ olderThanDays: 1, batchSize: 3, runner: runner as never });
    expect(total).toBe(7);
    expect(calls.filter((s) => s.includes('DELETE'))).toHaveLength(3);
  });

  it('records one audit.prune system event when something was deleted, none otherwise', async () => {
    const some = makeFakeRunner((sql) => (sql.includes('DELETE') ? [] : []));
    // fake runner reports rowCount = rows.length, so use a custom runner for a non-zero count
    const runner = {
      query: vi.fn(),
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ query: async (sql: string) => ({ rows: [], rowCount: sql.includes('DELETE') ? 2 : 1 }) }),
    };
    await pruneAuditEvents({ olderThanDays: 7, runner: runner as never });
    expect(recordEvent).toHaveBeenCalledOnce();
    expect(recordEvent).toHaveBeenCalledWith({ type: 'audit.prune', source: 'system', details: { deletedCount: 2, olderThanDays: 7 } });

    recordEvent.mockClear();
    await pruneAuditEvents({ olderThanDays: 7, runner: some.runner });
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('can skip the event (pg test lane)', async () => {
    const runner = {
      query: vi.fn(),
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ query: async () => ({ rows: [], rowCount: 2 }) }),
    };
    await pruneAuditEvents({ olderThanDays: 7, runner: runner as never, emitEvent: false });
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('refuses a retention that would wipe the log or is not a whole number', async () => {
    const { runner, calls } = makeFakeRunner();
    for (const bad of [0, -1, 1.5, Number.NaN, Infinity]) {
      await expect(pruneAuditEvents({ olderThanDays: bad, runner })).rejects.toThrow(RangeError);
    }
    await expect(pruneAuditEvents({ olderThanDays: 5, batchSize: 0, runner })).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });

  it('still records the audit.prune event for the batches already deleted when a later batch throws', async () => {
    let deletes = 0;
    const runner = {
      query: vi.fn(),
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          query: async (sql: string) => {
            if (sql.includes('DELETE') && ++deletes === 2) throw new Error('boom');
            return { rows: [], rowCount: sql.includes('DELETE') ? 3 : 1 };
          },
        }),
    };
    await expect(pruneAuditEvents({ olderThanDays: 7, batchSize: 3, runner: runner as never })).rejects.toThrow('boom');
    expect(recordEvent).toHaveBeenCalledOnce();
    expect(recordEvent).toHaveBeenCalledWith({ type: 'audit.prune', source: 'system', details: { deletedCount: 3, olderThanDays: 7 } });
  });

  it('rolls back and propagates when the delete fails', async () => {
    const { runner, calls } = makeFakeRunner((sql) => {
      if (sql.includes('DELETE')) throw new Error('boom');
      return [];
    });
    await expect(pruneAuditEvents({ olderThanDays: 5, runner })).rejects.toThrow('boom');
    expect(calls.map((c) => c.sql).pop()).toBe('ROLLBACK');
    expect(recordEvent).not.toHaveBeenCalled();
  });
});
