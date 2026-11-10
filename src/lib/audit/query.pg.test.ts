// Needs a real Postgres 15+; skipped unless TEST_DATABASE_URL is set (see src/test/pg.ts).
// Proves what mocks cannot: keyset paging against real ids, the filters and pruning.
import { describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import { createRunner, type SqlQueryable } from '@/lib/authz/pg-runner';
import { hasPg, withFreshSchema } from '@/test/pg';

// query.ts and prune.ts import the app pool, which does not exist in this lane.
vi.mock('@/lib/db', () => ({ pool: { query: vi.fn(), connect: vi.fn() }, db: {} }));

import { pruneAuditEvents } from './prune';
import { collectAuditEvents, listAuditEvents, type AuditQueryEnv } from './query';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const agoMs = (ms: number) => new Date(Date.now() - ms);
const ENTITY = '11111111-1111-4111-8111-111111111111';
const OTHER_ENTITY = '22222222-2222-4222-8222-222222222222';

const queryEnv = (c: Client, schema: string): AuditQueryEnv => ({
  query: (text, params) => c.query(text, params),
  table: `"${schema}".audit_events`,
});

let seq = 0;
async function add(c: Client, over: Record<string, unknown> = {}): Promise<number> {
  const row = {
    source: 'server',
    event_type: 'auth.login',
    outcome: 'success',
    actor_user_id: `u${++seq}`,
    occurred_at: agoMs(2 * DAY),
    ...over,
  };
  const cols = Object.keys(row);
  const r = await c.query(
    `INSERT INTO audit_events (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    Object.values(row),
  );
  return Number(r.rows[0].id);
}

describe.skipIf(!hasPg)('audit query (real Postgres)', () => {
  describe('keyset pagination', () => {
    it('pages newest first without duplicates or gaps, and stays stable while new rows arrive', () =>
      withFreshSchema(async (c, schema) => {
        const env = queryEnv(c, schema);
        const ids: number[] = [];
        for (let i = 0; i < 25; i++) ids.push(await add(c));

        const seen: string[] = [];
        let page = await listAuditEvents({ limit: 10 }, env);
        seen.push(...page.rows.map((r) => r.id));
        expect(page.nextCursor).toBe(seen[9]);

        // New events arrive between page 1 and page 2: they have higher ids and must not shift page 2.
        for (let i = 0; i < 3; i++) await add(c);

        page = await listAuditEvents({ limit: 10, cursor: page.nextCursor! }, env);
        seen.push(...page.rows.map((r) => r.id));
        page = await listAuditEvents({ limit: 10, cursor: page.nextCursor! }, env);
        seen.push(...page.rows.map((r) => r.id));
        expect(page.nextCursor).toBeNull();

        expect(seen.map(Number)).toEqual([...ids].reverse());
        expect(new Set(seen).size).toBe(25);
      }));

    it('the last page of an exactly full set has no cursor', () =>
      withFreshSchema(async (c, schema) => {
        const env = queryEnv(c, schema);
        for (let i = 0; i < 4; i++) await add(c);
        const page = await listAuditEvents({ limit: 4 }, env);
        expect(page.rows).toHaveLength(4);
        expect(page.nextCursor).toBeNull();
      }));
  });

  describe('filters', () => {
    it('combines event type, outcome, source, actor, entity (primary or secondary) and date range', () =>
      withFreshSchema(async (c, schema) => {
        const env = queryEnv(c, schema);
        const login = await add(c, { event_type: 'auth.login', actor_user_id: 'alice' });
        const denied = await add(c, { event_type: 'authz.denied', outcome: 'denied', actor_user_id: 'alice' });
        const client = await add(c, { event_type: 'meeting.delete', source: 'client', actor_user_id: 'bob', entity_type: 'meeting', entity_id: ENTITY });
        const second = await add(c, {
          event_type: 'minutes.generate',
          actor_user_id: 'bob',
          entity_type: 'meeting',
          entity_id: OTHER_ENTITY,
          secondary_entity_type: 'template',
          secondary_entity_id: ENTITY,
        });
        const old = await add(c, { event_type: 'auth.login', actor_user_id: 'alice', occurred_at: agoMs(30 * DAY) });
        const ids = async (filters: Parameters<typeof listAuditEvents>[0]['filters']) =>
          (await listAuditEvents({ filters }, env)).rows.map((r) => Number(r.id)).sort((a, b) => a - b);

        expect(await ids({ eventTypes: ['auth.login'] })).toEqual([login, old]);
        expect(await ids({ eventTypes: ['auth.login', 'meeting.delete'] })).toEqual([login, client, old]);
        expect(await ids({ outcome: 'denied' })).toEqual([denied]);
        expect(await ids({ source: 'client' })).toEqual([client]);
        expect(await ids({ actorUserId: 'bob' })).toEqual([client, second]);
        expect(await ids({ entityId: ENTITY })).toEqual([client, second]);
        expect(await ids({ entityId: OTHER_ENTITY.toUpperCase() })).toEqual([second]);
        expect(await ids({ from: agoMs(5 * DAY) })).toEqual([login, denied, client, second]);
        expect(await ids({ to: agoMs(10 * DAY) })).toEqual([old]);
        expect(await ids({ eventTypes: ['auth.login'], actorUserId: 'alice', from: agoMs(5 * DAY) })).toEqual([login]);
      }));

    it('hostile filter values are plain data, not SQL', () =>
      withFreshSchema(async (c, schema) => {
        const env = queryEnv(c, schema);
        await add(c);
        const page = await listAuditEvents({ filters: { actorUserId: "x' OR '1'='1", eventTypes: ["a'; DELETE FROM audit_events;--"] } }, env);
        expect(page.rows).toHaveLength(0);
        expect((await c.query('SELECT count(*)::int AS n FROM audit_events')).rows[0].n).toBe(1);
      }));
  });

  describe('name search and catalogue', () => {
    it('q matches the name snapshot case-insensitively, or an exact user id; % _ and backslash are literal', () =>
      withFreshSchema(async (c, schema) => {
        const env = queryEnv(c, schema);
        const mette = await add(c, { actor_user_id: 'u-mette', actor_name: 'Mette Eksempelsen' });
        const metteB = await add(c, { actor_user_id: 'u-mette2', actor_name: 'Hr. METTE Hansen' });
        const percent = await add(c, { actor_user_id: 'u-pct', actor_name: '100% Bruger' });
        const under = await add(c, { actor_user_id: 'u-under', actor_name: 'A_B' });
        const plain = await add(c, { actor_user_id: 'u-plain', actor_name: 'AxB' });
        const slash = await add(c, { actor_user_id: 'u-slash', actor_name: 'Back\\slash' });
        const noName = await add(c, { actor_user_id: 'u-noname', actor_name: null });
        const ids = async (q: string) =>
          (await listAuditEvents({ filters: { q } }, env)).rows.map((r) => Number(r.id)).sort((a, b) => a - b);

        expect(await ids('mette')).toEqual([mette, metteB]);
        expect(await ids('Eksempelsen')).toEqual([mette]);
        expect(await ids('u-noname')).toEqual([noName]); // exact id
        expect(await ids('u-nonam')).toEqual([]); // ids are not matched as substrings
        expect(await ids('%')).toEqual([percent]); // not "everything"
        expect(await ids('_')).toEqual([under]); // not "any character"
        expect(await ids('A_B')).toEqual([under]);
        expect(await ids('\\')).toEqual([slash]);
        expect(plain).toBeGreaterThan(0);
        expect(await ids("x' OR '1'='1")).toEqual([]);
      }));

    it('q combines with other filters', () =>
      withFreshSchema(async (c, schema) => {
        const env = queryEnv(c, schema);
        await add(c, { actor_name: 'Mette A' });
        await add(c, { actor_name: 'Mette B' });
        await add(c, { actor_name: 'Anne' });
        const denied = await add(c, { actor_name: 'Mette A', event_type: 'authz.denied', outcome: 'denied' });

        const both = await listAuditEvents({ filters: { q: 'mette', outcome: 'denied' } }, env);
        expect(both.rows.map((r) => Number(r.id))).toEqual([denied]);
        const all = await collectAuditEvents({ filters: { q: 'mette' }, maxRows: 100 }, env);
        expect(all.rows).toHaveLength(3);
      }));

    it('the viewer and the export show unknown types (not access.*)', () =>
      withFreshSchema(async (c, schema) => {
        const env = queryEnv(c, schema);
        const known = await add(c, { event_type: 'auth.login' });
        // A type removed from the catalogue in a later release: its old rows stay in the table.
        const removed = await add(c, { event_type: 'access.role_grant' });
        const unknown = await add(c, { event_type: 'directory.sync' });
        const listed = await listAuditEvents({}, env);
        expect(listed.rows.map((r) => Number(r.id)).sort((a, b) => a - b)).toEqual([known, unknown]);
        const exported = await collectAuditEvents({ maxRows: 10 }, env);
        expect(exported.rows.map((r) => Number(r.id)).sort((a, b) => a - b)).toEqual([known, unknown]);
        expect(removed).toBeGreaterThan(known);
      }));
  });

  describe('stored fields', () => {
    it('returns ip only where one was stored, and the stored fields intact', () =>
      withFreshSchema(async (c, schema) => {
        const env = queryEnv(c, schema);
        await add(c, { ip_address: '10.0.0.9', user_agent: 'UA', details: JSON.stringify({ method: 'oidc' }) });
        await add(c, { ip_address: null });
        const { rows } = await collectAuditEvents({ maxRows: 10 }, env);
        // Newest first.
        expect(rows[1]).toMatchObject({ ipAddress: '10.0.0.9', userAgent: 'UA', details: { method: 'oidc' } });
        expect(rows[0].ipAddress).toBeNull();
      }));
  });

  describe('pruning', () => {
    const runnerFor = (c: Client) => {
      const q: SqlQueryable = { query: (t, p) => c.query(t, p as unknown[]) as never };
      return createRunner(q, async () => ({ ...q, release: () => {} }));
    };

    it('the viewer keeps working after old rows are pruned', () =>
      withFreshSchema(async (c, schema) => {
        const env = queryEnv(c, schema);
        const old: number[] = [];
        for (let i = 0; i < 4; i++) old.push(await add(c, { occurred_at: agoMs(100 * DAY) }));
        const keep: number[] = [];
        for (let i = 0; i < 3; i++) keep.push(await add(c, { occurred_at: agoMs(2 * DAY) }));

        const deleted = await pruneAuditEvents({
          olderThanDays: 30,
          runner: runnerFor(c),
          table: `"${schema}".audit_events`,
          emitEvent: false,
        });
        expect(deleted).toBe(4);

        const viewer = await listAuditEvents({ limit: 10 }, env);
        expect(viewer.rows.map((r) => Number(r.id))).toEqual([...keep].reverse());
        expect(viewer.nextCursor).toBeNull();

        // A cursor that pointed into the pruned range just yields what is left below it.
        const empty = await listAuditEvents({ cursor: String(old[2]) }, env);
        expect(empty.rows).toEqual([]);
      }));

    it('new rows after a prune get higher ids than anything pruned (ids are never reused)', () =>
      withFreshSchema(async (c, schema) => {
        const old = await add(c, { occurred_at: agoMs(100 * DAY) });
        await pruneAuditEvents({ olderThanDays: 30, runner: runnerFor(c), table: `"${schema}".audit_events`, emitEvent: false });
        const fresh = await add(c);
        expect(fresh).toBeGreaterThan(old);
      }));
  });
});
