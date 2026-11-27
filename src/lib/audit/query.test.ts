import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolQuery = vi.fn();
vi.mock('@/lib/db', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...a) } }));

import {
  MAX_PAGE_SIZE,
  collectAuditEvents,
  likeContains,
  listAuditEvents,
  type AuditQueryEnv,
} from './query';
import { EVENT_TYPES } from './events';

const UNIT_A = 'aaaa0000-0000-4000-8000-00000000000a';
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

describe('listAuditEvents filters and paging', () => {
  it('turns every filter into a bound parameter, never into SQL text', async () => {
    const f = fakeEnv();
    const from = new Date('2026-10-01T00:00:00Z');
    const to = new Date('2026-10-05T00:00:00Z');
    await listAuditEvents(
      {
        cursor: '500',
        filters: {
          eventTypes: ['meeting.delete', "x'; DROP TABLE t;--"],
          actorUserId: "u1' OR '1'='1",
          entityId: ENTITY.toUpperCase(),
          outcome: 'denied',
          source: 'client',
          from,
          to,
          q: 'Mette_%',
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
      '(actor_name ILIKE $9 OR actor_user_id = $10)',
      'event_type = ANY($11::text[])',
      'ORDER BY id DESC',
      'LIMIT $12',
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
      '%Mette\\_\\%%',
      'Mette_%',
      EVENT_TYPES,
      51,
    ]);
  });

  describe('name search (q)', () => {
    it('escapes backslash, % and _ so they match themselves', () => {
      expect(likeContains('50%_off\\')).toBe('%50\\%\\_off\\\\%');
      expect(likeContains('Anne')).toBe('%Anne%');
    });

    it('is bound as parameters: an ILIKE on the name snapshot OR an exact user id', async () => {
      const f = fakeEnv();
      await listAuditEvents({ filters: { q: "Anne' OR '1'='1" } }, f.env);
      expect(f.sql()).not.toContain("'1'='1");
      expect(f.sql()).toContain('(actor_name ILIKE $1 OR actor_user_id = $2)');
      expect(f.params().slice(0, 2)).toEqual(["%Anne' OR '1'='1%", "Anne' OR '1'='1"]);
    });

    it('is also applied by the export collector', async () => {
      const f = fakeEnv([[dbRow(1)]]);
      await collectAuditEvents({ filters: { q: 'Anne' }, maxRows: 10 }, f.env);
      expect(f.sql()).toContain('actor_name ILIKE');
    });
  });

  describe('catalogue restriction', () => {
    it('lists and exports unknown types too (shown as unknown), but hides the removed access.* events', async () => {
      const f = fakeEnv();
      await listAuditEvents({}, f.env);
      expect(f.sql()).toContain("(event_type = ANY($1::text[]) OR event_type NOT LIKE 'access.%')");
      expect(f.params()[0]).toEqual(EVENT_TYPES);
      const g = fakeEnv([[]]);
      await collectAuditEvents({ maxRows: 10 }, g.env);
      expect(g.sql()).toContain("OR event_type NOT LIKE 'access.%'");
    });
  });

  it('lists an explicit column set, not SELECT *', async () => {
    const f = fakeEnv();
    await listAuditEvents({}, f.env);
    expect(f.sql()).not.toMatch(/SELECT\s+\*/);
  });

  it('asks for one extra row to know whether there is a next page, and returns the last shown id as cursor', async () => {
    const f = fakeEnv([[dbRow(30), dbRow(29), dbRow(28)]]);
    const page = await listAuditEvents({ limit: 2 }, f.env);
    expect(f.params().at(-1)).toBe(3);
    expect(page.rows.map((r) => r.id)).toEqual(['30', '29']);
    expect(page.nextCursor).toBe('29');
  });

  it('has no cursor on the last page', async () => {
    const f = fakeEnv([[dbRow(2), dbRow(1)]]);
    const page = await listAuditEvents({ limit: 2 }, f.env);
    expect(page.nextCursor).toBeNull();
  });

  it('caps the page size at 100 and defaults to 50', async () => {
    const a = fakeEnv();
    await listAuditEvents({ limit: 5000 }, a.env);
    expect(a.params().at(-1)).toBe(MAX_PAGE_SIZE + 1);
    const b = fakeEnv();
    await listAuditEvents({}, b.env);
    expect(b.params().at(-1)).toBe(51);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects limit %s', async (limit) => {
    await expect(listAuditEvents({ limit }, fakeEnv().env)).rejects.toThrow(RangeError);
  });

  it.each(['abc', '1; DROP', '-5', '', '9'.repeat(30)])('rejects cursor %j', async (cursor) => {
    const f = fakeEnv();
    await expect(listAuditEvents({ cursor }, f.env)).rejects.toThrow(RangeError);
    expect(f.query).not.toHaveBeenCalled();
  });

  it('rejects a malformed entity id', async () => {
    await expect(listAuditEvents({ filters: { entityId: 'x' } }, fakeEnv().env)).rejects.toThrow(RangeError);
  });

  it('refuses a table name that is not a plain identifier', async () => {
    const f = fakeEnv();
    f.env.table = 'public.audit_events; DROP TABLE x';
    await expect(listAuditEvents({}, f.env)).rejects.toThrow('invalid table');
  });

  it('maps rows to camelCase and keeps ids as strings', async () => {
    const f = fakeEnv([[dbRow(9007199254740993)]]);
    const { rows } = await listAuditEvents({}, f.env);
    expect(rows[0]).toMatchObject({ actorName: 'Anne', eventType: 'export.download', entityId: ENTITY, details: { format: 'pdf' } });
    expect(typeof rows[0].id).toBe('string');
  });

  it('uses the app pool by default', async () => {
    poolQuery.mockResolvedValue({ rows: [dbRow(1)] });
    const page = await listAuditEvents({});
    expect(page.rows).toHaveLength(1);
    expect(String(poolQuery.mock.calls[0][0])).toContain('public.audit_events');
  });
});

describe('collectAuditEvents', () => {
  it('pages through the result up to the cap and flags truncation', async () => {
    const f = fakeEnv([[dbRow(5), dbRow(4), dbRow(3)], [dbRow(2)]]);
    // maxRows 2: first batch asks for 2 (+1 look-ahead); the cap is reached with more rows left.
    const r = await collectAuditEvents({ maxRows: 2 }, f.env);
    expect(r.rows.map((x) => x.id)).toEqual(['5', '4']);
    expect(r.truncated).toBe(true);
  });

  it('is not truncated when the result fits exactly', async () => {
    const f = fakeEnv([[dbRow(2), dbRow(1)], []]);
    const r = await collectAuditEvents({ maxRows: 2 }, f.env);
    expect(r.rows).toHaveLength(2);
    expect(r.truncated).toBe(false);
  });

  it('is not truncated when the result is smaller than the cap', async () => {
    const f = fakeEnv([[dbRow(1)]]);
    const r = await collectAuditEvents({ maxRows: 10 }, f.env);
    expect(r).toMatchObject({ truncated: false });
    expect(r.rows).toHaveLength(1);
  });
});
