import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ poolQuery: vi.fn() }));
vi.mock('@/lib/db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'leftJoin', 'where', 'limit']) chain[m] = () => chain;
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve);
  return { db: { select: () => chain }, pool: { query: h.poolQuery, connect: vi.fn() } };
});

import { recordAuthzDenied } from './authz-denied';

const ROW = { id: '1', occurred_at: new Date('2026-10-05T10:00:00Z') };
const UNIT_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  h.poolQuery.mockReset();
  h.poolQuery.mockResolvedValue({ rows: [ROW], rowCount: 1 });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('recordAuthzDenied (best-effort)', () => {
  it('records a denial on the pool with outcome denied', async () => {
    await recordAuthzDenied({ actorUserId: 'u1', required: 'access.manage', reason: 'missing_capability' });
    expect(h.poolQuery).toHaveBeenCalledOnce();
    const [sql, values] = h.poolQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO public.audit_events');
    expect(values).toEqual(expect.arrayContaining(['authz.denied', 'denied', 'u1']));
    expect(values).toContain(JSON.stringify({ required: 'access.manage', reason: 'missing_capability' }));
  });

  it('never throws or rejects, even when the database is down', async () => {
    h.poolQuery.mockRejectedValue(new Error('down'));
    expect(() => recordAuthzDenied({ actorUserId: null, required: 'login', reason: 'disabled' })).not.toThrow();
    await expect(recordAuthzDenied({ actorUserId: null, required: 'login', reason: 'disabled' })).resolves.toBeUndefined();
  });

  it('records a resource denial with the entity when it is a uuid', async () => {
    await recordAuthzDenied({ actorUserId: 'u1', required: 'directory.read', reason: 'out_of_scope', entityType: 'org_unit', entityId: UNIT_ID });
    const values = h.poolQuery.mock.calls[0][1] as unknown[];
    expect(values).toEqual(expect.arrayContaining(['org_unit', UNIT_ID]));
  });

  it('keeps the denial but drops an unusable entity reference instead of losing the event', async () => {
    await recordAuthzDenied({ actorUserId: 'u1', required: 'sync.run', reason: 'out_of_scope', entityType: 'org_unit', entityId: 'x1' });
    expect(h.poolQuery).toHaveBeenCalledOnce();
    const values = h.poolQuery.mock.calls[0][1] as unknown[];
    expect(values).not.toContain('x1');
    expect(values).not.toContain('org_unit');
  });

  it('replaces an unusable required/reason with a code rather than dropping the denial', async () => {
    await recordAuthzDenied({ actorUserId: 'u1', required: 'Vi skal tale om sagen', reason: 'x' });
    const values = h.poolQuery.mock.calls[0][1] as unknown[];
    expect(values).toContain(JSON.stringify({ required: 'invalid', reason: 'x' }));
  });
});
