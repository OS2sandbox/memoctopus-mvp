import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ pool: {}, db: {} }));
vi.mock('@/lib/audit/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit/record')>()),
  recordEvent: vi.fn(async () => ({ status: 'stored' })),
}));

import { makeFakeSyncEnv, type FakeReply } from '@/test/fake-sync-env';
import { recordEvent } from '@/lib/audit/record';
import { createRollekatalogClient } from './client';
import { mapToMirror, type MapperConfig, type MapperInput, type MirrorSet } from './mapper';
import { fixtureData, startMockRollekatalog, type MockRollekatalog } from './mock-server';
import { organisationSchema, roleAssignmentsSchema } from './schemas';
import {
  exceedsRemovalThreshold,
  planMirror,
  runSync,
  type ExistingMirror,
  type SyncDeps,
} from './sync';
import { parseCounts, tbl, type SyncEnv } from './sync-run';

const U = (n: number) => `7e5e0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const O = (n: number) => `5a1b0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const E = (n: number) => `9d3c0000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const DEFAULTS: MapperConfig = { includeDescendants: true, globalRoles: ['admin'] };

function fixtureMirror(): MirrorSet {
  const d = fixtureData();
  const input: MapperInput = {
    organisation: organisationSchema.parse({ users: d.users, orgUnits: d.orgUnits }),
    assignments: roleAssignmentsSchema.parse(d.roleAssignments),
  };
  return mapToMirror(input, DEFAULTS);
}

const EMPTY: ExistingMirror = { users: [], orgUnits: [], assignments: [], members: [], extHolders: [] };

/** What the mirror holds after applying `mirror` to nothing: lets a test change one thing and re-plan. */
function existingFrom(mirror: MirrorSet): ExistingMirror {
  return {
    users: mirror.users.map((u) => ({ ...u })),
    orgUnits: mirror.orgUnits.map((u) => ({ ...u })),
    assignments: mirror.assignments.map((a, i) => ({
      id: `a${i}`,
      directoryUserUuid: a.directoryUserUuid,
      roleKey: a.roleKey,
      scopeOrgUnitUuid: a.scopeOrgUnitUuid,
      includeDescendants: a.includeDescendants,
    })),
    members: mirror.members.map((m) => ({ ...m })),
    extHolders: [],
  };
}

describe('exceedsRemovalThreshold', () => {
  it.each([
    // removed, base, percent, expected
    [0, 0, 30, false],
    [5, 0, 30, false], // nothing there to lose
    [0, 10, 0, false],
    [1, 10, 0, true],
    [3, 10, 30, false], // exactly the limit is allowed
    [4, 10, 30, true],
    [1, 3, 30, true],
    [10, 10, 100, false],
    [10, 10, 99, true],
    [1, 1000, 30, false],
  ])('removed=%i base=%i percent=%i -> %s', (removed, base, percent, expected) => {
    expect(exceedsRemovalThreshold(removed, base, percent)).toBe(expected);
  });
});

describe('planMirror', () => {
  it('a first sync inserts everything and removes nothing', () => {
    const plan = planMirror(EMPTY, fixtureMirror());
    expect(plan.users.insert).toHaveLength(9);
    expect(plan.users.update).toHaveLength(0);
    expect(plan.orgUnits.insert.map((u) => u.uuid)).toEqual([O(1), O(2), O(4), O(3), O(5)]); // parents first
    expect(plan.assignments.insert).toHaveLength(10);
    expect(plan.counts).toMatchObject({ usersUpserted: 9, orgUnitsUpserted: 5, assignmentsUpserted: 10, assignmentsRemoved: 0, usersDisabled: 0 });
    expect(plan.removal).toEqual({
      users: { removed: 0, base: 0 },
      assignments: { removed: 0, base: 0 },
      elevatedAssignments: { removed: 0, base: 0 },
    });
  });

  it('carries the invalid-row counts of the mapper into the plan counts', () => {
    const mirror = fixtureMirror();
    mirror.stats = { ...mirror.stats, usersSkippedInvalid: 2, orgUnitsSkippedInvalid: 1, assignmentRowsSkippedInvalid: 3, membershipsSkippedInvalid: 4 };
    expect(planMirror(EMPTY, mirror).counts).toMatchObject({
      usersSkippedInvalid: 2,
      orgUnitsSkippedInvalid: 1,
      assignmentRowsSkippedInvalid: 3,
      membershipsSkippedInvalid: 4,
    });
  });

  it('an unchanged mirror plans no writes at all and counts no changes', () => {
    const mirror = fixtureMirror();
    const plan = planMirror(existingFrom(mirror), mirror);
    expect(plan.users).toEqual({ insert: [], update: [], disable: [], releaseExt: [] });
    expect(plan.orgUnits).toEqual({ insert: [], update: [] });
    expect(plan.members).toEqual({ insert: [], remove: [] });
    expect(plan.assignments).toEqual({ insert: [], updateIncludeDescendants: [], remove: [] });
    expect(plan.counts).toMatchObject({ usersUpserted: 0, usersDisabled: 0, orgUnitsUpserted: 0, assignmentsUpserted: 0, assignmentsRemoved: 0 });
  });

  it('a user missing from the fetch is disabled once; one already disabled is not counted again', () => {
    const mirror = fixtureMirror();
    const existing = existingFrom(mirror);
    const gone = mirror.users.filter((u) => u.uuid === U(9) || u.uuid === U(5)).map((u) => u.uuid); // rune (enabled), sofie (disabled)
    const fetched: MirrorSet = { ...mirror, users: mirror.users.filter((u) => !gone.includes(u.uuid)) };
    const plan = planMirror(existing, fetched);
    expect(plan.users.disable).toEqual([U(9)]);
    expect(plan.counts.usersDisabled).toBe(1);
    expect(plan.removal.users).toEqual({ removed: 1, base: 8 });
  });

  it('a user that turns disabled upstream counts as one disabled user and one update', () => {
    const mirror = fixtureMirror();
    const fetched: MirrorSet = { ...mirror, users: mirror.users.map((u) => (u.uuid === U(7) ? { ...u, disabled: true } : u)) };
    const plan = planMirror(existingFrom(mirror), fetched);
    expect(plan.users.update.map((u) => u.uuid)).toEqual([U(7)]);
    expect(plan.counts).toMatchObject({ usersUpserted: 1, usersDisabled: 1 });
    expect(plan.removal.users.removed).toBe(1);
    // Re-enabling is an update but not a removal.
    const back = planMirror(existingFrom(fetched), mirror);
    expect(back.counts).toMatchObject({ usersUpserted: 1, usersDisabled: 0 });
    expect(back.removal.users.removed).toBe(0);
  });

  it('every changed user field is an update', () => {
    const mirror = fixtureMirror();
    for (const change of [{ name: 'Nyt' }, { email: null }, { extUserId: 'ny' }, { extUuid: E(77) }] as const) {
      const fetched: MirrorSet = { ...mirror, users: mirror.users.map((u) => (u.uuid === U(1) ? { ...u, ...change } : u)) };
      expect(planMirror(existingFrom(mirror), fetched).users.update.map((u) => u.uuid)).toEqual([U(1)]);
    }
  });

  it('org units: a changed name or parent is an update; units missing from the fetch are never planned for deletion', () => {
    const mirror = fixtureMirror();
    for (const change of [{ name: 'Nyt' }, { parentUuid: O(4) }] as const) {
      const fetched: MirrorSet = { ...mirror, orgUnits: mirror.orgUnits.map((u) => (u.uuid === O(1) ? { ...u, ...change } : u)) };
      expect(planMirror(existingFrom(mirror), fetched).orgUnits.update.map((u) => u.uuid)).toEqual([O(1)]);
    }
    const fewer: MirrorSet = { ...mirror, orgUnits: mirror.orgUnits.filter((u) => u.uuid !== O(4)) };
    const plan = planMirror(existingFrom(mirror), fewer);
    expect(plan.orgUnits).toEqual({ insert: [], update: [] });
  });

  it('assignments: new rows insert, vanished rows are removed, a flipped descendants flag updates in place', () => {
    const mirror = fixtureMirror();
    const existing = existingFrom(mirror);
    const [first, second, ...rest] = mirror.assignments;
    const fetched: MirrorSet = {
      ...mirror,
      assignments: [
        ...rest,
        { ...second, includeDescendants: !second.includeDescendants },
        { directoryUserUuid: U(7), roleKey: 'bruger', scopeOrgUnitUuid: null, includeDescendants: true },
      ],
    };
    const plan = planMirror(existing, fetched);
    expect(plan.assignments.remove).toEqual(['a0']); // `first` is gone
    expect(plan.assignments.updateIncludeDescendants).toEqual([{ id: 'a1', includeDescendants: !second.includeDescendants }]);
    expect(plan.assignments.insert).toHaveLength(1);
    expect(plan.counts).toMatchObject({ assignmentsUpserted: 2, assignmentsRemoved: 1 });
    expect(first).toBeDefined();
    expect(plan.removal.assignments).toEqual({ removed: 1, base: 10 });
    // `first` is an elevated row (the fixture has 7 elevated rows and 3 bruger rows).
    expect(plan.removal.elevatedAssignments).toEqual({ removed: first.roleKey === 'bruger' ? 0 : 1, base: 7 });
  });

  it('elevated removals are counted apart from bruger rows (the baseline dominates the total)', () => {
    const mirror = fixtureMirror();
    const existing = existingFrom(mirror);
    const elevated = mirror.assignments.filter((a) => a.roleKey !== 'bruger');
    const bruger = mirror.assignments.filter((a) => a.roleKey === 'bruger');
    expect(elevated).toHaveLength(7);
    // Three elevated rows vanish: 3/10 overall is exactly the 30 % limit, 3/7 elevated is over it.
    const fetched: MirrorSet = { ...mirror, assignments: [...bruger, ...elevated.slice(3)] };
    const plan = planMirror(existing, fetched);
    expect(plan.removal.assignments).toEqual({ removed: 3, base: 10 });
    expect(plan.removal.elevatedAssignments).toEqual({ removed: 3, base: 7 });
    expect(exceedsRemovalThreshold(3, 10, 30)).toBe(false);
    expect(exceedsRemovalThreshold(3, 7, 30)).toBe(true);
    // Losing only baseline rows never touches the elevated ratio.
    const noBruger = planMirror(existing, { ...mirror, assignments: elevated });
    expect(noBruger.removal.elevatedAssignments).toEqual({ removed: 0, base: 7 });
  });

  it('small elevated base: one removed row of one or two trips, an empty base never does', () => {
    expect(exceedsRemovalThreshold(1, 1, 30)).toBe(true);
    expect(exceedsRemovalThreshold(1, 2, 30)).toBe(true);
    expect(exceedsRemovalThreshold(0, 2, 30)).toBe(false);
    expect(exceedsRemovalThreshold(2, 0, 30)).toBe(false);
    const adminRow = { id: 'x', directoryUserUuid: U(1), roleKey: 'admin', scopeOrgUnitUuid: null, includeDescendants: true };
    const plan = planMirror({ ...EMPTY, assignments: [adminRow] }, { ...fixtureMirror(), assignments: [] });
    expect(plan.removal.elevatedAssignments).toEqual({ removed: 1, base: 1 });
  });

  it('a NULL scope and a real scope of the same role are different rows', () => {
    const base = { directoryUserUuid: U(7), roleKey: 'bygger' as const, includeDescendants: true };
    const mirror: MirrorSet = { ...fixtureMirror(), assignments: [{ ...base, scopeOrgUnitUuid: null }] };
    const existing: ExistingMirror = {
      ...EMPTY,
      assignments: [{ id: 'x', directoryUserUuid: U(7), roleKey: 'bygger', scopeOrgUnitUuid: O(1), includeDescendants: true }],
    };
    const plan = planMirror(existing, mirror);
    expect(plan.assignments.insert).toHaveLength(1);
    expect(plan.assignments.remove).toEqual(['x']);
  });

  it('members are diffed in both directions', () => {
    const mirror = fixtureMirror();
    const existing = existingFrom(mirror);
    existing.members.push({ directoryUserUuid: U(1), orgUnitUuid: O(5) }); // stale
    const fetched: MirrorSet = { ...mirror, members: mirror.members.slice(1) };
    const plan = planMirror(existing, fetched);
    expect(plan.members.remove).toEqual(expect.arrayContaining([mirror.members[0], { directoryUserUuid: U(1), orgUnitUuid: O(5) }]));
    expect(plan.members.remove).toHaveLength(2);
    expect(plan.members.insert).toHaveLength(0);
  });

  describe('ext_uuid ownership', () => {
    it('a local row holding the value keeps it and the fetched user goes without', () => {
      const mirror = fixtureMirror();
      const existing: ExistingMirror = { ...EMPTY, extHolders: [{ uuid: 'local-1', extUuid: E(1), source: 'local' }] };
      const plan = planMirror(existing, mirror);
      expect(plan.users.insert.find((u) => u.uuid === U(1))?.extUuid).toBeNull();
      expect(plan.users.releaseExt).toEqual([]);
    });

    it('a rollekatalog row under another uuid releases it', () => {
      const mirror = fixtureMirror();
      const old = { uuid: 'old-uuid', extUuid: E(1), source: 'rollekatalog' };
      const plan = planMirror({ ...EMPTY, extHolders: [old] }, mirror);
      expect(plan.users.releaseExt).toEqual(['old-uuid']);
      expect(plan.users.insert.find((u) => u.uuid === U(1))?.extUuid).toBe(E(1));
    });

    it('the row that legitimately owns it is left alone', () => {
      const mirror = fixtureMirror();
      const plan = planMirror({ ...existingFrom(mirror), extHolders: [{ uuid: U(1), extUuid: E(1), source: 'rollekatalog' }] }, mirror);
      expect(plan.users.releaseExt).toEqual([]);
      expect(plan.users.update).toEqual([]);
    });
  });

  it('does not mutate its inputs', () => {
    const mirror = fixtureMirror();
    const existing = existingFrom(mirror);
    const snapshot = JSON.stringify({ mirror, existing });
    planMirror(existing, { ...mirror, users: mirror.users.slice(2) });
    expect(JSON.stringify({ mirror, existing })).toBe(snapshot);
  });
});

describe('sync-run helpers', () => {
  it('parseCounts keeps only the known numeric counters', () => {
    expect(parseCounts(null)).toBeNull();
    expect(parseCounts([1, 2])).toBeNull();
    expect(parseCounts('x')).toBeNull();
    const counts = parseCounts({ usersUpserted: 4, assignmentsRemoved: 'x', extra: { cpr: '0000000000' }, usersDisabled: Infinity });
    expect(counts).toMatchObject({ usersUpserted: 4, assignmentsRemoved: 0, usersDisabled: 0 });
    expect(JSON.stringify(counts)).not.toContain('cpr');
  });

  it('parseCounts reads the invalid-row counters and defaults them to 0 for rows written before they existed', () => {
    expect(parseCounts({ usersSkippedInvalid: 2, orgUnitsSkippedInvalid: 1, assignmentRowsSkippedInvalid: 3, membershipsSkippedInvalid: 4 })).toMatchObject({
      usersSkippedInvalid: 2,
      orgUnitsSkippedInvalid: 1,
      assignmentRowsSkippedInvalid: 3,
      membershipsSkippedInvalid: 4,
    });
    expect(parseCounts({ usersUpserted: 1 })).toMatchObject({ usersSkippedInvalid: 0, assignmentRowsSkippedInvalid: 0 });
  });

  it('tbl qualifies with the schema and rejects anything that is not a plain identifier', () => {
    const env = (schema: string): SyncEnv => ({ schema, connect: async () => { throw new Error('unused'); } });
    expect(tbl(env('public'), 'org_units')).toBe('"public".org_units');
    expect(tbl(env('t_abc_123'), 'sync_runs')).toBe('"t_abc_123".sync_runs');
    for (const bad of ['', 'a"b', 'a;drop', 'a b', '1abc', 'a.b']) {
      expect(() => tbl(env(bad), 'org_units')).toThrow();
    }
  });
});

// ─── runSync against a scripted connection ─────────────────────────────────


const RUN_ID = '3f9a8c1e-0000-4000-8000-000000000001';
const ok = (row: Record<string, unknown>): FakeReply => ({ rows: [row], rowCount: 1 });

/** Replies for everything the run needs outside the apply transaction. */
function baseScript(over: (sql: string) => FakeReply = () => undefined) {
  return (sql: string): FakeReply => {
    const o = over(sql);
    if (o !== undefined) return o;
    if (sql.includes('pg_try_advisory_lock')) return ok({ ok: true });
    if (sql.includes('pg_advisory_unlock')) return ok({ ok: true });
    if (sql.includes('INSERT INTO "public".sync_runs')) return ok({ id: RUN_ID });
    return undefined;
  };
}

let mock: MockRollekatalog;
beforeAll(async () => {
  mock = await startMockRollekatalog();
});
afterAll(async () => {
  await mock.close();
});
beforeEach(() => {
  mock.resetData();
  mock.setFaults([]);
  mock.clearRequests();
  vi.stubEnv('ROLLEKATALOG_URL', mock.url);
  vi.stubEnv('ROLLEKATALOG_READ_API_KEY', mock.readKey);
  vi.stubEnv('ROLLEKATALOG_ORG_API_KEY', mock.orgKey);
  vi.mocked(recordEvent).mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const NOW = new Date('2026-10-05T10:00:00Z');
const deps = (env: SyncEnv, over: Partial<SyncDeps> = {}): SyncDeps => ({
  env,
  now: () => NOW,
  client: createRollekatalogClient({ backoffMs: 1, sleep: async () => {} }),
  ...over,
});

describe('runSync flow', () => {
  it('not configured: records a failed run with the code and does nothing else', async () => {
    vi.stubEnv('ROLLEKATALOG_URL', '');
    const f = makeFakeSyncEnv(baseScript());
    const r = await runSync({ trigger: 'cron' }, deps(f.env));
    expect(r).toMatchObject({ status: 'error', runId: RUN_ID, errorCode: 'not_configured' });
    expect(f.sqls()).toHaveLength(1);
    expect(f.sqls()[0]).toContain("'failed'");
    expect(f.log.some((l) => l.sql.includes('advisory'))).toBe(false);
    expect(mock.requests).toHaveLength(0);
  });

  it('a missing key is not configured too (the sync needs both)', async () => {
    vi.stubEnv('ROLLEKATALOG_ORG_API_KEY', '');
    const r = await runSync({ trigger: 'cron' }, deps(makeFakeSyncEnv(baseScript()).env));
    expect(r).toMatchObject({ status: 'error', errorCode: 'not_configured' });
  });

  it('never throws when even the database is down', async () => {
    const env: SyncEnv = { schema: 'public', connect: async () => { throw new Error('connect ECONNREFUSED secret-host'); } };
    const r = await runSync({ trigger: 'cron' }, deps(env));
    expect(r).toMatchObject({ status: 'error', errorCode: 'unexpected', runId: null });
    expect(JSON.stringify(r)).not.toContain('secret-host');
  });

  it('a held lock answers already_running before any row, fetch or write', async () => {
    const f = makeFakeSyncEnv(baseScript((s) => (s.includes('pg_try_advisory_lock') ? ok({ ok: false }) : undefined)));
    const r = await runSync({ trigger: 'manual', actorUserId: 'admin-1' }, deps(f.env));
    expect(r).toMatchObject({ status: 'already_running', runId: null, errorCode: 'already_running' });
    expect(f.sqls()).toHaveLength(1);
    expect(mock.requests).toHaveLength(0);
    expect(f.released).toEqual([{ conn: 1, destroy: false }]);
  });

  it('a failed fetch records the code, never opens a transaction, and still unlocks', async () => {
    mock.setFaults([{ match: '/api/organisation/v3', status: 503 }]);
    const f = makeFakeSyncEnv(baseScript());
    const r = await runSync({ trigger: 'cron' }, deps(f.env));
    expect(r).toMatchObject({ status: 'error', runId: RUN_ID, errorCode: 'server_error' });
    const sqls = f.sqls();
    expect(sqls.some((s) => s === 'BEGIN')).toBe(false);
    expect(sqls.some((s) => s.includes("SET status = $2") )).toBe(true);
    expect(sqls.at(-1)).toContain('pg_advisory_unlock');
    const finish = f.log.find((l) => l.sql.includes('SET status = $2'));
    expect(finish).toBeDefined();
  });

  it('an empty response aborts before the other endpoints are called', async () => {
    mock.setData({ orgUnits: [] });
    const f = makeFakeSyncEnv(baseScript());
    const r = await runSync({ trigger: 'cron' }, deps(f.env));
    expect(r).toMatchObject({ status: 'aborted', errorCode: 'empty_response' });
    expect(mock.requests.map((q) => q.path)).toEqual(['/api/organisation/v3']);
    expect(f.sqls().includes('BEGIN')).toBe(false);
  });

  describe('invalid rows', () => {
    const goodUser = (n: number, extra: Record<string, unknown> = {}) => ({
      uuid: `7e5e0000-0000-4000-8000-${String(900 + n).padStart(12, '0')}`,
      extUuid: null,
      userId: `extra${n}`,
      name: `Extra ${n}`,
      email: null,
      disabled: false,
      positions: [{ orgUnitUuid: O(1) }],
      ...extra,
    });

    it('one bad user id and one bad unit id: the run succeeds, the rest is mirrored, the counts flow to the run row', async () => {
      const base = fixtureData();
      mock.setData({
        users: [...base.users, goodUser(1, { uuid: 'LEGACY-USER' })],
        orgUnits: [...base.orgUnits, { uuid: 'LEGACY-UNIT', name: 'Gammel enhed', parentOrgUnitUuid: null }],
      });
      let finishParams: readonly unknown[] | undefined;
      const f = makeFakeSyncEnv(baseScript());
      const wrapped: SyncEnv = {
        schema: f.env.schema,
        connect: async () => {
          const c = await f.env.connect();
          return {
            ...c,
            query: (sql, params) => {
              if (sql.includes('SET status = $2')) finishParams = params;
              return c.query(sql, params);
            },
          };
        },
      };
      const r = await runSync({ trigger: 'cron' }, deps(wrapped));
      expect(r).toMatchObject({ status: 'success', errorCode: null });
      expect(r.counts).toMatchObject({
        usersUpserted: 9,
        orgUnitsUpserted: 5,
        usersSkippedInvalid: 1,
        orgUnitsSkippedInvalid: 1,
        assignmentRowsSkippedInvalid: 0,
        membershipsSkippedInvalid: 0,
      });
      expect(f.sqls()).toContain('COMMIT');
      // sync_runs.counts (jsonb) carries the new keys; nothing but counts.
      expect(JSON.parse(String(finishParams?.[3]))).toMatchObject({ usersSkippedInvalid: 1, orgUnitsSkippedInvalid: 1 });
      expect(JSON.stringify(finishParams)).not.toMatch(/LEGACY|Gammel/);
    });

    it('bad role assignment rows are counted too', async () => {
      const base = fixtureData();
      mock.setData({ roleAssignments: [...base.roleAssignments, 'junk', { userId: 5 }] });
      const r = await runSync({ trigger: 'cron' }, deps(makeFakeSyncEnv(baseScript()).env));
      expect(r).toMatchObject({ status: 'success' });
      expect(r.counts).toMatchObject({ assignmentRowsSkippedInvalid: 2, assignmentsUpserted: 10 });
    });

    it('more bad users than the allowance aborts as invalid_response before any transaction or write', async () => {
      const base = fixtureData();
      // 9 fixture users + 4 bad rows: allowance of 13 rows is max(3, 0) = 3.
      mock.setData({ users: [...base.users, ...[1, 2, 3, 4].map((n) => goodUser(n, { uuid: `legacy-${n}` }))] });
      const f = makeFakeSyncEnv(baseScript());
      const r = await runSync({ trigger: 'cron' }, deps(f.env));
      expect(r).toMatchObject({ status: 'error', errorCode: 'invalid_response', counts: expect.objectContaining({ usersSkippedInvalid: 0 }) });
      const sqls = f.sqls();
      expect(sqls).not.toContain('BEGIN');
      expect(sqls.some((q) => /^(INSERT INTO "public"\.(directory_users|org_units|role_assignments)|UPDATE|DELETE)/.test(q) && !q.includes('sync_runs'))).toBe(false);
      expect(mock.requests.map((q) => q.path)).toEqual(['/api/organisation/v3']);
      const finish = f.log.find((l) => l.sql.includes('SET status = $2'));
      expect(finish).toBeDefined();
    });

    it('more bad assignment rows than the allowance aborts before any transaction', async () => {
      mock.setData({ roleAssignments: [...fixtureData().roleAssignments, 'a', 'b', 'c', 'd'] });
      const f = makeFakeSyncEnv(baseScript());
      const r = await runSync({ trigger: 'cron' }, deps(f.env));
      expect(r).toMatchObject({ status: 'error', errorCode: 'invalid_response' });
      expect(f.sqls()).not.toContain('BEGIN');
    });
  });

  it('applies in ONE transaction on one connection and commits', async () => {
    const f = makeFakeSyncEnv(baseScript());
    const r = await runSync({ trigger: 'cron' }, deps(f.env));
    expect(r).toMatchObject({ status: 'success', runId: RUN_ID, errorCode: null });
    expect(r.counts).toMatchObject({ usersUpserted: 9, orgUnitsUpserted: 5, assignmentsUpserted: 10 });

    const sqls = f.sqls();
    const begin = sqls.indexOf('BEGIN');
    const commit = sqls.indexOf('COMMIT');
    expect(begin).toBeGreaterThan(0);
    expect(commit).toBeGreaterThan(begin);
    const txConn = f.log[begin].conn;
    expect(new Set(f.log.slice(begin, commit + 1).map((l) => l.conn))).toEqual(new Set([txConn]));
    // The lock connection is a different one and is the last thing released.
    const lockConn = f.log.find((l) => l.sql.includes('pg_try_advisory_lock'))!.conn;
    expect(lockConn).not.toBe(txConn);
    expect(f.log.at(-1)).toMatchObject({ conn: lockConn });
    expect(f.log.at(-1)!.sql).toContain('pg_advisory_unlock');
    // Writes only ever name source 'rollekatalog' rows, and no statement sets app_user_id.
    const writes = f.log
      .slice(begin, commit)
      .filter((l) => /^(INSERT|UPDATE|DELETE)/.test(l.sql) && !l.sql.startsWith('DELETE FROM "public".sessions'));
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.some((l) => /app_user_id/.test(l.sql))).toBe(false);
    expect(writes.every((l) => !/source = 'local'/.test(l.sql))).toBe(true);
  });

  it('revokes sessions of disabled linked rollekatalog users inside the transaction, after the user writes', async () => {
    const f = makeFakeSyncEnv(
      baseScript((s) => (s.startsWith('DELETE FROM "public".sessions') ? { rows: [], rowCount: 3 } : undefined)),
    );
    const r = await runSync({ trigger: 'cron' }, deps(f.env));
    expect(r).toMatchObject({ status: 'success' });
    expect(r.counts.sessionsRevoked).toBe(3);

    const sqls = f.sqls();
    const begin = sqls.indexOf('BEGIN');
    const commit = sqls.indexOf('COMMIT');
    const del = sqls.findIndex((s) => s.startsWith('DELETE FROM "public".sessions'));
    expect(del).toBeGreaterThan(begin);
    expect(del).toBeLessThan(commit);
    expect(sqls.filter((s) => s.startsWith('DELETE FROM "public".sessions'))).toHaveLength(1);
    const upsert = sqls.findIndex((s) => s.startsWith('INSERT INTO "public".directory_users'));
    expect(upsert).toBeGreaterThan(begin);
    expect(del).toBeGreaterThan(upsert);
    expect(f.log[del].conn).toBe(f.log[begin].conn);
    // Exactly the disabled, linked, rollekatalog-sourced users; never a local row.
    expect(sqls[del]).toBe(
      'DELETE FROM "public".sessions WHERE user_id IN ( SELECT app_user_id FROM "public".directory_users WHERE source = \'rollekatalog\' AND disabled = true AND app_user_id IS NOT NULL )',
    );
    // The count lands in the run row (counts only).
    const finish = f.log.find((l) => l.sql.includes('SET status = $2'));
    expect(finish).toBeDefined();
  });

  it('a failure after the session delete still rolls back (the delete is inside the transaction)', async () => {
    const f = makeFakeSyncEnv(
      baseScript((s) =>
        s.startsWith('DELETE FROM "public".sessions') ? Object.assign(new Error('boom'), { code: '40001' }) : undefined,
      ),
    );
    const r = await runSync({ trigger: 'cron' }, deps(f.env));
    expect(r).toMatchObject({ status: 'error', errorCode: 'db_error' });
    expect(r.counts.sessionsRevoked).toBe(0);
    expect(f.sqls()).toContain('ROLLBACK');
    expect(f.sqls()).not.toContain('COMMIT');
  });

  it('an aborted run (removal threshold) issues no session delete', async () => {
    const f = makeFakeSyncEnv(
      baseScript((s) => {
        // Existing mirror: 20 enabled users the fetch does not contain -> far over the threshold.
        if (s.includes('FROM "public".directory_users WHERE source = \'rollekatalog\'') && s.includes('ext_user_id')) {
          return {
            rows: Array.from({ length: 20 }, (_, i) => ({ uuid: U(1000 + i), ext_uuid: null, ext_user_id: null, name: `x${i}`, email: null, disabled: false })),
            rowCount: 20,
          };
        }
        return undefined;
      }),
    );
    const r = await runSync({ trigger: 'cron' }, deps(f.env));
    expect(r).toMatchObject({ status: 'aborted', errorCode: 'removal_threshold' });
    expect(f.sqls().some((s) => s.startsWith('DELETE FROM "public".sessions'))).toBe(false);
    expect(f.sqls()).toContain('ROLLBACK');
  });

  it('a failing statement rolls back, reports db_error, and never leaks the database message', async () => {
    let inserted = 0;
    const f = makeFakeSyncEnv(
      baseScript((s) => {
        if (s.startsWith('INSERT INTO "public".org_units')) {
          inserted++;
          return Object.assign(new Error('duplicate key value violates unique constraint "secret-detail"'), { code: '23505' });
        }
        return undefined;
      }),
    );
    const r = await runSync({ trigger: 'cron' }, deps(f.env));
    expect(inserted).toBe(1);
    expect(r).toMatchObject({ status: 'error', errorCode: 'db_error' });
    expect(f.sqls()).toContain('ROLLBACK');
    expect(f.sqls()).not.toContain('COMMIT');
    expect(JSON.stringify(r)).not.toContain('secret-detail');
    const logged = vi.mocked(console.warn).mock.calls.flat().join(' ');
    expect(logged).not.toContain('secret-detail');
    expect(logged).toContain('23505'); // the SQLSTATE is fine to log
    // The run row is closed as failed with the code, and the lock is still released.
    const finish = f.log.find((l) => l.sql.includes('SET status = $2'));
    expect(finish).toBeDefined();
    expect(f.sqls().at(-1)).toContain('pg_advisory_unlock');
  });

  it('a lock that cannot be released destroys its connection (ending the session drops the lock)', async () => {
    const f = makeFakeSyncEnv(baseScript((s) => (s.includes('pg_advisory_unlock') ? ok({ ok: false }) : undefined)));
    await runSync({ trigger: 'cron' }, deps(f.env));
    const lockConn = f.log.find((l) => l.sql.includes('pg_try_advisory_lock'))!.conn;
    expect(f.released.find((r) => r.conn === lockConn)).toEqual({ conn: lockConn, destroy: true });
  });

  it('sets the scope configuration from the environment at call time', async () => {
    vi.stubEnv('ROLLEKATALOG_GLOBAL_ROLES', 'admin,bygger');
    const f = makeFakeSyncEnv(baseScript());
    const r = await runSync({ trigger: 'cron' }, deps(f.env));
    // ida.l's unscoped bygger is now a global row, so one more assignment than with the default.
    expect(r.counts.assignmentsUpserted).toBe(11);
    expect(r.counts.assignmentsWithoutScope).toBe(1);
  });
});

describe('runSync audit', () => {
  it('writes nothing to the audit log: the sync is housekeeping, its status lives in sync_runs', async () => {
    await runSync({ trigger: 'cron' }, deps(makeFakeSyncEnv(baseScript()).env));
    await runSync({ trigger: 'manual', actorUserId: 'admin-1' }, deps(makeFakeSyncEnv(baseScript()).env));
    mock.setData({ users: [] });
    await runSync({ trigger: 'cron' }, deps(makeFakeSyncEnv(baseScript()).env));
    const locked = makeFakeSyncEnv(baseScript((q) => (q.includes('pg_try_advisory_lock') ? ok({ ok: false }) : undefined)));
    await runSync({ trigger: 'cron' }, deps(locked.env));
    expect(recordEvent).not.toHaveBeenCalled();
  });
});
