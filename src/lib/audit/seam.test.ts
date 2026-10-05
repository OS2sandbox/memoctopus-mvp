import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// src/test/setup.ts stubs the seam for every test file; this file tests the real one.
vi.unmock('@/lib/audit/seam');

const h = vi.hoisted(() => ({ poolQuery: vi.fn() }));
vi.mock('@/lib/db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'leftJoin', 'where', 'limit']) chain[m] = () => chain;
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve);
  return { db: { select: () => chain }, pool: { query: h.poolQuery, connect: vi.fn() } };
});

import { recordAdminAction, recordAuthzDenied } from './seam';

const ROW = { id: '1', occurred_at: new Date('2026-10-05T10:00:00Z') };
const ROLE_ID = '11111111-1111-4111-8111-111111111111';
const DIR_ID = '22222222-2222-4222-8222-222222222222';
const UNIT_ID = '33333333-3333-4333-8333-333333333333';

function fakeTx(rows: unknown[] = [ROW]) {
  return { query: vi.fn(async (..._a: unknown[]) => ({ rows, rowCount: rows.length }) as never) };
}

beforeEach(() => {
  h.poolQuery.mockReset();
  h.poolQuery.mockResolvedValue({ rows: [ROW], rowCount: 1 });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('recordAdminAction (phase 1 seam, now persisted)', () => {
  it('inserts the audit row on the SAME transaction handle it is given', async () => {
    const tx = fakeTx();
    await expect(
      recordAdminAction(tx, {
        type: 'access.role_assign',
        actorUserId: 'u1',
        entityType: 'role_assignment',
        entityId: ROLE_ID,
        secondaryEntityType: 'directory_user',
        secondaryEntityId: DIR_ID,
        details: { roleKey: 'tt-logleser', scopeOrgUnitUuid: UNIT_ID, includeDescendants: true },
      }),
    ).resolves.toBeUndefined();

    expect(tx.query).toHaveBeenCalledOnce();
    expect(h.poolQuery).not.toHaveBeenCalled();
    const [sql, values] = tx.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO public.audit_events');
    expect(values).toContain('access.role_assign');
    expect(values).toContain(ROLE_ID);
    expect(values).toContain(DIR_ID);
    expect(values).toContain(JSON.stringify({ roleKey: 'tt-logleser', scopeOrgUnitUuid: UNIT_ID, includeDescendants: true }));
  });

  it('accepts events without details and with a null scope (the existing call sites)', async () => {
    const tx = fakeTx();
    await recordAdminAction(tx, { type: 'access.org_unit_delete', actorUserId: 'u1', entityType: 'org_unit', entityId: UNIT_ID });
    await recordAdminAction(tx, {
      type: 'access.role_revoke',
      actorUserId: 'u1',
      entityType: 'role_assignment',
      entityId: ROLE_ID,
      details: { roleKey: 'tt-administrator', scopeOrgUnitUuid: null },
    });
    expect(tx.query).toHaveBeenCalledTimes(2);
  });

  it('THROWS when the event is invalid, so the admin change rolls back', async () => {
    const tx = fakeTx();
    await expect(
      recordAdminAction(tx, {
        type: 'access.role_assign',
        actorUserId: 'u1',
        entityType: 'role_assignment',
        entityId: 'r1', // not a uuid
        details: { roleKey: 'tt-logleser' },
      }),
    ).rejects.toMatchObject({ name: 'AuditWriteError', code: 'invalid_entity_id' });
    expect(tx.query).not.toHaveBeenCalled();
  });

  it('THROWS when free text sneaks into details', async () => {
    const tx = fakeTx();
    await expect(
      recordAdminAction(tx, {
        type: 'access.user_create',
        actorUserId: 'u1',
        entityType: 'directory_user',
        entityId: DIR_ID,
        details: { source: 'Jens Jensen' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_details' });
  });

  it('THROWS when the insert fails and when the handle is not a transaction', async () => {
    const boom = new Error('deadlock detected');
    const failing = {
      query: vi.fn(async () => {
        throw boom;
      }),
    };
    const event = { type: 'access.org_unit_delete', actorUserId: 'u1', entityType: 'org_unit', entityId: UNIT_ID } as const;
    await expect(recordAdminAction(failing, event)).rejects.toBe(boom);
    await expect(recordAdminAction({}, event)).rejects.toMatchObject({ code: 'invalid_tx' });
    await expect(recordAdminAction(undefined, event)).rejects.toMatchObject({ code: 'invalid_tx' });
  });
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
