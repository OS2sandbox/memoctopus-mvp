// Needs a real Postgres 15+; skipped unless TEST_DATABASE_URL is set (see src/test/pg.ts).
// Proves what mocks cannot: the immutability triggers, the check constraints,
// the idempotency index, and that migration 0002 applies after 0001.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import { createRunner, type SqlQueryable } from '@/lib/authz/pg-runner';
import { hasPg, withFreshSchema } from '@/test/pg';

// recordEvent's actor snapshot reads through the app's Drizzle pool, which does not
// exist in this lane: an empty result is "unknown actor", which the code tolerates.
vi.mock('@/lib/db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'leftJoin', 'where', 'limit']) chain[m] = () => chain;
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve);
  return { db: { select: () => chain }, pool: { query: vi.fn(), connect: vi.fn() } };
});

import { recordEvent } from './record';
import { pruneAuditEvents } from './prune';

const RAISE_EXCEPTION_55000 = '55000';
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

/** SQLSTATE of the error a statement raises, or undefined if it succeeds. */
async function sqlState(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

const insert = (c: Client, over: Partial<Record<string, unknown>> = {}) => {
  const row = { source: 'server', event_type: 'auth.login', outcome: 'success', actor_user_id: 'u1', ...over };
  const cols = Object.keys(row);
  return c.query(
    `INSERT INTO audit_events (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    Object.values(row),
  );
};

const count = async (c: Client) => Number((await c.query('SELECT count(*) AS n FROM audit_events')).rows[0].n);

const asTx = (c: Client): SqlQueryable => ({ query: (t, p) => c.query(t, p as unknown[]) as never });

afterEach(() => vi.unstubAllEnvs());

describe.skipIf(!hasPg)('audit_events (real Postgres)', () => {
  it('migration 0002 applies after 0001: central tables, audit table, function and triggers all exist', () =>
    withFreshSchema(async (c) => {
      const tables = (await c.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()`)).rows.map((r) => r.table_name);
      expect(tables).toEqual(expect.arrayContaining(['directory_users', 'role_assignments', 'audit_events']));
      const triggers = (await c.query(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'audit_events'::regclass AND NOT tgisinternal ORDER BY tgname`)).rows.map((r) => r.tgname);
      expect(triggers).toEqual(['audit_events_no_truncate', 'audit_events_no_update_delete']);
    }));

  it('indexes entity_id and secondary_entity_id separately (partial), not as (entity_type, entity_id)', () =>
    withFreshSchema(async (c, schema) => {
      const idx = (await c.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'audit_events'`, [schema])).rows;
      const names = idx.map((r) => r.indexname);
      expect(names).not.toContain('audit_events_entity_idx');
      expect(names).toEqual(expect.arrayContaining(['audit_events_entity_id_idx', 'audit_events_secondary_entity_id_idx']));
      const def = (n: string) => idx.find((r) => r.indexname === n)?.indexdef ?? '';
      expect(def('audit_events_entity_id_idx')).toMatch(/\(entity_id\) WHERE \(entity_id IS NOT NULL\)/);
      expect(def('audit_events_secondary_entity_id_idx')).toMatch(/\(secondary_entity_id\) WHERE \(secondary_entity_id IS NOT NULL\)/);
    }));

  it('has no foreign keys: a row may name an actor that does not exist (and survives user deletion)', () =>
    withFreshSchema(async (c) => {
      const fks = await c.query(`SELECT 1 FROM pg_constraint WHERE conrelid = 'audit_events'::regclass AND contype = 'f'`);
      expect(fks.rowCount).toBe(0);
      await insert(c, { actor_user_id: 'ghost-user', actor_org_unit_uuid: '99999999-2222-4333-8444-555555555555' });
      expect(await count(c)).toBe(1);
    }));

  it('applies defaults: occurred_at now(), details {}, nullable snapshot columns', () =>
    withFreshSchema(async (c) => {
      await c.query(`INSERT INTO audit_events (source, event_type, outcome) VALUES ('system', 'audit.prune', 'success')`);
      const r = (await c.query(`SELECT occurred_at, details, actor_user_id, actor_name, actor_org_unit_uuid FROM audit_events`)).rows[0];
      expect(r.details).toEqual({});
      expect(r.actor_user_id).toBeNull();
      expect(r.actor_name).toBeNull();
      expect(r.actor_org_unit_uuid).toBeNull();
      expect(Math.abs(Date.now() - new Date(r.occurred_at).getTime())).toBeLessThan(60_000);
    }));

  it('ids are monotonic in insert order (bigserial cursor)', () =>
    withFreshSchema(async (c) => {
      const ids: number[] = [];
      for (let i = 0; i < 5; i++) ids.push(Number((await insert(c)).rows[0].id));
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
      expect(new Set(ids).size).toBe(5);
    }));

  describe('immutability', () => {
    it('rejects UPDATE', () =>
      withFreshSchema(async (c) => {
        await insert(c);
        expect(await sqlState(c.query(`UPDATE audit_events SET outcome = 'error'`))).toBe(RAISE_EXCEPTION_55000);
        expect((await c.query(`SELECT outcome FROM audit_events`)).rows[0].outcome).toBe('success');
      }));

    it('rejects DELETE', () =>
      withFreshSchema(async (c) => {
        await insert(c);
        expect(await sqlState(c.query(`DELETE FROM audit_events`))).toBe(RAISE_EXCEPTION_55000);
        expect(await count(c)).toBe(1);
      }));

    it('rejects TRUNCATE (also when the prune flag is on)', () =>
      withFreshSchema(async (c) => {
        await insert(c);
        expect(await sqlState(c.query(`TRUNCATE audit_events`))).toBe(RAISE_EXCEPTION_55000);
        await c.query('BEGIN');
        await c.query(`SELECT set_config('audit.allow_prune', 'on', true)`);
        expect(await sqlState(c.query(`TRUNCATE audit_events`))).toBe(RAISE_EXCEPTION_55000);
        await c.query('ROLLBACK');
        expect(await count(c)).toBe(1);
      }));

    it('allows DELETE only inside a transaction that set audit.allow_prune, and the flag never leaks', () =>
      withFreshSchema(async (c) => {
        await insert(c);
        await insert(c);
        await c.query('BEGIN');
        await c.query(`SELECT set_config('audit.allow_prune', 'on', true)`);
        await c.query(`DELETE FROM audit_events WHERE id = (SELECT min(id) FROM audit_events)`);
        await c.query('COMMIT');
        expect(await count(c)).toBe(1);
        // Transaction-local: the next statement is back to refusing.
        expect(await sqlState(c.query(`DELETE FROM audit_events`))).toBe(RAISE_EXCEPTION_55000);
        // Any other value of the setting does not unlock it.
        await c.query('BEGIN');
        await c.query(`SELECT set_config('audit.allow_prune', 'yes', true)`);
        expect(await sqlState(c.query(`DELETE FROM audit_events`))).toBe(RAISE_EXCEPTION_55000);
        await c.query('ROLLBACK');
        expect(await count(c)).toBe(1);
      }));

    it('never allows UPDATE, even with the prune flag on', () =>
      withFreshSchema(async (c) => {
        await insert(c);
        await c.query('BEGIN');
        await c.query(`SELECT set_config('audit.allow_prune', 'on', true)`);
        expect(await sqlState(c.query(`UPDATE audit_events SET outcome = 'error'`))).toBe(RAISE_EXCEPTION_55000);
        await c.query('ROLLBACK');
      }));
  });

  describe('pruneAuditEvents', () => {
    const runnerFor = (c: Client) => createRunner(asTx(c), async () => ({ ...asTx(c), release: () => {} }));

    it('deletes only rows older than the cutoff, in batches, and leaves recent rows', () =>
      withFreshSchema(async (c, schema) => {
        for (let i = 0; i < 5; i++) await insert(c, { occurred_at: new Date(Date.now() - 100 * 86_400_000) });
        for (let i = 0; i < 2; i++) await insert(c, { occurred_at: new Date(Date.now() - 1 * 86_400_000) });
        const deleted = await pruneAuditEvents({
          olderThanDays: 30,
          batchSize: 2,
          runner: runnerFor(c),
          table: `"${schema}".audit_events`,
          emitEvent: false,
        });
        expect(deleted).toBe(5);
        expect(await count(c)).toBe(2);
        // The flag was transaction-local: a direct DELETE is refused again.
        expect(await sqlState(c.query(`DELETE FROM audit_events`))).toBe(RAISE_EXCEPTION_55000);
      }));

    it('returns 0 and deletes nothing when no row is old enough', () =>
      withFreshSchema(async (c, schema) => {
        await insert(c);
        const n = await pruneAuditEvents({ olderThanDays: 30, runner: runnerFor(c), table: `"${schema}".audit_events`, emitEvent: false });
        expect(n).toBe(0);
        expect(await count(c)).toBe(1);
      }));
  });

  describe('client event idempotency', () => {
    const CID = '11111111-2222-4333-8444-555555555555';
    const clientRow = (c: Client, actor: string, cid: string | null) =>
      insert(c, { source: 'client', event_type: 'meeting.create', actor_user_id: actor, client_event_id: cid });

    it('rejects a second row with the same (actor, client_event_id)', () =>
      withFreshSchema(async (c) => {
        await clientRow(c, 'u1', CID);
        expect(await sqlState(clientRow(c, 'u1', CID))).toBe(UNIQUE_VIOLATION);
      }));

    it('allows the same client id for another actor, and any number of rows without one', () =>
      withFreshSchema(async (c) => {
        await clientRow(c, 'u1', CID);
        await clientRow(c, 'u2', CID);
        await clientRow(c, 'u1', null);
        await clientRow(c, 'u1', null);
        expect(await count(c)).toBe(4);
      }));

    it('recordEvent stores a client event once and reports the redelivery as duplicate', () =>
      withFreshSchema(async (c, schema) => {
        const event = {
          type: 'meeting.create',
          source: 'client',
          actorUserId: 'u1',
          entityId: '99999999-2222-4333-8444-555555555555',
          clientEventId: CID,
          clientOccurredAt: new Date('2026-10-05T09:00:00Z'),
          details: { origin: 'live' },
        } as const;
        const opts = { tx: asTx(c), table: `"${schema}".audit_events` };
        expect(await recordEvent(event, opts)).toEqual({ status: 'stored' });
        expect(await recordEvent(event, opts)).toEqual({ status: 'duplicate' });
        const rows = (await c.query(`SELECT source, event_type, actor_user_id, entity_type, entity_id, details, client_event_id, client_occurred_at FROM audit_events`)).rows;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          source: 'client',
          event_type: 'meeting.create',
          actor_user_id: 'u1',
          entity_type: 'meeting',
          entity_id: '99999999-2222-4333-8444-555555555555',
          details: { origin: 'live' },
          client_event_id: CID,
        });
        expect(new Date(rows[0].client_occurred_at).toISOString()).toBe('2026-10-05T09:00:00.000Z');
      }));
  });

  describe('check constraints', () => {
    it('rejects an unknown source and an unknown outcome', () =>
      withFreshSchema(async (c) => {
        expect(await sqlState(insert(c, { source: 'browser' }))).toBe(CHECK_VIOLATION);
        expect(await sqlState(insert(c, { outcome: 'maybe' }))).toBe(CHECK_VIOLATION);
        for (const source of ['server', 'client', 'system']) await insert(c, { source });
        for (const outcome of ['success', 'denied', 'error']) await insert(c, { outcome });
        expect(await count(c)).toBe(6);
      }));
  });

  describe('recordEvent end to end', () => {
    it('writes a server event with ip, user agent and request id, and honours AUDIT_STORE_IP=false', () =>
      withFreshSchema(async (c, schema) => {
        const opts = {
          tx: asTx(c),
          table: `"${schema}".audit_events`,
          context: { ip: '203.0.113.9', userAgent: 'UA/1', requestId: 'req-1' },
        };
        const event = { type: 'export.download', actorUserId: 'u1', entityId: '99999999-2222-4333-8444-555555555555', details: { format: 'pdf' } } as const;
        await recordEvent(event, opts);
        vi.stubEnv('AUDIT_STORE_IP', 'false');
        await recordEvent(event, opts);
        const rows = (await c.query(`SELECT ip_address, user_agent, request_id, details FROM audit_events ORDER BY id`)).rows;
        expect(rows.map((r) => r.ip_address)).toEqual(['203.0.113.9', null]);
        expect(rows.every((r) => r.user_agent === 'UA/1' && r.request_id === 'req-1')).toBe(true);
        expect(rows[0].details).toEqual({ format: 'pdf' });
      }));
  });
});
