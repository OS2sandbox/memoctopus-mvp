import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolQuery = vi.fn();
vi.mock('@/lib/db', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...a) } }));

import { FAKE_PRINCIPAL_ADMIN, makePrincipal } from '@/test/helpers';
import {
  MAX_FEED_SIZE,
  MAX_PAGE_SIZE,
  auditScopeFor,
  collectAuditEvents,
  getFeedHead,
  getFeedPage,
  listAuditEvents,
  type AuditQueryEnv,
} from './query';

const UNIT_A = 'aaaa0000-0000-4000-8000-00000000000a';
const UNIT_B = 'bbbb0000-0000-4000-8000-00000000000b';
const ENTITY = '11111111-1111-4111-8111-111111111111';

const dbRow = (id: number, over: Record<string, unknown> = {}) => ({
  id: String(id),
  occurred_at: new Date('2026-10-05T09:00:00Z'),
  source: 'server',
  event_type: 'export.download',
  outcome: 'success',
  actor_user_id: 'u1',
  actor_name: 'Anne',
  actor_org_unit_uuid: UNIT_A,
  entity_type: 'meeting',
  entity_id: ENTITY,
  secondary_entity_type: null,
  secondary_entity_id: null,
  ip_address: '10.0.0.1',
  user_agent: 'UA',
  request_id: 'r1',
  details: { format: 'pdf' },
  client_occurred_at: null,
  ...over,
});

function fakeEnv(pages: Array<Array<Record<string, unknown>>> = [[]]) {
  const query = vi.fn(async (..._a: [string, unknown[]]) => ({ rows: pages.shift() ?? [] }));
  const env: AuditQueryEnv = { query, table: 'public.audit_events' };
  return { env, query, sql: () => String(query.mock.calls.at(-1)![0]), params: () => query.mock.calls.at(-1)![1] };
}

beforeEach(() => poolQuery.mockReset());

describe('listAuditEvents scope', () => {
  it('a global reader gets no org unit condition', async () => {
    const f = fakeEnv();
    await listAuditEvents({ scope: { all: true } }, f.env);
    expect(f.sql()).not.toContain('WHERE');
  });

  it('a scoped reader is limited to the covered units (NULL units never match)', async () => {
    const f = fakeEnv();
    await listAuditEvents({ scope: { all: false, orgUnitUuids: [UNIT_A, UNIT_B] } }, f.env);
    expect(f.sql()).toContain('actor_org_unit_uuid = ANY($1::uuid[])');
    expect(f.sql()).not.toMatch(/IS NULL/i);
    expect(f.params()[0]).toEqual([UNIT_A, UNIT_B]);
  });

  it('a scoped reader with no units sees nothing and the database is not asked', async () => {
    const f = fakeEnv([[dbRow(1)]]);
    const page = await listAuditEvents({ scope: { all: false, orgUnitUuids: [] } }, f.env);
    expect(page).toEqual({ rows: [], nextCursor: null });
    expect(f.query).not.toHaveBeenCalled();
  });

  it('drops malformed unit ids from a scope instead of passing them to the uuid cast', async () => {
    const f = fakeEnv();
    await listAuditEvents({ scope: { all: false, orgUnitUuids: [UNIT_A, "x'; DROP TABLE audit_events;--"] } }, f.env);
    expect(f.params()[0]).toEqual([UNIT_A]);
    const none = fakeEnv();
    await listAuditEvents({ scope: { all: false, orgUnitUuids: ['nope'] } }, none.env);
    expect(none.query).not.toHaveBeenCalled();
  });
});

describe('auditScopeFor', () => {
  it('global audit.read -> all, without a query', async () => {
    expect(await auditScopeFor(FAKE_PRINCIPAL_ADMIN)).toEqual({ all: true });
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('scoped audit.read -> the units from the org tree', async () => {
    const p = makePrincipal({
      capabilities: ['template.use', 'audit.read'],
      scopes: { 'audit.read': { global: false, roots: [{ orgUnitUuid: UNIT_A, includeDescendants: true }] } },
    });
    const env = { query: vi.fn(async () => ({ rows: [{ uuid: UNIT_A }, { uuid: UNIT_B }] })), orgUnitsTable: 'public.org_units' };
    expect(await auditScopeFor(p, env)).toEqual({ all: false, orgUnitUuids: [UNIT_A, UNIT_B] });
  });

  it('without audit.read, or with no scope entry, nothing is covered', async () => {
    expect(await auditScopeFor(makePrincipal())).toEqual({ all: false, orgUnitUuids: [] });
    const noScope = makePrincipal({ capabilities: ['template.use', 'audit.read'], scopes: {} });
    expect(await auditScopeFor(noScope)).toEqual({ all: false, orgUnitUuids: [] });
  });

  it('a disabled principal is covered for nothing', async () => {
    const p = { ...FAKE_PRINCIPAL_ADMIN, disabled: true };
    expect(await auditScopeFor(p)).toEqual({ all: false, orgUnitUuids: [] });
  });
});

describe('listAuditEvents filters and paging', () => {
  it('turns every filter into a bound parameter, never into SQL text', async () => {
    const f = fakeEnv();
    const from = new Date('2026-10-01T00:00:00Z');
    const to = new Date('2026-10-05T00:00:00Z');
    await listAuditEvents(
      {
        scope: { all: true },
        cursor: '500',
        filters: {
          eventTypes: ['meeting.delete', "x'; DROP TABLE t;--"],
          actorUserId: "u1' OR '1'='1",
          entityId: ENTITY.toUpperCase(),
          outcome: 'denied',
          source: 'client',
          from,
          to,
        },
      },
      f.env,
    );
    const sql = f.sql();
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).not.toContain('OR \'1\'');
    expect(sql).not.toContain(ENTITY);
    for (const part of [
      'id < $1::bigint',
      'event_type = ANY($2::text[])',
      'actor_user_id = $3',
      '(entity_id = $4 OR secondary_entity_id = $4)',
      'outcome = $5',
      'source = $6',
      'occurred_at >= $7',
      'occurred_at <= $8',
      'ORDER BY id DESC',
      'LIMIT $9',
    ]) {
      expect(sql).toContain(part);
    }
    expect(f.params()).toEqual([
      '500',
      ['meeting.delete', "x'; DROP TABLE t;--"],
      "u1' OR '1'='1",
      ENTITY,
      'denied',
      'client',
      from,
      to,
      51,
    ]);
  });

  it('lists an explicit column set, not SELECT *', async () => {
    const f = fakeEnv();
    await listAuditEvents({ scope: { all: true } }, f.env);
    expect(f.sql()).not.toMatch(/SELECT\s+\*/);
  });

  it('asks for one extra row to know whether there is a next page, and returns the last shown id as cursor', async () => {
    const f = fakeEnv([[dbRow(30), dbRow(29), dbRow(28)]]);
    const page = await listAuditEvents({ scope: { all: true }, limit: 2 }, f.env);
    expect(f.params().at(-1)).toBe(3);
    expect(page.rows.map((r) => r.id)).toEqual(['30', '29']);
    expect(page.nextCursor).toBe('29');
  });

  it('has no cursor on the last page', async () => {
    const f = fakeEnv([[dbRow(2), dbRow(1)]]);
    const page = await listAuditEvents({ scope: { all: true }, limit: 2 }, f.env);
    expect(page.nextCursor).toBeNull();
  });

  it('caps the page size at 100 and defaults to 50', async () => {
    const a = fakeEnv();
    await listAuditEvents({ scope: { all: true }, limit: 5000 }, a.env);
    expect(a.params().at(-1)).toBe(MAX_PAGE_SIZE + 1);
    const b = fakeEnv();
    await listAuditEvents({ scope: { all: true } }, b.env);
    expect(b.params().at(-1)).toBe(51);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects limit %s', async (limit) => {
    await expect(listAuditEvents({ scope: { all: true }, limit }, fakeEnv().env)).rejects.toThrow(RangeError);
  });

  it.each(['abc', '1; DROP', '-5', '', '9'.repeat(30)])('rejects cursor %j', async (cursor) => {
    const f = fakeEnv();
    await expect(listAuditEvents({ scope: { all: true }, cursor }, f.env)).rejects.toThrow(RangeError);
    expect(f.query).not.toHaveBeenCalled();
  });

  it('rejects a malformed entity id', async () => {
    await expect(listAuditEvents({ scope: { all: true }, filters: { entityId: 'x' } }, fakeEnv().env)).rejects.toThrow(RangeError);
  });

  it('refuses a table name that is not a plain identifier', async () => {
    const f = fakeEnv();
    f.env.table = 'public.audit_events; DROP TABLE x';
    await expect(listAuditEvents({ scope: { all: true } }, f.env)).rejects.toThrow('invalid table');
  });

  it('maps rows to camelCase and keeps ids as strings', async () => {
    const f = fakeEnv([[dbRow(9007199254740993)]]);
    const { rows } = await listAuditEvents({ scope: { all: true } }, f.env);
    expect(rows[0]).toMatchObject({ actorName: 'Anne', eventType: 'export.download', entityId: ENTITY, details: { format: 'pdf' } });
    expect(typeof rows[0].id).toBe('string');
  });

  it('uses the app pool by default', async () => {
    poolQuery.mockResolvedValue({ rows: [dbRow(1)] });
    const page = await listAuditEvents({ scope: { all: true } });
    expect(page.rows).toHaveLength(1);
    expect(String(poolQuery.mock.calls[0][0])).toContain('public.audit_events');
  });
});

describe('collectAuditEvents', () => {
  it('pages through the result up to the cap and flags truncation', async () => {
    const f = fakeEnv([[dbRow(5), dbRow(4), dbRow(3)], [dbRow(2)]]);
    // maxRows 2: first batch asks for 2 (+1 look-ahead); the cap is reached with more rows left.
    const r = await collectAuditEvents({ scope: { all: true }, maxRows: 2 }, f.env);
    expect(r.rows.map((x) => x.id)).toEqual(['5', '4']);
    expect(r.truncated).toBe(true);
  });

  it('is not truncated when the result fits exactly', async () => {
    const f = fakeEnv([[dbRow(2), dbRow(1)], []]);
    const r = await collectAuditEvents({ scope: { all: true }, maxRows: 2 }, f.env);
    expect(r.rows).toHaveLength(2);
    expect(r.truncated).toBe(false);
  });

  it('is not truncated when the result is smaller than the cap', async () => {
    const f = fakeEnv([[dbRow(1)]]);
    const r = await collectAuditEvents({ scope: { all: true }, maxRows: 10 }, f.env);
    expect(r).toMatchObject({ truncated: false });
    expect(r.rows).toHaveLength(1);
  });

  it('returns nothing for a scoped reader with no units', async () => {
    const f = fakeEnv([[dbRow(1)]]);
    expect(await collectAuditEvents({ scope: { all: false, orgUnitUuids: [] }, maxRows: 10 }, f.env)).toEqual({ rows: [], truncated: false });
  });
});

describe('feed queries', () => {
  it('head: parameterised delay, ids below the first still-young row', async () => {
    const f = fakeEnv([[{ head: '42' }]]);
    expect(await getFeedHead(10, f.env)).toBe(42);
    expect(f.params()).toEqual([10]);
    expect(f.sql()).toContain('occurred_at >= now() - make_interval(secs => $1::double precision)');
    expect(f.sql()).toContain('id <');
  });

  it('head is 0 for an empty log', async () => {
    expect(await getFeedHead(10, fakeEnv([[{ head: null }]]).env)).toBe(0);
  });

  it('page: ascending, after the offset, below the same bound, size capped', async () => {
    const f = fakeEnv([[dbRow(11), dbRow(12)]]);
    const page = await getFeedPage({ offset: 10, size: 99999, delaySeconds: 10 }, f.env);
    expect(f.params()).toEqual([10, '10', MAX_FEED_SIZE]);
    expect(f.sql()).toContain('id > $2::bigint');
    expect(f.sql()).toContain('ORDER BY id ASC');
    expect(page.rows.map((r) => r.id)).toEqual(['11', '12']);
    expect(page.next).toBe(12);
  });

  it('page: next stays at the offset when nothing is new', async () => {
    const page = await getFeedPage({ offset: 77, size: 10, delaySeconds: 10 }, fakeEnv([[]]).env);
    expect(page).toEqual({ rows: [], next: 77 });
  });

  it.each([-1, 1.5, Number.NaN])('rejects offset %s', async (offset) => {
    await expect(getFeedPage({ offset, size: 10, delaySeconds: 10 }, fakeEnv().env)).rejects.toThrow(RangeError);
  });

  it.each([0, -3, 2.5])('rejects size %s', async (size) => {
    await expect(getFeedPage({ offset: 0, size, delaySeconds: 10 }, fakeEnv().env)).rejects.toThrow(RangeError);
  });
});
