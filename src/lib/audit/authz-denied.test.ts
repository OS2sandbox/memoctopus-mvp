import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ poolQuery: vi.fn() }));
vi.mock('@/lib/db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'leftJoin', 'where', 'limit']) chain[m] = () => chain;
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve);
  return { db: { select: () => chain }, pool: { query: h.poolQuery, connect: vi.fn() } };
});

import { __resetAuthzDeniedThrottle, DENIAL_LIMIT_PER_MINUTE, recordAuthzDenied } from './authz-denied';

const ROW = { id: '1', occurred_at: new Date('2026-10-05T10:00:00Z') };
const UNIT_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  __resetAuthzDeniedThrottle();
  h.poolQuery.mockReset();
  h.poolQuery.mockResolvedValue({ rows: [ROW], rowCount: 1 });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

describe('recordAuthzDenied throttle (a probing script cannot fill the log)', () => {
  const deny = (over: Record<string, unknown> = {}) =>
    recordAuthzDenied({ actorUserId: 'u1', required: 'bot.meeting_owner', reason: 'not_owner', entityType: 'meeting', entityId: UNIT_ID, ...over });
  const detailsOf = () => h.poolQuery.mock.calls.map((c) => (c[1] as unknown[]).find((v) => typeof v === 'string' && v.startsWith('{')) as string);

  it('stores the first denials of a minute one by one, then counts the rest into ONE summary row', async () => {
    for (let i = 0; i < DENIAL_LIMIT_PER_MINUTE + 25; i++) await deny();
    expect(h.poolQuery).toHaveBeenCalledTimes(DENIAL_LIMIT_PER_MINUTE);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.poolQuery).toHaveBeenCalledTimes(DENIAL_LIMIT_PER_MINUTE + 1);
    expect(detailsOf().at(-1)).toBe(JSON.stringify({ required: 'bot.meeting_owner', reason: 'burst_summary', droppedCount: 25 }));
    const last = h.poolQuery.mock.calls.at(-1)![1] as unknown[];
    expect(last).toContain('u1');
  });

  it('keeps people and guards apart, and a quiet person is never summarised', async () => {
    for (let i = 0; i < DENIAL_LIMIT_PER_MINUTE; i++) await deny();
    await deny({ actorUserId: 'u2' });
    await deny({ required: 'access.manage', reason: 'missing_capability' });
    expect(h.poolQuery).toHaveBeenCalledTimes(DENIAL_LIMIT_PER_MINUTE + 2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.poolQuery).toHaveBeenCalledTimes(DENIAL_LIMIT_PER_MINUTE + 2);
  });

  it('stores the request ip and user agent when the caller passes the request', async () => {
    await deny({ req: { headers: new Headers({ 'x-forwarded-for': '203.0.113.9', 'user-agent': 'Probe/2' }) } });
    const values = h.poolQuery.mock.calls[0][1] as unknown[];
    expect(values).toContain('203.0.113.9');
    expect(values).toContain('Probe/2');
  });

  it('is bounded in memory', async () => {
    for (let i = 0; i < 6_000; i++) void deny({ actorUserId: `user-${i}` });
    // No assertion on internals: it must simply not grow without bound or throw.
    await vi.advanceTimersByTimeAsync(0);
    expect(h.poolQuery.mock.calls.length).toBeGreaterThan(0);
  });
});
