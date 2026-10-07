// Needs a real Postgres 15+; skipped unless TEST_DATABASE_URL is set (see src/test/pg.ts).
import { describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { hasPg, withFreshSchema } from '@/test/pg';

/** SQLSTATE of the error a statement raises, or undefined if it succeeds. */
async function sqlState(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

const UNIQUE_VIOLATION = '23505';
// Which SQLSTATE a RESTRICT FK raises depends on when the check fires (PostgreSQL 16
// raises foreign_key_violation 23503); accept both so the test asserts the behaviour.
const RESTRICT_VIOLATIONS = ['23001', '23503'];
const CHECK_VIOLATION = '23514';

async function insertUser(c: Client, name: string): Promise<string> {
  const id = `user-${name}`;
  await c.query(`INSERT INTO users (id, name, email) VALUES ($1, $2, $3)`, [id, name, `${name}@example.dk`]);
  return id;
}

async function insertDirectoryUser(c: Client, name: string, appUserId: string | null = null): Promise<string> {
  const r = await c.query(
    `INSERT INTO directory_users (name, source, app_user_id) VALUES ($1, 'local', $2) RETURNING uuid`,
    [name, appUserId],
  );
  return r.rows[0].uuid;
}

async function insertOrgUnit(c: Client, name: string, parent: string | null = null): Promise<string> {
  const r = await c.query(
    `INSERT INTO org_units (name, parent_uuid, source) VALUES ($1, $2, 'local') RETURNING uuid`,
    [name, parent],
  );
  return r.rows[0].uuid;
}

const grant = (c: Client, user: string, role: string, scope: string | null, source = 'local') =>
  c.query(
    `INSERT INTO role_assignments (directory_user_uuid, role_key, scope_org_unit_uuid, source) VALUES ($1, $2, $3, $4)`,
    [user, role, scope, source],
  );

describe.skipIf(!hasPg)('central access migration (real Postgres)', () => {
  it('creates all central tables', () =>
    withFreshSchema(async (c) => {
      const r = await c.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()`,
      );
      const names = r.rows.map((x) => x.table_name);
      expect(names).toEqual(
        expect.arrayContaining([
          'directory_users',
          'org_units',
          'org_unit_members',
          'role_assignments',
          'external_identities',
          'external_roles',
          'user_external_roles',
          'sync_runs',
          'system_flags',
        ]),
      );
    }));

  it('system_flags: key is the primary key, value defaults to {}, set_at to now()', () =>
    withFreshSchema(async (c) => {
      await c.query(`INSERT INTO system_flags (key) VALUES ('k')`);
      const r = await c.query(`SELECT value, set_at FROM system_flags WHERE key = 'k'`);
      expect(r.rows[0].value).toEqual({});
      expect(r.rows[0].set_at).toBeInstanceOf(Date);
      expect(await sqlState(c.query(`INSERT INTO system_flags (key) VALUES ('k')`))).toBe(UNIQUE_VIOLATION);
      await c.query(`INSERT INTO system_flags (key) VALUES ('k') ON CONFLICT (key) DO NOTHING`);
    }));

  it('has dropped the unused objects and carries the FK-column indexes', () =>
    withFreshSchema(async (c, schema) => {
      const tables = (
        await c.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1`, [schema])
      ).rows.map((x) => x.table_name);
      expect(tables).not.toContain('org_unit_substitutes');
      const cols = (
        await c.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'org_units'`,
          [schema],
        )
      ).rows.map((x) => x.column_name);
      expect(cols).not.toContain('manager_uuid');
      const idx = (
        await c.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1`, [schema])
      ).rows;
      const names = idx.map((x) => x.indexname);
      // Redundant: the UNIQUE NULLS NOT DISTINCT constraint already leads with directory_user_uuid.
      expect(names).not.toContain('role_assignments_directory_user_idx');
      const def = (n: string) => idx.find((x) => x.indexname === n)?.indexdef ?? '';
      expect(def('org_unit_members_org_unit_idx')).toContain('(org_unit_uuid)');
      expect(def('role_assignments_scope_idx')).toContain('(scope_org_unit_uuid)');
    }));

  it('rejects a duplicate GLOBAL role assignment (NULLS NOT DISTINCT)', () =>
    withFreshSchema(async (c) => {
      const du = await insertDirectoryUser(c, 'a');
      await grant(c, du, 'tt-logleser', null);
      expect(await sqlState(grant(c, du, 'tt-logleser', null))).toBe(UNIQUE_VIOLATION);
    }));

  it('allows the same role with a different scope, source or role', () =>
    withFreshSchema(async (c) => {
      const du = await insertDirectoryUser(c, 'a');
      const ou = await insertOrgUnit(c, 'Enhed');
      await grant(c, du, 'tt-logleser', null);
      await grant(c, du, 'tt-logleser', ou);
      await grant(c, du, 'tt-logleser', null, 'rollekatalog');
      await grant(c, du, 'tt-skabelonansvarlig', null);
      expect(await sqlState(grant(c, du, 'tt-logleser', ou))).toBe(UNIQUE_VIOLATION);
    }));

  it('rejects bad source / status vocabulary values', () =>
    withFreshSchema(async (c) => {
      const du = await insertDirectoryUser(c, 'a');
      expect(
        await sqlState(c.query(`INSERT INTO directory_users (name, source) VALUES ('x', 'ldap')`)),
      ).toBe(CHECK_VIOLATION);
      expect(await sqlState(c.query(`INSERT INTO org_units (name, source) VALUES ('x', 'ldap')`))).toBe(
        CHECK_VIOLATION,
      );
      expect(await sqlState(grant(c, du, 'tt-bruger', null, 'ldap'))).toBe(CHECK_VIOLATION);
      expect(await sqlState(c.query(`INSERT INTO sync_runs (status) VALUES ('weird')`))).toBe(
        CHECK_VIOLATION,
      );
      expect(await sqlState(c.query(`INSERT INTO sync_runs (status) VALUES ('running')`))).toBeUndefined();
    }));

  it('rejects stop_date <= start_date but allows open-ended and ordered ranges', () =>
    withFreshSchema(async (c) => {
      const du = await insertDirectoryUser(c, 'a');
      const insert = (role: string, start: string | null, stop: string | null) =>
        c.query(
          `INSERT INTO role_assignments (directory_user_uuid, role_key, source, start_date, stop_date)
           VALUES ($1, $2, 'local', $3, $4)`,
          [du, role, start, stop],
        );
      expect(await sqlState(insert('tt-bruger', '2026-02-01', '2026-01-01'))).toBe(CHECK_VIOLATION);
      expect(await sqlState(insert('tt-bruger', '2026-01-01', '2026-01-01'))).toBe(CHECK_VIOLATION);
      expect(await sqlState(insert('tt-logleser', '2026-01-01', '2026-02-01'))).toBeUndefined();
      expect(await sqlState(insert('tt-skabelonansvarlig', null, '2026-02-01'))).toBeUndefined();
      expect(await sqlState(insert('tt-administrator', '2026-01-01', null))).toBeUndefined();
    }));

  it('org_units self-FK is RESTRICT: a parent with children cannot be deleted', () =>
    withFreshSchema(async (c) => {
      const parent = await insertOrgUnit(c, 'Forælder');
      const child = await insertOrgUnit(c, 'Barn', parent);
      expect(RESTRICT_VIOLATIONS).toContain(await sqlState(c.query(`DELETE FROM org_units WHERE uuid = $1`, [parent])));
      await c.query(`DELETE FROM org_units WHERE uuid = $1`, [child]);
      expect(await sqlState(c.query(`DELETE FROM org_units WHERE uuid = $1`, [parent]))).toBeUndefined();
    }));

  it('one app user maps to at most one directory user', () =>
    withFreshSchema(async (c) => {
      const u = await insertUser(c, 'a');
      await insertDirectoryUser(c, 'first', u);
      expect(await sqlState(insertDirectoryUser(c, 'second', u))).toBe(UNIQUE_VIOLATION);
      // Several unlinked directory users are fine (NULLs are distinct here).
      await insertDirectoryUser(c, 'x');
      await insertDirectoryUser(c, 'y');
    }));

  it('deleting an app user unlinks the directory user instead of deleting it', () =>
    withFreshSchema(async (c) => {
      const u = await insertUser(c, 'a');
      const du = await insertDirectoryUser(c, 'first', u);
      await c.query(`DELETE FROM users WHERE id = $1`, [u]);
      const r = await c.query(`SELECT app_user_id FROM directory_users WHERE uuid = $1`, [du]);
      expect(r.rows).toEqual([{ app_user_id: null }]);
    }));

  it('cascades: deleting a directory user or org unit removes its assignments and memberships', () =>
    withFreshSchema(async (c) => {
      const du = await insertDirectoryUser(c, 'a');
      const ou = await insertOrgUnit(c, 'Enhed');
      await c.query(`INSERT INTO org_unit_members (directory_user_uuid, org_unit_uuid) VALUES ($1, $2)`, [du, ou]);
      await grant(c, du, 'tt-skabelonansvarlig', ou);
      await c.query(`DELETE FROM org_units WHERE uuid = $1`, [ou]);
      expect((await c.query(`SELECT 1 FROM role_assignments`)).rowCount).toBe(0);
      expect((await c.query(`SELECT 1 FROM org_unit_members`)).rowCount).toBe(0);
    }));

  it('external_identities is unique per (provider_id, subject)', () =>
    withFreshSchema(async (c) => {
      const u1 = await insertUser(c, 'a');
      const u2 = await insertUser(c, 'b');
      const ins = (user: string, provider: string, subject: string) =>
        c.query(`INSERT INTO external_identities (user_id, provider_id, subject) VALUES ($1, $2, $3)`, [
          user,
          provider,
          subject,
        ]);
      await ins(u1, 'oidc', 's1');
      expect(await sqlState(ins(u2, 'oidc', 's1'))).toBe(UNIQUE_VIOLATION);
      expect(await sqlState(ins(u2, 'microsoft', 's1'))).toBeUndefined();
    }));
});
