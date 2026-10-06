// Needs a real Postgres 15+; skipped unless TEST_DATABASE_URL is set (see src/test/pg.ts).
// Runs the real sync (mock Rollekatalog over HTTP, real SQL, real advisory lock and
// transaction) against a throwaway schema. Mocks cannot prove constraints, FK
// actions, rollback or lock contention, which is what these tests are for.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { addUser, hasPg, withFreshSchema } from '@/test/pg';
import type { ClientLike, SqlResult } from '@/lib/authz/pg-runner';

vi.mock('@/lib/db', () => ({ pool: {}, db: {} }));

import { createRollekatalogClient } from './client';
import { fixtureData, startMockRollekatalog, type MockRollekatalog } from './mock-server';
import { runSync, type SyncDeps } from './sync';
import { getLatestSyncRun } from './sync-run';
import type { SyncEnv } from './sync-run';
import type { RunSyncOptions, SyncCounts, SyncResult } from './types';

const U = (n: number) => `7e5e0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const O = (n: number) => `5a1b0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const E = (n: number) => `9d3c0000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let mock: MockRollekatalog;
const opened: Client[] = [];

beforeAll(async () => {
  if (hasPg) mock = await startMockRollekatalog();
});
afterAll(async () => {
  if (mock) await mock.close();
});
beforeEach(() => {
  if (!hasPg) return;
  mock.resetData();
  mock.setFaults([]);
  mock.clearRequests();
  vi.stubEnv('ROLLEKATALOG_URL', mock.url);
  vi.stubEnv('ROLLEKATALOG_READ_API_KEY', mock.readKey);
  vi.stubEnv('ROLLEKATALOG_ORG_API_KEY', mock.orgKey);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.allSettled(opened.splice(0).map((c) => c.end()));
});

/** Every connection is its own client, so the advisory lock and the transaction really contend. */
function schemaEnv(schema: string): SyncEnv {
  return {
    schema,
    connect: async (): Promise<ClientLike> => {
      const c = new Client({ connectionString: process.env.TEST_DATABASE_URL });
      await c.connect();
      opened.push(c);
      return {
        query: (text, params) => c.query(text, params as unknown[] | undefined) as unknown as Promise<SqlResult<never>>,
        release: () => void c.end().catch(() => {}),
      };
    },
  };
}

interface Harness {
  c: Client;
  schema: string;
  env: SyncEnv;
  clock: { t: number };
  run: (opts?: Partial<RunSyncOptions>, deps?: Partial<SyncDeps>) => Promise<SyncResult>;
}

function harness(c: Client, schema: string): Harness {
  const env = schemaEnv(schema);
  const clock = { t: Date.parse('2026-10-05T10:00:00Z') };
  // Each run starts a second later, so "latest run" is unambiguous; within a run the clock is fixed.
  const run: Harness['run'] = (opts = {}, deps = {}) => {
    clock.t += 1000;
    return runSync(
      { trigger: 'cron', ...opts },
      {
        env,
        now: () => new Date(clock.t),
        // No real waiting between retries.
        client: createRollekatalogClient({ backoffMs: 1, sleep: async () => {} }),
        ...deps,
      },
    );
  };
  return { c, schema, env, clock, run };
}

const withHarness = (fn: (h: Harness) => Promise<void>) => withFreshSchema(async (c, schema) => fn(harness(c, schema)));

const rows = async (c: Client, sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows;
const count = async (c: Client, table: string, where = 'true') =>
  Number((await c.query(`SELECT count(*) AS n FROM ${table} WHERE ${where}`)).rows[0].n);

/** Stable snapshot of everything the sync owns (no timestamps). */
async function snapshot(c: Client) {
  return {
    users: await rows(c, `SELECT uuid, ext_uuid, ext_user_id, name, email, disabled, app_user_id, source FROM directory_users ORDER BY uuid`),
    units: await rows(c, `SELECT uuid, name, parent_uuid, source FROM org_units ORDER BY uuid`),
    members: await rows(c, `SELECT directory_user_uuid, org_unit_uuid, is_primary, title FROM org_unit_members ORDER BY 1, 2`),
    assignments: await rows(
      c,
      `SELECT id, directory_user_uuid, role_key, scope_org_unit_uuid, include_descendants, source FROM role_assignments ORDER BY directory_user_uuid, role_key, scope_org_unit_uuid`,
    ),
  };
}

/** better-auth session rows for an app user (real sessions table of the throwaway schema). */
async function addSessions(c: Client, userId: string, n = 2) {
  for (let i = 0; i < n; i++) {
    await c.query(
      `INSERT INTO sessions (id, expires_at, token, user_id) VALUES ($1, now() + interval '7 days', $2, $3)`,
      [`${userId}-s${i}`, `${userId}-tok${i}`, userId],
    );
  }
}
const sessionCount = (c: Client, userId: string) => count(c, 'sessions', `user_id = '${userId}'`);

/** Sync once, then link app users to directory rows (login matching's job) and give each two sessions. */
async function linkWithSessions(h: { c: Client }, links: Array<[appUser: string, directoryUuid: string]>) {
  for (const [appUser, dir] of links) {
    await addUser(h.c, appUser);
    await h.c.query('UPDATE directory_users SET app_user_id = $1 WHERE uuid = $2', [appUser, dir]);
    await addSessions(h.c, appUser);
  }
}

const roleRows = (c: Client, userUuid: string) =>
  rows(c, `SELECT role_key, scope_org_unit_uuid, include_descendants FROM role_assignments WHERE directory_user_uuid = $1 ORDER BY role_key, scope_org_unit_uuid`, [userUuid]);

const ZERO: SyncCounts = {
  usersUpserted: 0,
  usersDisabled: 0,
  sessionsRevoked: 0,
  orgUnitsUpserted: 0,
  orgUnitsOrphaned: 0,
  orgUnitCyclesBroken: 0,
  assignmentsUpserted: 0,
  assignmentsRemoved: 0,
  assignmentsIgnoredRole: 1,
  assignmentsSkippedUnknownUser: 1,
  assignmentsWithoutScope: 2,
  usersSkippedInvalid: 0,
  orgUnitsSkippedInvalid: 0,
  assignmentRowsSkippedInvalid: 0,
  membershipsSkippedInvalid: 0,
};

describe.skipIf(!hasPg)('Rollekatalog sync (real Postgres)', () => {
  it('first sync populates the mirror from the fixtures', () =>
    withHarness(async (h) => {
      const r = await h.run();
      expect(r).toMatchObject({ status: 'success', errorCode: null });
      expect(r.counts).toEqual({
        usersUpserted: 9,
        usersDisabled: 0,
        sessionsRevoked: 0,
        orgUnitsUpserted: 5,
        orgUnitsOrphaned: 0,
        orgUnitCyclesBroken: 0,
        assignmentsUpserted: 10,
        assignmentsRemoved: 0,
        assignmentsIgnoredRole: 1,
        assignmentsSkippedUnknownUser: 1,
        assignmentsWithoutScope: 2,
        usersSkippedInvalid: 0,
        orgUnitsSkippedInvalid: 0,
        assignmentRowsSkippedInvalid: 0,
        membershipsSkippedInvalid: 0,
      });

      expect(await count(h.c, 'directory_users', "source = 'rollekatalog'")).toBe(9);
      expect(await count(h.c, 'org_units', "source = 'rollekatalog'")).toBe(5);
      expect(await count(h.c, 'org_unit_members')).toBe(12);
      expect(await count(h.c, 'role_assignments', "source = 'rollekatalog'")).toBe(10);

      const sofie = (await rows(h.c, `SELECT * FROM directory_users WHERE ext_user_id = 'sofie.s'`))[0];
      expect(sofie).toMatchObject({ uuid: U(5), ext_uuid: E(5), disabled: true, source: 'rollekatalog', app_user_id: null });
      expect(sofie.synced_at).toBeInstanceOf(Date);

      const units = await rows(h.c, 'SELECT uuid, parent_uuid FROM org_units');
      const byUuid = Object.fromEntries(units.map((u) => [u.uuid, u]));
      expect(byUuid[O(5)].parent_uuid).toBe(O(3));
      expect(byUuid[O(3)].parent_uuid).toBe(O(2));
      expect(byUuid[O(1)].parent_uuid).toBeNull();

      expect(await roleRows(h.c, U(3))).toEqual([
        { role_key: 'tt-bruger', scope_org_unit_uuid: null, include_descendants: true },
        { role_key: 'tt-skabelonansvarlig', scope_org_unit_uuid: O(3), include_descendants: true },
        { role_key: 'tt-skabelonansvarlig', scope_org_unit_uuid: O(4), include_descendants: true },
      ]);
      expect(await roleRows(h.c, U(7))).toEqual([]); // ida: logleser without scope is not global
      expect(await roleRows(h.c, U(9))).toEqual([{ role_key: 'tt-administrator', scope_org_unit_uuid: null, include_descendants: true }]);

      // The run is recorded, counts only.
      const latest = await getLatestSyncRun(h.env);
      expect(latest).toMatchObject({ id: r.runId, status: 'success', errorCode: null, counts: r.counts });
      expect(latest?.finishedAt).toBeInstanceOf(Date);
    }));

  describe('invalid rows', () => {
    const legacyUser = (id: string, extra: Record<string, unknown> = {}) => ({
      uuid: id,
      extUuid: null,
      userId: `legacy-${id}`,
      name: 'Legacy',
      email: null,
      disabled: false,
      positions: [{ orgUnitUuid: O(1) }],
      ...extra,
    });

    it('one bad unit id and one bad user id: the sync succeeds, the rest is mirrored, children of the bad unit become roots', () =>
      withHarness(async (h) => {
        const d = fixtureData();
        mock.setData({
          users: [...d.users, legacyUser('LEGACY-USER-1')],
          orgUnits: [
            ...d.orgUnits,
            { uuid: 'LEGACY-UNIT-1', name: 'Gammel enhed', parentOrgUnitUuid: null },
            { uuid: O(21), name: 'Barn af gammel enhed', parentOrgUnitUuid: 'LEGACY-UNIT-1' },
          ],
          roleAssignments: [
            ...d.roleAssignments,
            { extUuid: E(99), userId: 'legacy-user', assignments: [{ roleIdentifier: 'tt-logleser', roleConstraintValues: [] }] },
            'not-a-row',
          ],
        });
        const r = await h.run();
        expect(r).toMatchObject({ status: 'success', errorCode: null });
        expect(r.counts).toMatchObject({
          usersUpserted: 9,
          orgUnitsUpserted: 6,
          orgUnitsOrphaned: 0,
          usersSkippedInvalid: 1,
          orgUnitsSkippedInvalid: 1,
          assignmentRowsSkippedInvalid: 1,
          membershipsSkippedInvalid: 0,
          assignmentsSkippedUnknownUser: 2, // the fixture's one + the skipped user's
          assignmentsUpserted: 10,
        });

        expect(await count(h.c, 'directory_users', "source = 'rollekatalog'")).toBe(9);
        expect(await count(h.c, 'directory_users', "name = 'Legacy'")).toBe(0);
        expect(await count(h.c, 'org_units', "source = 'rollekatalog'")).toBe(6);
        expect(await count(h.c, 'org_units', "name = 'Gammel enhed'")).toBe(0);
        const child = (await rows(h.c, 'SELECT parent_uuid FROM org_units WHERE uuid = $1', [O(21)]))[0];
        expect(child.parent_uuid).toBeNull();
        // The rest is exactly the fixture result.
        expect(await count(h.c, 'role_assignments', "source = 'rollekatalog'")).toBe(10);
        expect(await count(h.c, 'org_unit_members')).toBe(12);

        // The counters are persisted in sync_runs.counts and read back; no row content is.
        const latest = await getLatestSyncRun(h.env);
        expect(latest?.counts).toMatchObject({ usersSkippedInvalid: 1, orgUnitsSkippedInvalid: 1, assignmentRowsSkippedInvalid: 1 });
        const raw = (await rows(h.c, 'SELECT counts FROM sync_runs'))[0].counts;
        expect(JSON.stringify(raw)).not.toMatch(/LEGACY|Gammel/i);
      }));

    it('a skipped user who was mirrored before is disabled like any absent user; the removal threshold still applies', () =>
      withHarness(async (h) => {
        await h.run();
        // Rune's uuid turns into a legacy id upstream: the row is skipped, so the mirrored Rune is absent.
        const d = fixtureData();
        mock.setData({ users: d.users.map((u) => (u.userId === 'rune.a' ? { ...u, uuid: 'LEGACY-RUNE' } : u)) });
        vi.stubEnv('ROLLEKATALOG_SYNC_MAX_REMOVAL_PERCENT', '5'); // 1 of 8 enabled users = 12.5 %
        const blocked = await h.run();
        expect(blocked).toMatchObject({ status: 'aborted', errorCode: 'removal_threshold' });
        expect((await rows(h.c, 'SELECT disabled FROM directory_users WHERE uuid = $1', [U(9)]))[0].disabled).toBe(false);

        const forced = await h.run({ trigger: 'manual', force: true });
        expect(forced).toMatchObject({ status: 'success' });
        expect(forced.counts).toMatchObject({ usersSkippedInvalid: 1, usersDisabled: 1 });
        expect((await rows(h.c, 'SELECT disabled FROM directory_users WHERE uuid = $1', [U(9)]))[0].disabled).toBe(true);
      }));

    it('more bad rows than the allowance fails the run as invalid_response and writes nothing', () =>
      withHarness(async (h) => {
        await h.run();
        const before = await snapshot(h.c);
        const d = fixtureData();
        mock.setData({ users: [...d.users, ...['A', 'B', 'C', 'D'].map((x) => legacyUser(`LEGACY-${x}`))] });
        const r = await h.run();
        expect(r).toMatchObject({ status: 'error', errorCode: 'invalid_response' });
        expect(await snapshot(h.c)).toEqual(before);
        const latest = await getLatestSyncRun(h.env);
        expect(latest).toMatchObject({ status: 'failed', errorCode: 'invalid_response' });
      }));
  });

  it('a second identical sync changes nothing and counts no changes', () =>
    withHarness(async (h) => {
      await h.run();
      const before = await snapshot(h.c);
      const t1 = (await rows(h.c, 'SELECT max(synced_at) AS t FROM role_assignments'))[0].t as Date;

      h.clock.t += 3_600_000;
      const again = await h.run();
      expect(again.status).toBe('success');
      expect(again.counts).toEqual(ZERO);
      expect(await snapshot(h.c)).toEqual(before); // same rows, same assignment ids
      expect(await count(h.c, 'sync_runs')).toBe(2);

      // But "seen" advances: the staleness rule reads synced_at, so an unchanged assignment must stay fresh.
      const t2 = (await rows(h.c, 'SELECT min(synced_at) AS t FROM role_assignments'))[0].t as Date;
      expect(t2.getTime()).toBeGreaterThan(t1.getTime());
      const users = (await rows(h.c, 'SELECT min(synced_at) AS t FROM directory_users'))[0].t as Date;
      expect(users.getTime()).toBe(t2.getTime());
    }));

  it('a user removed upstream is disabled (not deleted), keeps the link, and loses memberships and roles', () =>
    withHarness(async (h) => {
      await h.c.query("INSERT INTO users (id, name, email) VALUES ('app-rune', 'Rune', 'rune.a@example.dk')");
      await h.run();
      await h.c.query('UPDATE directory_users SET app_user_id = $1 WHERE uuid = $2', ['app-rune', U(9)]);

      const d = fixtureData();
      mock.setData({
        users: d.users.filter((u) => u.userId !== 'rune.a'),
        roleAssignments: (d.roleAssignments as Array<{ userId: string }>).filter((a) => a.userId !== 'rune.a'),
      });
      const r = await h.run();
      expect(r.status).toBe('success');
      expect(r.counts.usersDisabled).toBe(1);
      expect(r.counts.assignmentsRemoved).toBe(1);

      const rune = (await rows(h.c, 'SELECT disabled, app_user_id, source FROM directory_users WHERE uuid = $1', [U(9)]))[0];
      expect(rune).toEqual({ disabled: true, app_user_id: 'app-rune', source: 'rollekatalog' });
      expect(await roleRows(h.c, U(9))).toEqual([]);
      expect(await count(h.c, 'org_unit_members', `directory_user_uuid = '${U(9)}'`)).toBe(0);
      expect(await count(h.c, 'directory_users', "source = 'rollekatalog'")).toBe(9);

      // And it comes back (enabled) when Rollekatalog lists it again.
      mock.resetData();
      await h.run();
      expect((await rows(h.c, 'SELECT disabled FROM directory_users WHERE uuid = $1', [U(9)]))[0].disabled).toBe(false);
      expect((await roleRows(h.c, U(9))).length).toBe(1);
    }));

  describe('session revocation of disabled linked users', () => {
    const dropRune = () => {
      const d = fixtureData();
      mock.setData({
        users: d.users.filter((u) => u.userId !== 'rune.a'),
        roleAssignments: (d.roleAssignments as Array<{ userId: string }>).filter((a) => a.userId !== 'rune.a'),
      });
    };

    it('a user disabled by the sync loses their sessions; another enabled user keeps theirs', () =>
      withHarness(async (h) => {
        await h.run();
        await linkWithSessions(h, [['app-rune', U(9)], ['app-anne', U(3)]]);
        dropRune();
        const r = await h.run();
        expect(r).toMatchObject({ status: 'success' });
        expect(r.counts.usersDisabled).toBe(1);
        expect(r.counts.sessionsRevoked).toBe(2);
        expect(await sessionCount(h.c, 'app-rune')).toBe(0);
        expect(await sessionCount(h.c, 'app-anne')).toBe(2);
        // The app account itself and the link are untouched; only the sessions go.
        expect(await count(h.c, 'users', "id = 'app-rune'")).toBe(1);
        expect((await rows(h.c, 'SELECT app_user_id FROM directory_users WHERE uuid = $1', [U(9)]))[0].app_user_id).toBe('app-rune');
        // The count is stored in the run row; counts only.
        expect((await getLatestSyncRun(h.env))?.counts?.sessionsRevoked).toBe(2);
      }));

    it('a user disabled in Rollekatalog (disabled flag, not removed) loses their sessions too', () =>
      withHarness(async (h) => {
        await h.run();
        await linkWithSessions(h, [['app-ida', U(7)]]);
        const d = fixtureData();
        mock.setData({ users: d.users.map((u) => (u.userId === 'ida.l' ? { ...u, disabled: true } : u)) });
        const r = await h.run();
        expect(r.counts).toMatchObject({ usersDisabled: 1, sessionsRevoked: 2 });
        expect(await sessionCount(h.c, 'app-ida')).toBe(0);
      }));

    it('is idempotent and re-applied every run: a session created for an already disabled user dies on the next run', () =>
      withHarness(async (h) => {
        await h.run();
        await linkWithSessions(h, [['app-sofie', U(5)]]); // sofie.s is disabled upstream from the start
        const second = await h.run(); // nothing changes in the mirror, yet the sessions go
        expect(second.counts).toMatchObject({ usersDisabled: 0, usersUpserted: 0, sessionsRevoked: 2 });
        expect(await sessionCount(h.c, 'app-sofie')).toBe(0);
        await addSessions(h.c, 'app-sofie', 1); // somehow logged in again
        expect((await h.run()).counts.sessionsRevoked).toBe(1);
        expect((await h.run()).counts.sessionsRevoked).toBe(0);
        expect(await sessionCount(h.c, 'app-sofie')).toBe(0);
      }));

    it('a disabled directory row without an app account deletes nothing', () =>
      withHarness(async (h) => {
        await h.run();
        await addUser(h.c, 'app-bystander');
        await addSessions(h.c, 'app-bystander');
        // sofie.s is disabled and unlinked (app_user_id NULL); nothing may match a NULL.
        const r = await h.run();
        expect(r.counts.sessionsRevoked).toBe(0);
        expect(await count(h.c, 'sessions')).toBe(2);
      }));

    it('a disabled source=local directory row is never touched, linked or not', () =>
      withHarness(async (h) => {
        await addUser(h.c, 'app-local');
        await addSessions(h.c, 'app-local');
        await h.c.query(`INSERT INTO directory_users (name, source, disabled, app_user_id) VALUES ('Lokal', 'local', true, 'app-local')`);
        const r = await h.run();
        expect(r.status).toBe('success');
        expect(r.counts.sessionsRevoked).toBe(0);
        expect(await sessionCount(h.c, 'app-local')).toBe(2);
        expect((await h.run()).counts.sessionsRevoked).toBe(0);
        expect(await sessionCount(h.c, 'app-local')).toBe(2);
      }));

    it('an aborted run (empty_response, removal_threshold) revokes nothing, even for an already disabled linked user', () =>
      withHarness(async (h) => {
        await h.run();
        await linkWithSessions(h, [['app-sofie', U(5)], ['app-rune', U(9)]]);

        mock.setData({ users: [] });
        expect(await h.run()).toMatchObject({ status: 'aborted', errorCode: 'empty_response' });
        expect(await count(h.c, 'sessions')).toBe(4);

        mock.resetData();
        const d = fixtureData();
        const keep = new Set(['mette.e', 'jens.t']);
        mock.setData({
          users: d.users.filter((u) => keep.has(u.userId)),
          roleAssignments: (d.roleAssignments as Array<{ userId: string }>).filter((a) => keep.has(a.userId)),
        });
        const aborted = await h.run();
        expect(aborted).toMatchObject({ status: 'aborted', errorCode: 'removal_threshold' });
        expect(aborted.counts.sessionsRevoked).toBe(0);
        expect(await count(h.c, 'sessions')).toBe(4);

        // Forced, it applies: sofie (already disabled) and rune (now disabled) lose theirs.
        const forced = await h.run({ force: true });
        expect(forced.counts.sessionsRevoked).toBe(4);
        expect(await count(h.c, 'sessions')).toBe(0);
      }));

    it('a failure later in the transaction rolls the session delete back with everything else', () =>
      withHarness(async (h) => {
        await h.run();
        await linkWithSessions(h, [['app-rune', U(9)]]);
        const before = await snapshot(h.c);
        // A deferred constraint trigger fires at COMMIT, after the session delete (the last statement) has run.
        await h.c.query(`CREATE FUNCTION "${h.schema}".boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$`);
        await h.c.query(
          `CREATE CONSTRAINT TRIGGER boom AFTER DELETE ON "${h.schema}".sessions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "${h.schema}".boom()`,
        );
        dropRune();
        const r = await h.run();
        expect(r).toMatchObject({ status: 'error', errorCode: 'db_error' });
        expect(r.counts.sessionsRevoked).toBe(0);
        expect(await sessionCount(h.c, 'app-rune')).toBe(2);
        expect(await snapshot(h.c)).toEqual(before);

        await h.c.query(`DROP TRIGGER boom ON "${h.schema}".sessions`);
        expect((await h.run()).counts.sessionsRevoked).toBe(2);
      }));
  });

  it('a user disabled in Rollekatalog is disabled in the mirror and counted once', () =>
    withHarness(async (h) => {
      await h.run();
      const d = fixtureData();
      mock.setData({ users: d.users.map((u) => (u.userId === 'ida.l' ? { ...u, disabled: true } : u)) });
      const r = await h.run();
      expect(r.counts.usersDisabled).toBe(1);
      expect(r.counts.usersUpserted).toBe(1);
      expect((await rows(h.c, 'SELECT disabled FROM directory_users WHERE uuid = $1', [U(7)]))[0].disabled).toBe(true);
      const again = await h.run();
      expect(again.counts.usersDisabled).toBe(0);
    }));

  it('app_user_id survives a re-sync, while name, email and ids are refreshed from Rollekatalog', () =>
    withHarness(async (h) => {
      await h.c.query("INSERT INTO users (id, name, email) VALUES ('app-anne', 'Anne', 'anne.p@example.dk')");
      await h.run();
      await h.c.query('UPDATE directory_users SET app_user_id = $1 WHERE uuid = $2', ['app-anne', U(3)]);

      const d = fixtureData();
      mock.setData({
        users: d.users.map((u) => (u.userId === 'anne.p' ? { ...u, name: 'Anne Omdøbt', email: 'anne.ny@example.dk', userId: 'anne.ny' } : u)),
        roleAssignments: (d.roleAssignments as Array<{ userId: string }>).map((a) => (a.userId === 'anne.p' ? { ...a, userId: 'anne.ny' } : a)),
      });
      const r = await h.run();
      expect(r.counts.usersUpserted).toBe(1);
      const anne = (await rows(h.c, 'SELECT name, email, ext_user_id, app_user_id FROM directory_users WHERE uuid = $1', [U(3)]))[0];
      expect(anne).toEqual({ name: 'Anne Omdøbt', email: 'anne.ny@example.dk', ext_user_id: 'anne.ny', app_user_id: 'app-anne' });
      expect((await roleRows(h.c, U(3))).length).toBe(3); // still joined (extUuid matches)
    }));

  it('never touches source=local rows, and a local ext_uuid does not break the sync', () =>
    withHarness(async (h) => {
      await h.c.query("INSERT INTO users (id, name, email) VALUES ('app-local', 'Local', 'l@example.dk')");
      const localUnit = (await rows(h.c, `INSERT INTO org_units (name, source) VALUES ('Lokal enhed', 'local') RETURNING uuid`))[0].uuid;
      // A local user that also claims the ext_uuid of Rollekatalog's mette.e.
      const localUser = (
        await rows(
          h.c,
          `INSERT INTO directory_users (name, source, app_user_id, ext_uuid, ext_user_id) VALUES ('Lokal bruger', 'local', 'app-local', $1, 'lokal') RETURNING uuid`,
          [E(1)],
        )
      )[0].uuid;
      await h.c.query(`INSERT INTO role_assignments (directory_user_uuid, role_key, scope_org_unit_uuid, source) VALUES ($1, 'tt-skabelonansvarlig', $2, 'local')`, [localUser, localUnit]);
      await h.c.query(`INSERT INTO org_unit_members (directory_user_uuid, org_unit_uuid) VALUES ($1, $2)`, [localUser, localUnit]);
      const localBefore = {
        user: await rows(h.c, 'SELECT * FROM directory_users WHERE uuid = $1', [localUser]),
        unit: await rows(h.c, 'SELECT * FROM org_units WHERE uuid = $1', [localUnit]),
        ra: await rows(h.c, `SELECT * FROM role_assignments WHERE source = 'local'`),
        members: await rows(h.c, 'SELECT * FROM org_unit_members WHERE directory_user_uuid = $1', [localUser]),
      };

      const r = await h.run();
      expect(r.status).toBe('success');
      // Run it again and once more with Rollekatalog empty of one user, so disable/delete paths run too.
      await h.run();
      mock.setData({ users: fixtureData().users.filter((u) => u.userId !== 'ida.l') });
      await h.run({}, {});

      expect({
        user: await rows(h.c, 'SELECT * FROM directory_users WHERE uuid = $1', [localUser]),
        unit: await rows(h.c, 'SELECT * FROM org_units WHERE uuid = $1', [localUnit]),
        ra: await rows(h.c, `SELECT * FROM role_assignments WHERE source = 'local'`),
        members: await rows(h.c, 'SELECT * FROM org_unit_members WHERE directory_user_uuid = $1', [localUser]),
      }).toEqual(localBefore);
      // mette.e is mirrored, without the ext_uuid the local row holds.
      const mette = (await rows(h.c, 'SELECT ext_uuid, ext_user_id FROM directory_users WHERE uuid = $1', [U(1)]))[0];
      expect(mette).toEqual({ ext_uuid: null, ext_user_id: 'mette.e' });
    }));

  it('a rollekatalog row that held an ext_uuid someone else now owns lets go of it', () =>
    withHarness(async (h) => {
      await h.run();
      // Upstream re-created rune.a under a new uuid but with the same ext_uuid.
      const d = fixtureData();
      mock.setData({ users: d.users.map((u) => (u.userId === 'rune.a' ? { ...u, uuid: U(90) } : u)) });
      const r = await h.run({ force: true });
      expect(r.status).toBe('success');
      const holders = await rows(h.c, 'SELECT uuid, ext_uuid, disabled FROM directory_users WHERE uuid IN ($1, $2) ORDER BY uuid', [U(9), U(90)]);
      expect(holders).toEqual([
        { uuid: U(9), ext_uuid: null, disabled: true },
        { uuid: U(90), ext_uuid: E(9), disabled: false },
      ]);
    }));

  describe('atomicity', () => {
    it('a failure in the middle of the transaction rolls everything back and records the failure', () =>
      withHarness(async (h) => {
        await h.c.query(`CREATE FUNCTION "${h.schema}".boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$`);
        await h.c.query(`CREATE TRIGGER boom BEFORE INSERT ON "${h.schema}".role_assignments FOR EACH ROW EXECUTE FUNCTION "${h.schema}".boom()`);

        const r = await h.run();
        expect(r).toMatchObject({ status: 'error', errorCode: 'db_error' });
        expect(r.counts.usersUpserted).toBe(0);
        // Users, units and members were inserted before the failing statement: all gone.
        expect(await count(h.c, 'directory_users')).toBe(0);
        expect(await count(h.c, 'org_units')).toBe(0);
        expect(await count(h.c, 'org_unit_members')).toBe(0);
        expect(await count(h.c, 'role_assignments')).toBe(0);
        const latest = await getLatestSyncRun(h.env);
        expect(latest).toMatchObject({ status: 'failed', errorCode: 'db_error' });
        expect(JSON.stringify(latest)).not.toContain('boom'); // the error message never reaches the row

        // The lock was released: the next run goes through once the fault is gone.
        await h.c.query(`DROP TRIGGER boom ON "${h.schema}".role_assignments`);
        expect((await h.run()).status).toBe('success');
      }));

    it('a failure on an existing mirror leaves it exactly as it was', () =>
      withHarness(async (h) => {
        await h.run();
        const before = await snapshot(h.c);
        await h.c.query(`CREATE FUNCTION "${h.schema}".boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$`);
        // Fires on the assignment DELETE of the changed run, after users and units were already written.
        await h.c.query(`CREATE TRIGGER boom BEFORE DELETE ON "${h.schema}".role_assignments FOR EACH ROW EXECUTE FUNCTION "${h.schema}".boom()`);

        const d = fixtureData();
        mock.setData({
          users: d.users.map((u) => (u.userId === 'jens.t' ? { ...u, name: 'Skal ikke gemmes' } : u)),
          roleAssignments: (d.roleAssignments as Array<{ userId: string }>).filter((a) => a.userId !== 'sofie.s'),
        });
        const r = await h.run();
        expect(r).toMatchObject({ status: 'error', errorCode: 'db_error' });
        expect(await snapshot(h.c)).toEqual(before);
      }));
  });

  describe('advisory lock', () => {
    it('answers already_running without a run row or any change while another session holds the lock', () =>
      withHarness(async (h) => {
        const holder = new Client({ connectionString: process.env.TEST_DATABASE_URL });
        await holder.connect();
        opened.push(holder);
        await holder.query('SELECT pg_advisory_lock(hashtext($1)::bigint)', [`os2taletiltekst.rollekatalog.sync:${h.schema}`]);

        const r = await h.run();
        expect(r).toMatchObject({ status: 'already_running', runId: null, errorCode: 'already_running' });
        expect(await count(h.c, 'sync_runs')).toBe(0);
        expect(await count(h.c, 'directory_users')).toBe(0);
        expect(mock.requests).toHaveLength(0); // not even a fetch

        await holder.query('SELECT pg_advisory_unlock_all()');
        expect((await h.run()).status).toBe('success');
      }));

    it('two overlapping runs: one syncs, the other is already_running', () =>
      withHarness(async (h) => {
        mock.setFaults([{ match: '/api/organisation/v3', delayMs: 400, times: 1 }]);
        const first = h.run();
        await new Promise((r) => setTimeout(r, 150));
        const second = await h.run();
        expect(second.status).toBe('already_running');
        expect((await first).status).toBe('success');
        expect(await count(h.c, 'sync_runs')).toBe(1);
      }));

    it('is released after an aborted run too', () =>
      withHarness(async (h) => {
        mock.setData({ users: [] });
        expect((await h.run()).status).toBe('aborted');
        mock.resetData();
        expect((await h.run()).status).toBe('success');
      }));

    it('locks are per schema, so other schemas are not blocked', () =>
      withHarness(async (h) => {
        const holder = new Client({ connectionString: process.env.TEST_DATABASE_URL });
        await holder.connect();
        opened.push(holder);
        await holder.query('SELECT pg_advisory_lock(hashtext($1)::bigint)', ['os2taletiltekst.rollekatalog.sync:some_other_schema']);
        expect((await h.run()).status).toBe('success');
      }));
  });

  describe('guards', () => {
    it('empty response (no users, or no org units) aborts and changes nothing', () =>
      withHarness(async (h) => {
        await h.run();
        const before = await snapshot(h.c);

        mock.setData({ users: [] });
        const noUsers = await h.run();
        expect(noUsers).toMatchObject({ status: 'aborted', errorCode: 'empty_response' });

        mock.resetData();
        mock.setData({ orgUnits: [] });
        const noUnits = await h.run({ force: true }); // force does NOT bypass this guard
        expect(noUnits).toMatchObject({ status: 'aborted', errorCode: 'empty_response' });

        expect(await snapshot(h.c)).toEqual(before);
        const latest = await getLatestSyncRun(h.env);
        expect(latest).toMatchObject({ status: 'failed', errorCode: 'empty_response' });
        // The abort happens right after organisation v3: the other endpoints are not even called.
        mock.clearRequests();
        mock.setData({ users: [] });
        await h.run();
        expect(mock.requests.map((q) => q.path)).toEqual(['/api/organisation/v3']);
      }));

    it('removal threshold on users aborts, and force applies it', () =>
      withHarness(async (h) => {
        await h.run();
        const before = await snapshot(h.c);
        const d = fixtureData();
        const keep = new Set(['mette.e', 'jens.t']); // 6 of the 8 enabled users would be disabled
        mock.setData({
          users: d.users.filter((u) => keep.has(u.userId)),
          roleAssignments: (d.roleAssignments as Array<{ userId: string }>).filter((a) => keep.has(a.userId)),
        });

        const aborted = await h.run();
        expect(aborted).toMatchObject({ status: 'aborted', errorCode: 'removal_threshold' });
        expect(aborted.counts.usersDisabled).toBe(0);
        expect(await snapshot(h.c)).toEqual(before);

        const forced = await h.run({ trigger: 'manual', force: true, actorUserId: 'admin-1' });
        expect(forced.status).toBe('success');
        expect(forced.counts.usersDisabled).toBe(6); // sofie.s was already disabled
        expect(await count(h.c, 'directory_users', 'disabled = false')).toBe(2);
      }));

    it('removal threshold on role assignments (users unchanged) aborts, and force applies it', () =>
      withHarness(async (h) => {
        await h.run();
        mock.setData({ roleAssignments: [] });
        const aborted = await h.run();
        expect(aborted).toMatchObject({ status: 'aborted', errorCode: 'removal_threshold' });
        expect(await count(h.c, 'role_assignments')).toBe(10);
        const forced = await h.run({ force: true });
        expect(forced).toMatchObject({ status: 'success' });
        expect(forced.counts.assignmentsRemoved).toBe(10);
        expect(await count(h.c, 'role_assignments')).toBe(0);
      }));

    it('removal threshold on ELEVATED assignments aborts although the total ratio is within the limit; force applies it', () =>
      withHarness(async (h) => {
        await h.run();
        expect(await count(h.c, 'role_assignments')).toBe(10);
        expect(await count(h.c, 'role_assignments', `role_key <> 'tt-bruger'`)).toBe(7);
        const d = fixtureData();
        // Three users lose every elevated role but keep tt-bruger: 3/10 of all rows (not over 30 %), 3/7 of the elevated ones.
        const stripped = new Set(['mette.e', 'rune.a', 'jens.t']);
        mock.setData({
          roleAssignments: (d.roleAssignments as Array<{ userId: string; assignments: Array<{ roleIdentifier: string }> }>).map((a) =>
            stripped.has(a.userId) ? { ...a, assignments: a.assignments.filter((x) => x.roleIdentifier === 'tt-bruger') } : a,
          ),
        });
        const aborted = await h.run();
        expect(aborted).toMatchObject({ status: 'aborted', errorCode: 'removal_threshold' });
        expect(await count(h.c, 'role_assignments')).toBe(10);
        const forced = await h.run({ force: true });
        expect(forced).toMatchObject({ status: 'success' });
        expect(forced.counts.assignmentsRemoved).toBe(3);
        expect(await count(h.c, 'role_assignments', `role_key <> 'tt-bruger'`)).toBe(4);
      }));

    it('an assignment entry that turns invalid counts as an elevated removal (the whole role group is dropped)', () =>
      withHarness(async (h) => {
        await h.run();
        const d = fixtureData();
        // anne.p holds two tt-skabelonansvarlig rows; a broken entry for that role drops both. With
        // mette.e and rune.a gone as well, 4 of 7 elevated rows disappear.
        mock.setData({
          roleAssignments: (d.roleAssignments as Array<{ userId: string; assignments: unknown[] }>).map((a) => {
            if (a.userId === 'anne.p') return { ...a, assignments: [...a.assignments, { roleIdentifier: 'tt-skabelonansvarlig', roleConstraintValues: 'broken' }] };
            if (a.userId === 'mette.e' || a.userId === 'rune.a') return { ...a, assignments: [] };
            return a;
          }),
        });
        expect(await h.run()).toMatchObject({ status: 'aborted', errorCode: 'removal_threshold' });
        expect(await count(h.c, 'role_assignments')).toBe(10);
      }));

    it('stays below the threshold: one of nine users and one assignment go through without force', () =>
      withHarness(async (h) => {
        await h.run();
        const d = fixtureData();
        mock.setData({
          users: d.users.filter((u) => u.userId !== 'rune.a'),
          roleAssignments: (d.roleAssignments as Array<{ userId: string }>).filter((a) => a.userId !== 'rune.a'),
        });
        expect((await h.run()).status).toBe('success'); // 1/9 users, 1/10 assignments, both under 30 %
      }));

    it('ROLLEKATALOG_SYNC_MAX_REMOVAL_PERCENT is honoured', () =>
      withHarness(async (h) => {
        await h.run();
        const d = fixtureData();
        const drop = () =>
          mock.setData({
            users: d.users.filter((u) => u.userId !== 'rune.a'),
            roleAssignments: (d.roleAssignments as Array<{ userId: string }>).filter((a) => a.userId !== 'rune.a'),
          });
        drop();
        vi.stubEnv('ROLLEKATALOG_SYNC_MAX_REMOVAL_PERCENT', '5');
        expect(await h.run()).toMatchObject({ status: 'aborted', errorCode: 'removal_threshold' });
        vi.stubEnv('ROLLEKATALOG_SYNC_MAX_REMOVAL_PERCENT', '100');
        expect((await h.run()).status).toBe('success');
      }));

    it('the first sync into an empty mirror has nothing to remove, so no threshold applies', () =>
      withHarness(async (h) => {
        vi.stubEnv('ROLLEKATALOG_SYNC_MAX_REMOVAL_PERCENT', '0');
        expect((await h.run()).status).toBe('success');
      }));
  });

  describe('org tree edge cases', () => {
    it('stores an orphan with a NULL parent and never stores a cycle', () =>
      withHarness(async (h) => {
        const d = fixtureData();
        const extra = (n: number, parent: string | null) => ({
          uuid: O(n),
          name: `Ekstra ${n}`,
          parentOrgUnitUuid: parent,
          manager: null,
        });
        mock.setData({
          orgUnits: [
            ...d.orgUnits,
            extra(20, O(99)), // parent missing
            extra(21, O(22)), // cycle 21 <-> 22
            extra(22, O(21)),
            extra(23, O(23)), // self parent
            extra(24, O(22)), // hangs below the cycle
          ],
        });
        const r = await h.run();
        expect(r.status).toBe('success');
        expect(r.counts.orgUnitsOrphaned).toBe(1);
        expect(r.counts.orgUnitCyclesBroken).toBe(2);

        const parent = Object.fromEntries((await rows(h.c, 'SELECT uuid, parent_uuid FROM org_units')).map((u) => [u.uuid, u.parent_uuid]));
        expect(parent[O(20)]).toBeNull();
        expect(parent[O(21)]).toBeNull(); // cut at the smaller uuid
        expect(parent[O(22)]).toBe(O(21));
        expect(parent[O(23)]).toBeNull();
        expect(parent[O(24)]).toBe(O(22));
        for (const id of Object.keys(parent)) {
          const seen = new Set<string>();
          for (let cur: string | null = id; cur; cur = parent[cur]) {
            expect(seen.has(cur)).toBe(false);
            seen.add(cur);
          }
        }

        // Deterministic and stable: the same data again changes nothing.
        const again = await h.run();
        expect(again.counts.orgUnitsUpserted).toBe(0);
      }));

    it('a unit that moves is updated in place; a unit that disappears upstream stays (stale), with no assignments left on it', () =>
      withHarness(async (h) => {
        await h.run();
        h.clock.t += 60_000;
        const d = fixtureData();
        mock.setData({
          orgUnits: (d.orgUnits as Array<{ uuid: string; parentOrgUnitUuid: string | null }>)
            .filter((u) => u.uuid !== O(4)) // Økonomi vanishes
            .map((u) => (u.uuid === O(5) ? { ...u, parentOrgUnitUuid: O(2) } : u)), // Digital Support moves
        });
        const r = await h.run({ force: true });
        expect(r.status).toBe('success');
        expect(r.counts.orgUnitsUpserted).toBe(1);
        expect((await rows(h.c, 'SELECT parent_uuid FROM org_units WHERE uuid = $1', [O(5)]))[0].parent_uuid).toBe(O(2));
        expect(await count(h.c, 'org_units', `uuid = '${O(4)}'`)).toBe(1);
        expect(await count(h.c, 'role_assignments', `scope_org_unit_uuid = '${O(4)}'`)).toBe(0);
        // Not refreshed, so its synced_at stays behind the rest.
        const t = await rows(h.c, 'SELECT uuid, synced_at FROM org_units');
        const stale = t.find((u) => u.uuid === O(4));
        const fresh = t.find((u) => u.uuid === O(1));
        expect(stale.synced_at.getTime()).toBeLessThan(fresh.synced_at.getTime());
      }));
  });

  describe('assignments', () => {
    it('follows scope changes in place and honours ROLLEKATALOG_SCOPE_DESCENDANTS', () =>
      withHarness(async (h) => {
        await h.run();
        const idBefore = (await rows(h.c, `SELECT id FROM role_assignments WHERE directory_user_uuid = $1 AND role_key = 'tt-bruger'`, [U(3)]))[0].id;

        vi.stubEnv('ROLLEKATALOG_SCOPE_DESCENDANTS', 'false');
        const flat = await h.run({ force: true });
        expect(flat.counts.assignmentsUpserted).toBe(5); // every scoped row flips: anne 2, jens, peter, lars
        expect(flat.counts.assignmentsRemoved).toBe(0);
        expect(await count(h.c, 'role_assignments', 'scope_org_unit_uuid IS NOT NULL AND include_descendants = true')).toBe(0);
        // Unchanged rows keep their identity.
        expect((await rows(h.c, `SELECT id FROM role_assignments WHERE directory_user_uuid = $1 AND role_key = 'tt-bruger'`, [U(3)]))[0].id).toBe(idBefore);
      }));

    it('a changed constraint replaces the scope row', () =>
      withHarness(async (h) => {
        await h.run();
        const d = fixtureData();
        mock.setData({
          roleAssignments: (d.roleAssignments as Array<{ userId: string; assignments: Array<{ roleIdentifier: string; roleConstraintValues: unknown[] }> }>).map((a) =>
            a.userId === 'jens.t'
              ? {
                  ...a,
                  assignments: [
                    { roleIdentifier: 'tt-skabelonansvarlig', roleConstraintValues: [{ constraintType: 'http://digital-identity.dk/constraints/orgunit/1', constraintValues: [O(4)] }] },
                  ],
                }
              : a,
          ),
        });
        const r = await h.run();
        expect(r.counts.assignmentsUpserted).toBe(1);
        expect(r.counts.assignmentsRemoved).toBe(1);
        expect(await roleRows(h.c, U(2))).toEqual([{ role_key: 'tt-skabelonansvarlig', scope_org_unit_uuid: O(4), include_descendants: true }]);
      }));

    it('ROLLEKATALOG_GLOBAL_ROLES can make an unscoped logleser global', () =>
      withHarness(async (h) => {
        vi.stubEnv('ROLLEKATALOG_GLOBAL_ROLES', 'tt-administrator,tt-logleser');
        await h.run();
        expect(await roleRows(h.c, U(7))).toEqual([{ role_key: 'tt-logleser', scope_org_unit_uuid: null, include_descendants: true }]);
      }));
  });

  describe('members', () => {
    it('follows changes in both directions', () =>
      withHarness(async (h) => {
        await h.run();
        const d = fixtureData();
        mock.setData({
          users: d.users.map((u) => (u.userId === 'jens.t' ? { ...u, positions: [u.positions[0]] } : u)),
        });
        const r = await h.run();
        expect(r.status).toBe('success');
        expect(await count(h.c, 'org_unit_members', `directory_user_uuid = '${U(2)}'`)).toBe(1);
        expect(await count(h.c, 'org_unit_members')).toBe(11);
        // is_primary stays false and title NULL: Rollekatalog has no primary flag and the title is not whitelisted.
        expect(await count(h.c, 'org_unit_members', 'is_primary = true OR title IS NOT NULL')).toBe(0);
      }));
  });

  describe('failures and configuration', () => {
    it('an unconfigured integration is recorded as a failed run with the code, without a lock or any fetch', () =>
      withHarness(async (h) => {
        vi.stubEnv('ROLLEKATALOG_URL', '');
        const r = await h.run();
        expect(r).toMatchObject({ status: 'error', errorCode: 'not_configured' });
        expect(r.runId).toBeTruthy();
        expect(await getLatestSyncRun(h.env)).toMatchObject({ status: 'failed', errorCode: 'not_configured' });
        expect(mock.requests).toHaveLength(0);
      }));

    it('a plain http URL to a non-loopback host is "insecure_url"', () =>
      withHarness(async (h) => {
        vi.stubEnv('ROLLEKATALOG_URL', 'http://rollekatalog.example.dk');
        expect(await h.run()).toMatchObject({ status: 'error', errorCode: 'insecure_url' });
      }));

    it('a Rollekatalog failure leaves the mirror alone, with the short code only', () =>
      withHarness(async (h) => {
        await h.run();
        const before = await snapshot(h.c);
        for (const [fault, code] of [
          [{ match: '/api/organisation/v3', status: 503 }, 'server_error'],
          [{ match: '/api/read/', status: 403 }, 'forbidden'],
          [{ match: '/api/organisation/v3', status: 401 }, 'unauthorized'],
          [{ match: '/api/organisation/v3', invalidJson: true }, 'invalid_response'],
          [{ match: '/api/organisation/v3', oversize: { bytes: 2 * 1024 * 1024 } }, 'too_large'],
        ] as const) {
          mock.setFaults([fault]);
          vi.stubEnv('ROLLEKATALOG_MAX_RESPONSE_BYTES', '1048576');
          const r = await h.run();
          expect(r).toMatchObject({ status: 'error', errorCode: code });
          expect(r.counts).toEqual(expect.objectContaining({ usersUpserted: 0, assignmentsRemoved: 0 }));
          expect(await snapshot(h.c)).toEqual(before);
          expect(await getLatestSyncRun(h.env)).toMatchObject({ status: 'failed', errorCode: code });
        }
      }));

    it('only the ORG key reaches organisation and only the READ key reaches the assignments', () =>
      withHarness(async (h) => {
        await h.run();
        expect(mock.requests.map((q) => `${q.path}:${q.keyRole}`)).toEqual([
          '/api/organisation/v3:org',
          '/api/read/itsystem/roleAssignmentsWithContraints/os2taletiltekst:read',
        ]);
        expect(mock.requests.every((q) => q.status === 200)).toBe(true);
      }));

    it('a run left as running by a crash is closed when the next run holds the lock', () =>
      withHarness(async (h) => {
        await h.c.query(`INSERT INTO sync_runs (started_at, status) VALUES (now() - interval '1 hour', 'running')`);
        const r = await h.run();
        expect(r.status).toBe('success');
        const stale = await rows(h.c, `SELECT status, error_code FROM sync_runs WHERE id <> $1`, [r.runId]);
        expect(stale).toEqual([{ status: 'failed', error_code: 'abandoned' }]);
      }));

    it('getLatestSyncRun is null without runs, then the newest run', () =>
      withHarness(async (h) => {
        expect(await getLatestSyncRun(h.env)).toBeNull();
        await h.run();
        h.clock.t += 60_000;
        mock.setData({ users: [] });
        const second = await h.run();
        expect(await getLatestSyncRun(h.env)).toMatchObject({ id: second.runId, status: 'failed', errorCode: 'empty_response' });
      }));
  });
});
