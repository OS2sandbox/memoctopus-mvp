// Needs a real Postgres 15+; skipped unless TEST_DATABASE_URL is set (see src/test/pg.ts).
// Proves what the mocked tests cannot: the last-administrator guard and cycle
// prevention against real SQL, including races between concurrent transactions.
// The code under test writes public.<table>; here that qualifier is redirected
// to the throwaway schema so nothing touches real data.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import { addUser, hasPg, schemaRunner, withFreshSchema } from '@/test/pg';
import type { SqlRunner } from './pg-runner';

vi.mock('@/lib/db', () => ({ pool: {} }));

import { ConflictError } from './access-errors';
import { MAX_ORG_DEPTH } from './scope';
import {
  createOrgUnit,
  deleteOrgUnit,
  grantRole,
  listAppUsersWithRoles,
  revokeAssignment,
  setOrgUnitMembers,
  updateOrgUnit,
} from './access-admin';

async function activeAdmins(c: Client): Promise<number> {
  const r = await c.query(
    `SELECT count(*)::int AS n FROM role_assignments
      WHERE role_key = 'admin' AND (stop_date IS NULL OR stop_date > now())`,
  );
  return r.rows[0].n;
}

const rejectedWith = (r: PromiseSettledResult<unknown>, code: string) =>
  r.status === 'rejected' && r.reason instanceof ConflictError && r.reason.code === code;

beforeEach(() => {
  vi.stubEnv('ACCESS_SOURCE', 'local');
});
afterEach(() => vi.unstubAllEnvs());

describe.skipIf(!hasPg)('access-admin (real Postgres)', () => {
  describe('roles and the last-administrator guard', () => {
    it('links a role to the app user directly, never to a directory row that merely shares the email', () =>
      withFreshSchema(async (c, schema) => {
        const { runner, close } = schemaRunner(c, schema);
        await addUser(c, 'victim', 'boss@example.dk');
        // A synced row for the same address, not linked to any app account.
        const synced = await c.query(
          `INSERT INTO directory_users (name, email, source) VALUES ('Boss', 'boss@example.dk', 'rollekatalog') RETURNING uuid`,
        );
        const a = await grantRole({ appUserId: 'victim', roleKey: 'admin', actorUserId: 'x' }, runner);

        const owner = await c.query(
          'SELECT du.uuid, du.app_user_id, du.source FROM role_assignments ra JOIN directory_users du ON du.uuid = ra.directory_user_uuid WHERE ra.id = $1',
          [a.id],
        );
        expect(owner.rows[0].app_user_id).toBe('victim');
        expect(owner.rows[0].source).toBe('local');
        expect(owner.rows[0].uuid).not.toBe(synced.rows[0].uuid);
        await close();
      }));

    it('a repeated global grant conflicts (NULLS NOT DISTINCT), and the directory row is created once', () =>
      withFreshSchema(async (c, schema) => {
        const { runner, close } = schemaRunner(c, schema);
        await addUser(c, 'u1');
        await grantRole({ appUserId: 'u1', roleKey: 'admin', actorUserId: 'x' }, runner);
        await expect(grantRole({ appUserId: 'u1', roleKey: 'admin', actorUserId: 'x' }, runner)).rejects.toMatchObject({
          code: 'already_assigned',
        });
        await grantRole({ appUserId: 'u1', roleKey: 'bruger', actorUserId: 'x' }, runner);
        expect((await c.query('SELECT count(*)::int AS n FROM directory_users')).rows[0].n).toBe(1);
        await close();
      }));

    it('lists users with their roles and org unit names', () =>
      withFreshSchema(async (c, schema) => {
        const { runner, close } = schemaRunner(c, schema);
        await addUser(c, 'u1');
        await addUser(c, 'u2');
        const unit = await createOrgUnit({ name: 'Borgerservice', actorUserId: 'x' }, runner);
        await grantRole({ appUserId: 'u1', roleKey: 'bygger', scopeOrgUnitUuid: unit.uuid, actorUserId: 'x' }, runner);
        const { users } = await listAppUsersWithRoles({}, runner);
        expect(users.map((u) => [u.id, u.roles.length])).toEqual([['u1', 1], ['u2', 0]]);
        expect(users[0].roles[0]).toMatchObject({ scopeOrgUnitName: 'Borgerservice', active: true, source: 'local' });
        expect((await listAppUsersWithRoles({ q: 'U2' }, runner)).users.map((u) => u.id)).toEqual(['u2']);
        const capped = await listAppUsersWithRoles({ limit: 1 }, runner);
        expect(capped.users.map((u) => u.id)).toEqual(['u1']);
        expect(capped.truncated).toBe(true);
        await close();
      }));

    it('refuses to revoke the last administrator; allows it while another remains', () =>
      withFreshSchema(async (c, schema) => {
        const { runner, close } = schemaRunner(c, schema);
        await addUser(c, 'a1');
        await addUser(c, 'a2');
        const g1 = await grantRole({ appUserId: 'a1', roleKey: 'admin', actorUserId: 'a1' }, runner);
        await expect(revokeAssignment(g1.id, 'a1', runner)).rejects.toMatchObject({ code: 'last_administrator' });
        expect(await activeAdmins(c)).toBe(1);

        const g2 = await grantRole({ appUserId: 'a2', roleKey: 'admin', actorUserId: 'a1' }, runner);
        await revokeAssignment(g1.id, 'a1', runner);
        expect(await activeAdmins(c)).toBe(1);
        await expect(revokeAssignment(g2.id, 'a2', runner)).rejects.toMatchObject({ code: 'last_administrator' });
        await close();
      }));

    it('does not count expired, disabled, unlinked or synced administrators as "another admin"', () =>
      withFreshSchema(async (c, schema) => {
        const { runner, close } = schemaRunner(c, schema);
        await addUser(c, 'a1');
        await addUser(c, 'expired');
        await addUser(c, 'disabled');
        const g1 = await grantRole({ appUserId: 'a1', roleKey: 'admin', actorUserId: 'a1' }, runner);

        const exp = await grantRole({ appUserId: 'expired', roleKey: 'admin', actorUserId: 'a1' }, runner);
        await c.query(`UPDATE role_assignments SET start_date = now() - interval '2 days', stop_date = now() - interval '1 day' WHERE id = $1`, [exp.id]);

        await grantRole({ appUserId: 'disabled', roleKey: 'admin', actorUserId: 'a1' }, runner);
        await c.query(`UPDATE directory_users SET disabled = true WHERE app_user_id = 'disabled'`);

        const orphan = await c.query(`INSERT INTO directory_users (name, source) VALUES ('Ingen konto', 'local') RETURNING uuid`);
        await c.query(`INSERT INTO role_assignments (directory_user_uuid, role_key, source) VALUES ($1, 'admin', 'local')`, [orphan.rows[0].uuid]);
        const synced = await c.query(`INSERT INTO directory_users (name, source, app_user_id) VALUES ('Synk', 'rollekatalog', NULL) RETURNING uuid`);
        await c.query(`INSERT INTO role_assignments (directory_user_uuid, role_key, source) VALUES ($1, 'admin', 'rollekatalog')`, [synced.rows[0].uuid]);

        await expect(revokeAssignment(g1.id, 'a1', runner)).rejects.toMatchObject({ code: 'last_administrator' });
        await close();
      }));

    it('an administrator grant with a stop_date does not make the last permanent administrator expendable', () =>
      withFreshSchema(async (c, schema) => {
        const { runner, close } = schemaRunner(c, schema);
        await addUser(c, 'a1');
        await addUser(c, 'a2');
        const g1 = await grantRole({ appUserId: 'a1', roleKey: 'admin', actorUserId: 'a1' }, runner);
        const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
        const g2 = await grantRole(
          { appUserId: 'a2', roleKey: 'admin', stopDate: tomorrow, actorUserId: 'a1' },
          runner,
        );
        // a1 is the only PERMANENT administrator: self-revoke must be refused.
        await expect(revokeAssignment(g1.id, 'a1', runner)).rejects.toMatchObject({ code: 'last_administrator' });
        // Revoking the expiring one is fine (it never counted), the permanent one stays.
        await revokeAssignment(g2.id, 'a1', runner);
        expect(await activeAdmins(c)).toBe(1);
        await close();
      }));

    it('never edits a rollekatalog-sourced assignment', () =>
      withFreshSchema(async (c, schema) => {
        const { runner, close } = schemaRunner(c, schema);
        const d = await c.query(`INSERT INTO directory_users (name, source) VALUES ('Synk', 'rollekatalog') RETURNING uuid`);
        const a = await c.query(`INSERT INTO role_assignments (directory_user_uuid, role_key, source) VALUES ($1, 'bygger', 'rollekatalog') RETURNING id`, [d.rows[0].uuid]);
        await expect(revokeAssignment(a.rows[0].id, 'x', runner)).rejects.toMatchObject({ code: 'not_local' });
        expect((await c.query('SELECT count(*)::int AS n FROM role_assignments')).rows[0].n).toBe(1);
        await close();
      }));

    it('CONCURRENCY: two admins revoking each other at once leave at least one', () =>
      withFreshSchema(async (c, schema) => {
        const { runner, close } = schemaRunner(c, schema);
        await addUser(c, 'a1');
        await addUser(c, 'a2');
        let a1 = (await grantRole({ appUserId: 'a1', roleKey: 'admin', actorUserId: 'a1' }, runner)).id;
        let a2 = (await grantRole({ appUserId: 'a2', roleKey: 'admin', actorUserId: 'a1' }, runner)).id;

        for (let round = 0; round < 8; round++) {
          const results = await Promise.allSettled([revokeAssignment(a1, 'a1', runner), revokeAssignment(a2, 'a2', runner)]);
          expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
          expect(results.filter((r) => rejectedWith(r, 'last_administrator'))).toHaveLength(1);
          expect(await activeAdmins(c)).toBe(1);
          // Restore the revoked one for the next round.
          if (results[0].status === 'fulfilled') {
            a1 = (await grantRole({ appUserId: 'a1', roleKey: 'admin', actorUserId: 'a2' }, runner)).id;
          } else {
            a2 = (await grantRole({ appUserId: 'a2', roleKey: 'admin', actorUserId: 'a1' }, runner)).id;
          }
        }
        await close();
      }));

    it('CONCURRENCY: three administrators all revoked at once leave exactly one', () =>
      withFreshSchema(async (c, schema) => {
        const { runner, close } = schemaRunner(c, schema);
        const ids: string[] = [];
        for (const u of ['a1', 'a2', 'a3']) {
          await addUser(c, u);
          ids.push((await grantRole({ appUserId: u, roleKey: 'admin', actorUserId: u }, runner)).id);
        }
        const results = await Promise.allSettled(ids.map((id, i) => revokeAssignment(id, `a${i + 1}`, runner)));
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
        expect(await activeAdmins(c)).toBe(1);
        await close();
      }));
  });

  describe('organisation tree', () => {
    async function chain(runner: SqlRunner) {
      const a = await createOrgUnit({ name: 'A', actorUserId: 'x' }, runner);
      const b = await createOrgUnit({ name: 'B', parentUuid: a.uuid, actorUserId: 'x' }, runner);
      const cUnit = await createOrgUnit({ name: 'C', parentUuid: b.uuid, actorUserId: 'x' }, runner);
      return { a: a.uuid, b: b.uuid, c: cUnit.uuid };
    }

    it('refuses moves that would create a cycle and leaves the tree untouched', () =>
      withFreshSchema(async (c, schema) => {
        const { runner, close } = schemaRunner(c, schema);
        const { a, b, c: leaf } = await chain(runner);

        await expect(updateOrgUnit(a, { parentUuid: a }, 'x', runner)).rejects.toMatchObject({ code: 'self_parent' });
        await expect(updateOrgUnit(a, { parentUuid: leaf }, 'x', runner)).rejects.toMatchObject({ code: 'cycle' });
        await expect(updateOrgUnit(a, { parentUuid: b }, 'x', runner)).rejects.toMatchObject({ code: 'cycle' });
        await expect(updateOrgUnit(b, { parentUuid: leaf }, 'x', runner)).rejects.toMatchObject({ code: 'cycle' });

        const rows = await c.query('SELECT uuid, parent_uuid FROM org_units');
        const parents = new Map(rows.rows.map((r) => [r.uuid, r.parent_uuid]));
        expect(parents.get(a)).toBeNull();
        expect(parents.get(b)).toBe(a);
        expect(parents.get(leaf)).toBe(b);
        await close();
      }));

    it('refuses a cycle even when the chain is deeper than the scope-read depth cap', () =>
      withFreshSchema(async (c, schema) => {
        const { runner, close } = schemaRunner(c, schema);
        const ids: string[] = [];
        for (let i = 0; i < MAX_ORG_DEPTH + 7; i++) {
          const u = await createOrgUnit(
            { name: `n${i}`, parentUuid: ids[i - 1] ?? null, actorUserId: 'x' },
            runner,
          );
          ids.push(u.uuid);
        }
        await expect(updateOrgUnit(ids[0], { parentUuid: ids.at(-1)! }, 'x', runner)).rejects.toMatchObject({
          code: 'cycle',
        });
        const root = await c.query('SELECT parent_uuid FROM org_units WHERE uuid = $1', [ids[0]]);
        expect(root.rows[0].parent_uuid).toBeNull();
        await close();
      }), 60_000);

    it('allows legal moves (up, sideways, to root)', () =>
      withFreshSchema(async (c, schema) => {
        const { runner, close } = schemaRunner(c, schema);
        const { a, b, c: leaf } = await chain(runner);
        const other = (await createOrgUnit({ name: 'D', actorUserId: 'x' }, runner)).uuid;
        await updateOrgUnit(leaf, { parentUuid: a }, 'x', runner);
        await updateOrgUnit(b, { parentUuid: other }, 'x', runner);
        await updateOrgUnit(b, { parentUuid: null }, 'x', runner);
        const r = await c.query('SELECT uuid, parent_uuid FROM org_units');
        const parents = new Map(r.rows.map((x) => [x.uuid, x.parent_uuid]));
        expect(parents.get(leaf)).toBe(a);
        expect(parents.get(b)).toBeNull();
        await close();
      }));

    it('CONCURRENCY: A under B and B under A at once never produce a cycle', () =>
      withFreshSchema(async (c, schema) => {
        const { runner, close } = schemaRunner(c, schema);
        for (let round = 0; round < 8; round++) {
          const a = (await createOrgUnit({ name: `A${round}`, actorUserId: 'x' }, runner)).uuid;
          const b = (await createOrgUnit({ name: `B${round}`, actorUserId: 'x' }, runner)).uuid;
          const results = await Promise.allSettled([
            updateOrgUnit(a, { parentUuid: b }, 'x', runner),
            updateOrgUnit(b, { parentUuid: a }, 'x', runner),
          ]);
          expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
          expect(results.filter((r) => rejectedWith(r, 'cycle'))).toHaveLength(1);
          const rows = (await c.query('SELECT uuid, parent_uuid FROM org_units WHERE uuid = ANY($1::uuid[])', [[a, b]])).rows;
          // exactly one of the two is a root
          expect(rows.filter((r) => r.parent_uuid === null)).toHaveLength(1);
        }
        await close();
      }));

    it('refuses to edit or delete a unit that Rollekatalog synced, and to put members in it', () =>
      withFreshSchema(async (c, schema) => {
        const { runner, close } = schemaRunner(c, schema);
        const u = (await c.query(`INSERT INTO org_units (name, source) VALUES ('Synk', 'rollekatalog') RETURNING uuid`)).rows[0].uuid;
        await expect(updateOrgUnit(u, { name: 'Nyt' }, 'x', runner)).rejects.toMatchObject({ code: 'not_local' });
        await expect(deleteOrgUnit(u, 'x', runner)).rejects.toMatchObject({ code: 'not_local' });
        await expect(setOrgUnitMembers(u, [], 'x', runner)).rejects.toMatchObject({ code: 'not_local' });
        await close();
      }));

    it('refuses to delete a unit with children or with role assignments scoped to it', () =>
      withFreshSchema(async (c, schema) => {
        const { runner, close } = schemaRunner(c, schema);
        const { a, b, c: leaf } = await chain(runner);
        await expect(deleteOrgUnit(a, 'x', runner)).rejects.toMatchObject({ code: 'has_children' });

        await addUser(c, 'm1');
        await grantRole({ appUserId: 'm1', roleKey: 'bygger', scopeOrgUnitUuid: leaf, actorUserId: 'x' }, runner);
        await expect(deleteOrgUnit(leaf, 'x', runner)).rejects.toMatchObject({ code: 'has_role_assignments' });
        expect((await c.query('SELECT count(*)::int AS n FROM role_assignments')).rows[0].n).toBe(1);

        await c.query('DELETE FROM role_assignments');
        await deleteOrgUnit(leaf, 'x', runner);
        await deleteOrgUnit(b, 'x', runner);
        await deleteOrgUnit(a, 'x', runner);
        expect((await c.query('SELECT count(*)::int AS n FROM org_units')).rows[0].n).toBe(0);
        await close();
      }));

    it('refuses to delete a unit that is a target of a central template (the FK would cascade silently)', () =>
      withFreshSchema(async (c, schema) => {
        const { runner, close } = schemaRunner(c, schema);
        const owner = (await c.query(`INSERT INTO org_units (name, source) VALUES ('Ejer', 'local') RETURNING uuid`)).rows[0].uuid;
        const target = (await c.query(`INSERT INTO org_units (name, source) VALUES ('Mål', 'local') RETURNING uuid`)).rows[0].uuid;
        const tpl = (await c.query(`INSERT INTO central_templates (owner_org_unit_uuid, name, prompt) VALUES ($1, 'x', 'p') RETURNING id`, [owner])).rows[0].id;
        await c.query('INSERT INTO central_template_targets (template_id, org_unit_uuid) VALUES ($1, $2)', [tpl, target]);
        await expect(deleteOrgUnit(target, 'x', runner)).rejects.toMatchObject({ code: 'has_template_targets' });
        expect((await c.query('SELECT count(*)::int AS n FROM central_template_targets')).rows[0].n).toBe(1);
        await close();
      }));

    it('CONCURRENCY: a grant scoped to a unit and the deletion of that unit never lose the assignment silently', () =>
      withFreshSchema(async (c, schema) => {
        const { runner, close } = schemaRunner(c, schema);
        await addUser(c, 'm1');
        for (let round = 0; round < 8; round++) {
          const u = (await createOrgUnit({ name: `U${round}`, actorUserId: 'x' }, runner)).uuid;
          const [grant, del] = await Promise.allSettled([
            grantRole({ appUserId: 'm1', roleKey: 'bygger', scopeOrgUnitUuid: u, actorUserId: 'x' }, runner),
            deleteOrgUnit(u, 'x', runner),
          ]);
          const unitExists = (await c.query('SELECT 1 FROM org_units WHERE uuid = $1', [u])).rows.length === 1;
          const assigned = (await c.query('SELECT 1 FROM role_assignments WHERE scope_org_unit_uuid = $1', [u])).rows.length === 1;
          // Either the unit is gone and nothing was granted, or the grant stands and the delete was refused.
          if (grant.status === 'fulfilled') {
            expect(unitExists && assigned).toBe(true);
            expect(del.status).toBe('rejected');
          } else {
            expect(unitExists).toBe(false);
            expect(assigned).toBe(false);
          }
        }
        await close();
      }));
  });

  describe('members', () => {
    it('replaces the membership, creating local directory rows, and is idempotent', () =>
      withFreshSchema(async (c, schema) => {
        const { runner, close } = schemaRunner(c, schema);
        for (const u of ['u1', 'u2', 'u3']) await addUser(c, u);
        const unit = (await createOrgUnit({ name: 'Enhed', actorUserId: 'x' }, runner)).uuid;

        const first = await setOrgUnitMembers(unit, ['u1', 'u2'], 'x', runner);
        expect(first.map((m) => m.appUserId).sort()).toEqual(['u1', 'u2']);
        const second = await setOrgUnitMembers(unit, ['u2', 'u3', 'u2'], 'x', runner);
        expect(second.map((m) => m.appUserId).sort()).toEqual(['u2', 'u3']);
        expect((await setOrgUnitMembers(unit, ['u2', 'u3'], 'x', runner)).length).toBe(2);
        expect((await setOrgUnitMembers(unit, [], 'x', runner)).length).toBe(0);

        await expect(setOrgUnitMembers(unit, ['ghost'], 'x', runner)).rejects.toMatchObject({ code: 'user_not_found' });
        expect((await c.query('SELECT count(*)::int AS n FROM directory_users')).rows[0].n).toBe(3);
        await close();
      }));
  });
});
