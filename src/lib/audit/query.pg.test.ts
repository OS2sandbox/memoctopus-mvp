// Needs a real Postgres 15+; skipped unless TEST_DATABASE_URL is set (see src/test/pg.ts).
// Proves what mocks cannot: keyset paging against real ids, scope filtering with
// the recursive org tree, and the feed's delay/ordering rules.
import { describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import { createRunner, type SqlQueryable } from '@/lib/authz/pg-runner';
import type { ScopeEnv } from '@/lib/authz/scope';
import { makePrincipal } from '@/test/helpers';
import { hasPg, withFreshSchema } from '@/test/pg';

// query.ts and prune.ts import the app pool, which does not exist in this lane.
vi.mock('@/lib/db', () => ({ pool: { query: vi.fn(), connect: vi.fn() }, db: {} }));

import { pruneAuditEvents } from './prune';
import { auditScopeFor, collectAuditEvents, getFeedHead, getFeedPage, listAuditEvents, type AuditQueryEnv } from './query';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const agoMs = (ms: number) => new Date(Date.now() - ms);
const ENTITY = '11111111-1111-4111-8111-111111111111';
const OTHER_ENTITY = '22222222-2222-4222-8222-222222222222';

const queryEnv = (c: Client, schema: string): AuditQueryEnv => ({
  query: (text, params) => c.query(text, params),
  table: `"${schema}".audit_events`,
});
const scopeEnv = (c: Client, schema: string): ScopeEnv => ({
  query: (text, params) => c.query(text, params as unknown[]),
  orgUnitsTable: `"${schema}".org_units`,
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

async function unit(c: Client, name: string, parent: string | null = null): Promise<string> {
  const r = await c.query(`INSERT INTO org_units (name, parent_uuid, source) VALUES ($1, $2, 'local') RETURNING uuid`, [name, parent]);
  return r.rows[0].uuid;
}

const logReader = (roots: Array<{ orgUnitUuid: string; includeDescendants: boolean }>) =>
  makePrincipal({
    capabilities: ['template.use', 'audit.read'],
    scopes: { 'audit.read': { global: false, roots } },
  });

describe.skipIf(!hasPg)('audit query (real Postgres)', () => {
  describe('keyset pagination', () => {
    it('pages newest first without duplicates or gaps, and stays stable while new rows arrive', () =>
      withFreshSchema(async (c, schema) => {
        const env = queryEnv(c, schema);
        const ids: number[] = [];
        for (let i = 0; i < 25; i++) ids.push(await add(c));

        const seen: string[] = [];
        let page = await listAuditEvents({ scope: { all: true }, limit: 10 }, env);
        seen.push(...page.rows.map((r) => r.id));
        expect(page.nextCursor).toBe(seen[9]);

        // New events arrive between page 1 and page 2: they have higher ids and must not shift page 2.
        for (let i = 0; i < 3; i++) await add(c);

        page = await listAuditEvents({ scope: { all: true }, limit: 10, cursor: page.nextCursor! }, env);
        seen.push(...page.rows.map((r) => r.id));
        page = await listAuditEvents({ scope: { all: true }, limit: 10, cursor: page.nextCursor! }, env);
        seen.push(...page.rows.map((r) => r.id));
        expect(page.nextCursor).toBeNull();

        expect(seen.map(Number)).toEqual([...ids].reverse());
        expect(new Set(seen).size).toBe(25);
      }));

    it('the last page of an exactly full set has no cursor', () =>
      withFreshSchema(async (c, schema) => {
        const env = queryEnv(c, schema);
        for (let i = 0; i < 4; i++) await add(c);
        const page = await listAuditEvents({ scope: { all: true }, limit: 4 }, env);
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
          (await listAuditEvents({ scope: { all: true }, filters }, env)).rows.map((r) => Number(r.id)).sort((a, b) => a - b);

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
        const page = await listAuditEvents({ scope: { all: true }, filters: { actorUserId: "x' OR '1'='1", eventTypes: ["a'; DELETE FROM audit_events;--"] } }, env);
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
          (await listAuditEvents({ scope: { all: true }, filters: { q } }, env)).rows.map((r) => Number(r.id)).sort((a, b) => a - b);

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

    it('q never widens scope, and combines with other filters', () =>
      withFreshSchema(async (c, schema) => {
        const env = queryEnv(c, schema);
        const a = await unit(c, 'A');
        const b = await unit(c, 'B');
        const inA = await add(c, { actor_org_unit_uuid: a, actor_name: 'Mette A' });
        await add(c, { actor_org_unit_uuid: b, actor_name: 'Mette B' });
        await add(c, { actor_org_unit_uuid: null, actor_name: 'Mette Null' });
        const deniedA = await add(c, { actor_org_unit_uuid: a, actor_name: 'Mette A', event_type: 'authz.denied', outcome: 'denied' });
        const scope = await auditScopeFor(logReader([{ orgUnitUuid: a, includeDescendants: true }]), scopeEnv(c, schema));

        const scoped = await listAuditEvents({ scope, filters: { q: 'mette' } }, env);
        expect(scoped.rows.map((r) => Number(r.id)).sort((x, y) => x - y)).toEqual([inA, deniedA]);
        const both = await listAuditEvents({ scope, filters: { q: 'mette', outcome: 'denied' } }, env);
        expect(both.rows.map((r) => Number(r.id))).toEqual([deniedA]);
        const all = await collectAuditEvents({ scope: { all: true }, filters: { q: 'mette' }, maxRows: 100 }, env);
        expect(all.rows).toHaveLength(4);
      }));

    it('the viewer and the export hide types outside the catalogue; the feed still returns them', () =>
      withFreshSchema(async (c, schema) => {
        const env = queryEnv(c, schema);
        const known = await add(c, { event_type: 'auth.login' });
        // A type removed from the catalogue in a later release: its old rows stay in the table.
        const removed = await add(c, { event_type: 'directory.sync' });
        const listed = await listAuditEvents({ scope: { all: true } }, env);
        expect(listed.rows.map((r) => Number(r.id))).toEqual([known]);
        const exported = await collectAuditEvents({ scope: { all: true }, maxRows: 10 }, env);
        expect(exported.rows.map((r) => Number(r.id))).toEqual([known]);
        const feed = await getFeedPage({ offset: 0, size: 10, delaySeconds: 0 }, env);
        expect(feed.rows.map((r) => Number(r.id))).toEqual([known, removed]);
      }));
  });

  describe('scoped visibility', () => {
    it('a scoped reader sees descendants of their unit, never NULL-unit events, siblings or the parent', () =>
      withFreshSchema(async (c, schema) => {
        const env = queryEnv(c, schema);
        const root = await unit(c, 'Kommune');
        const child = await unit(c, 'Børn', root);
        const grandchild = await unit(c, 'Dagpleje', child);
        const sibling = await unit(c, 'Ældre', root);

        const evRoot = await add(c, { actor_org_unit_uuid: root });
        const evChild = await add(c, { actor_org_unit_uuid: child });
        const evGrand = await add(c, { actor_org_unit_uuid: grandchild });
        const evSibling = await add(c, { actor_org_unit_uuid: sibling });
        const evNull = await add(c, { actor_org_unit_uuid: null });
        // A snapshot of a unit that no longer exists must not be visible to a scoped reader either.
        const evGhost = await add(c, { actor_org_unit_uuid: '99999999-9999-4999-8999-999999999999' });

        const visible = async (p: ReturnType<typeof logReader> | 'global') => {
          const scope = p === 'global' ? ({ all: true } as const) : await auditScopeFor(p, scopeEnv(c, schema));
          return (await collectAuditEvents({ scope, maxRows: 100 }, env)).rows.map((r) => Number(r.id)).sort((a, b) => a - b);
        };

        expect(await visible('global')).toEqual([evRoot, evChild, evGrand, evSibling, evNull, evGhost]);
        expect(await visible(logReader([{ orgUnitUuid: child, includeDescendants: true }]))).toEqual([evChild, evGrand]);
        expect(await visible(logReader([{ orgUnitUuid: child, includeDescendants: false }]))).toEqual([evChild]);
        expect(await visible(logReader([{ orgUnitUuid: root, includeDescendants: true }]))).toEqual([evRoot, evChild, evGrand, evSibling]);
        expect(await visible(logReader([
          { orgUnitUuid: grandchild, includeDescendants: false },
          { orgUnitUuid: sibling, includeDescendants: false },
        ]))).toEqual([evGrand, evSibling]);
        // No scope entry, empty roots, or a root that is not in the tree: nothing.
        expect(await visible(logReader([]))).toEqual([]);
        expect(await visible(logReader([{ orgUnitUuid: '88888888-8888-4888-8888-888888888888', includeDescendants: true }]))).toEqual([]);
        expect(await visible(makePrincipal({ capabilities: ['template.use', 'audit.read'], scopes: {} }))).toEqual([]);
      }));

    it('scope and filters combine (the filter cannot widen the scope), and paging keeps the scope', () =>
      withFreshSchema(async (c, schema) => {
        const env = queryEnv(c, schema);
        const a = await unit(c, 'A');
        const b = await unit(c, 'B');
        for (let i = 0; i < 5; i++) await add(c, { actor_org_unit_uuid: a, event_type: 'auth.login' });
        for (let i = 0; i < 5; i++) await add(c, { actor_org_unit_uuid: b, event_type: 'auth.login' });
        const scope = await auditScopeFor(logReader([{ orgUnitUuid: a, includeDescendants: true }]), scopeEnv(c, schema));

        const p1 = await listAuditEvents({ scope, limit: 3, filters: { eventTypes: ['auth.login'] } }, env);
        const p2 = await listAuditEvents({ scope, limit: 3, cursor: p1.nextCursor!, filters: { eventTypes: ['auth.login'] } }, env);
        expect(p1.rows).toHaveLength(3);
        expect(p2.rows).toHaveLength(2);
        expect(p2.nextCursor).toBeNull();
        for (const r of [...p1.rows, ...p2.rows]) expect(r.actorOrgUnitUuid).toBe(a);
      }));
  });

  describe('feed', () => {
    it('serves rows after the offset in ascending id order, and pages with size', () =>
      withFreshSchema(async (c, schema) => {
        const env = queryEnv(c, schema);
        const ids: number[] = [];
        for (let i = 0; i < 5; i++) ids.push(await add(c));

        const p1 = await getFeedPage({ offset: 0, size: 2, delaySeconds: 10 }, env);
        expect(p1.rows.map((r) => Number(r.id))).toEqual([ids[0], ids[1]]);
        expect(p1.next).toBe(ids[1]);
        const p2 = await getFeedPage({ offset: p1.next, size: 2, delaySeconds: 10 }, env);
        expect(p2.rows.map((r) => Number(r.id))).toEqual([ids[2], ids[3]]);
        const p3 = await getFeedPage({ offset: p2.next, size: 2, delaySeconds: 10 }, env);
        expect(p3.rows.map((r) => Number(r.id))).toEqual([ids[4]]);
        const p4 = await getFeedPage({ offset: p3.next, size: 2, delaySeconds: 10 }, env);
        expect(p4).toMatchObject({ next: ids[4] });
        expect(p4.rows).toEqual([]);
        expect(await getFeedHead(10, env)).toBe(ids[4]);
      }));

    it('withholds rows younger than the delay, and everything after them', () =>
      withFreshSchema(async (c, schema) => {
        const env = queryEnv(c, schema);
        const a = await add(c, { occurred_at: agoMs(HOUR) });
        const young = await add(c, { occurred_at: new Date() });
        // Older than the delay, but behind a young row: held back with it, so a commit-order gap cannot skip it.
        const behind = await add(c, { occurred_at: agoMs(HOUR) });

        expect(await getFeedHead(10, env)).toBe(a);
        expect((await getFeedPage({ offset: 0, size: 10, delaySeconds: 10 }, env)).rows.map((r) => Number(r.id))).toEqual([a]);

        // Without a delay everything is served, in id order.
        expect(await getFeedHead(0, env)).toBe(behind);
        expect((await getFeedPage({ offset: 0, size: 10, delaySeconds: 0 }, env)).rows.map((r) => Number(r.id))).toEqual([a, young, behind]);
      }));

    it('an empty log has head 0 and no records', () =>
      withFreshSchema(async (c, schema) => {
        const env = queryEnv(c, schema);
        expect(await getFeedHead(10, env)).toBe(0);
        expect(await getFeedPage({ offset: 0, size: 10, delaySeconds: 10 }, env)).toEqual({ rows: [], next: 0 });
      }));

    it('a log with only young rows serves nothing yet', () =>
      withFreshSchema(async (c, schema) => {
        const env = queryEnv(c, schema);
        await add(c, { occurred_at: new Date() });
        expect(await getFeedHead(3600, env)).toBe(0);
        expect((await getFeedPage({ offset: 0, size: 10, delaySeconds: 3600 }, env)).rows).toEqual([]);
      }));

    it('returns ip only where one was stored, and the stored fields intact', () =>
      withFreshSchema(async (c, schema) => {
        const env = queryEnv(c, schema);
        await add(c, { ip_address: '10.0.0.9', user_agent: 'UA', details: JSON.stringify({ method: 'oidc' }) });
        await add(c, { ip_address: null });
        const { rows } = await getFeedPage({ offset: 0, size: 10, delaySeconds: 10 }, env);
        expect(rows[0]).toMatchObject({ ipAddress: '10.0.0.9', userAgent: 'UA', details: { method: 'oidc' } });
        expect(rows[1].ipAddress).toBeNull();
      }));
  });

  describe('pruning', () => {
    const runnerFor = (c: Client) => {
      const q: SqlQueryable = { query: (t, p) => c.query(t, p as unknown[]) as never };
      return createRunner(q, async () => ({ ...q, release: () => {} }));
    };

    it('the viewer and the feed keep working after old rows are pruned; a stale offset skips the gap', () =>
      withFreshSchema(async (c, schema) => {
        const env = queryEnv(c, schema);
        const old: number[] = [];
        for (let i = 0; i < 4; i++) old.push(await add(c, { occurred_at: agoMs(100 * DAY) }));
        const keep: number[] = [];
        for (let i = 0; i < 3; i++) keep.push(await add(c, { occurred_at: agoMs(2 * DAY) }));

        // A consumer that had read up to the second old row.
        const consumerOffset = old[1];

        const deleted = await pruneAuditEvents({
          olderThanDays: 30,
          runner: runnerFor(c),
          table: `"${schema}".audit_events`,
          emitEvent: false,
        });
        expect(deleted).toBe(4);

        const feed = await getFeedPage({ offset: consumerOffset, size: 10, delaySeconds: 10 }, env);
        expect(feed.rows.map((r) => Number(r.id))).toEqual(keep);
        expect(feed.next).toBe(keep[2]);
        expect(await getFeedHead(10, env)).toBe(keep[2]);

        const viewer = await listAuditEvents({ scope: { all: true }, limit: 10 }, env);
        expect(viewer.rows.map((r) => Number(r.id))).toEqual([...keep].reverse());
        expect(viewer.nextCursor).toBeNull();

        // A cursor that pointed into the pruned range just yields what is left below it.
        const empty = await listAuditEvents({ scope: { all: true }, cursor: String(old[2]) }, env);
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
