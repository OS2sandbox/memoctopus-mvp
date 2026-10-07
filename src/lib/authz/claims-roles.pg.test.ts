// Needs a real Postgres 15+; skipped unless TEST_DATABASE_URL is set (see src/test/pg.ts).
// Proves what the unit tests only describe: the claims replacement is one transaction, replaces
// instead of accumulating, never touches other sources, and the catalogue is enforced by the database.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import { addUser, hasPg, schemaRunner, withFreshSchema } from '@/test/pg';
import type { ClaimListSpec, RolesConfig } from '@/lib/auth/providers';

vi.mock('@/lib/db', () => ({ pool: {} }));

const state: { roles: RolesConfig; specs: { claims: object; rolesClaim?: ClaimListSpec; groupsClaim?: ClaimListSpec } | null } = {
  roles: { state: 'unset' },
  specs: null,
};
vi.mock('@/lib/auth/providers', () => ({
  authRolesConfig: () => state.roles,
  providerClaimSpecs: () => state.specs,
  authConfigCatalogue: () => [],
}));

import { applyClaimsLogin, clearClaimsRoles } from './claims-roles';
import { syncConfigCatalogue } from './external-roles';
import { captureIdentityFromAttributes } from './identity';

const CHECK_VIOLATION = '23514';
const FK_VIOLATION = '23503';

const role = (m: Record<string, string>) => new Map(Object.entries(m).map(([k, r]) => [k, { role: r as never, global: true }]));

async function catalogue(c: Client, rows: Array<[kind: string, identifier: string, active?: boolean]>) {
  for (const [kind, identifier, active = true] of rows) {
    await c.query(`INSERT INTO external_roles (kind, identifier, name, source, active) VALUES ($1, $2, $2, 'config', $3)`, [kind, identifier, active]);
  }
}
const claimRoles = async (c: Client, userId: string) =>
  (
    await c.query(
      `SELECT ra.role_key FROM role_assignments ra JOIN directory_users du ON du.uuid = ra.directory_user_uuid
        WHERE du.app_user_id = $1 AND ra.source = 'claims' ORDER BY ra.role_key`,
      [userId],
    )
  ).rows.map((r) => r.role_key);
const external = async (c: Client, userId: string) =>
  (await c.query('SELECT kind, identifier FROM user_external_roles WHERE user_id = $1 ORDER BY kind, identifier', [userId])).rows.map(
    (r) => `${r.kind}:${r.identifier}`,
  );

beforeEach(() => {
  vi.stubEnv('ACCESS_SOURCE', 'claims');
  state.roles = {
    state: 'ok',
    appRoleMap: role({ admin: 'tt-administrator', su: 'tt-skabelonansvarlig' }),
    groupRoleMap: role({ 'g-log': 'tt-logleser' }),
  };
  state.specs = {
    claims: {},
    rolesClaim: { name: 'roles', format: 'array', separator: ',' },
    groupsClaim: { name: 'memberOf', format: 'delimited', separator: ';' },
  };
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const login = (userId: string, claims: Record<string, unknown> | null) => ({ userId, providerId: 'oidc', claims });

describe.skipIf(!hasPg)('claims roles (real Postgres)', () => {
  it('first login creates the directory row (source claims), the global role rows and the catalogue-filtered external roles', () =>
    withFreshSchema(async (c, schema) => {
      const { runner, close } = schemaRunner(c, schema);
      await addUser(c, 'u1');
      await catalogue(c, [['role', 'admin'], ['group', 'g-log'], ['role', 'old', false], ['group', 'admin']]);

      const res = await applyClaimsLogin(login('u1', { roles: ['admin', 'unknown'], memberOf: 'g-log;old;g-none' }), runner);
      expect(res).toMatchObject({ outcome: 'applied', rolesWritten: 2, externalStored: 2 });

      expect((await c.query(`SELECT source, disabled FROM directory_users WHERE app_user_id = 'u1'`)).rows).toEqual([{ source: 'claims', disabled: false }]);
      expect(await claimRoles(c, 'u1')).toEqual(['tt-administrator', 'tt-logleser']);
      const rows = (await c.query(`SELECT scope_org_unit_uuid, include_descendants, start_date, stop_date, synced_at FROM role_assignments`)).rows;
      expect(rows.every((r) => r.scope_org_unit_uuid === null && r.start_date === null && r.stop_date === null && r.synced_at instanceof Date)).toBe(true);
      // 'unknown', 'g-none' and the INACTIVE catalogue entry 'old' are not stored; 'admin' as a GROUP is a different key.
      expect(await external(c, 'u1')).toEqual(['group:g-log', 'role:admin']);
      await close();
    }));

  it('the next login REPLACES: removed roles and groups drop, nothing accumulates, one directory row', () =>
    withFreshSchema(async (c, schema) => {
      const { runner, close } = schemaRunner(c, schema);
      await addUser(c, 'u1');
      await catalogue(c, [['role', 'admin'], ['role', 'su'], ['group', 'g-log']]);
      await applyClaimsLogin(login('u1', { roles: ['admin', 'su'], memberOf: 'g-log' }), runner);
      expect(await claimRoles(c, 'u1')).toEqual(['tt-administrator', 'tt-logleser', 'tt-skabelonansvarlig']);

      await applyClaimsLogin(login('u1', { roles: ['su'] }), runner);
      expect(await claimRoles(c, 'u1')).toEqual(['tt-skabelonansvarlig']);
      expect(await external(c, 'u1')).toEqual(['role:su']);
      expect((await c.query(`SELECT count(*)::int AS n FROM directory_users`)).rows[0].n).toBe(1);

      await applyClaimsLogin(login('u1', { roles: [] }), runner);
      expect(await claimRoles(c, 'u1')).toEqual([]);
      expect(await external(c, 'u1')).toEqual([]);
      await close();
    }));

  it('a malformed claim, or no claims at all, keeps nothing (fail closed)', () =>
    withFreshSchema(async (c, schema) => {
      const { runner, close } = schemaRunner(c, schema);
      await addUser(c, 'u1');
      await catalogue(c, [['role', 'admin']]);
      await applyClaimsLogin(login('u1', { roles: ['admin'] }), runner);
      expect(await claimRoles(c, 'u1')).toEqual(['tt-administrator']);
      await applyClaimsLogin(login('u1', { roles: { not: 'a list' } }), runner);
      expect(await claimRoles(c, 'u1')).toEqual([]);
      expect(await external(c, 'u1')).toEqual([]);

      await applyClaimsLogin(login('u1', { roles: ['admin'] }), runner);
      await applyClaimsLogin(login('u1', null), runner);
      expect(await claimRoles(c, 'u1')).toEqual([]);

      // An unusable roles section: nothing granted, though the catalogue values are still recorded.
      await applyClaimsLogin(login('u1', { roles: ['admin'] }), runner);
      state.roles = { state: 'invalid' };
      await applyClaimsLogin(login('u1', { roles: ['admin'] }), runner);
      expect(await claimRoles(c, 'u1')).toEqual([]);
      expect(await external(c, 'u1')).toEqual(['role:admin']);
      await close();
    }));

  it('never touches rows of another source, and uses the person\'s existing directory row', () =>
    withFreshSchema(async (c, schema) => {
      const { runner, close } = schemaRunner(c, schema);
      await addUser(c, 'u1');
      const du = (await c.query(`INSERT INTO directory_users (name, source, app_user_id) VALUES ('U', 'local', 'u1') RETURNING uuid`)).rows[0].uuid;
      await c.query(`INSERT INTO role_assignments (directory_user_uuid, role_key, source) VALUES ($1, 'tt-logleser', 'local')`, [du]);
      await c.query(`INSERT INTO role_assignments (directory_user_uuid, role_key, source, synced_at) VALUES ($1, 'tt-administrator', 'rollekatalog', now())`, [du]);
      await catalogue(c, [['role', 'admin']]);

      await applyClaimsLogin(login('u1', { roles: ['admin'] }), runner);
      await applyClaimsLogin(login('u1', { roles: [] }), runner);
      const left = (await c.query(`SELECT role_key, source FROM role_assignments ORDER BY source`)).rows;
      expect(left).toEqual([
        { role_key: 'tt-logleser', source: 'local' },
        { role_key: 'tt-administrator', source: 'rollekatalog' },
      ]);
      expect((await c.query(`SELECT count(*)::int AS n FROM directory_users`)).rows[0].n).toBe(1);
      await close();
    }));

  it('a disabled person gets nothing written, and loses what claims gave before', () =>
    withFreshSchema(async (c, schema) => {
      const { runner, close } = schemaRunner(c, schema);
      await addUser(c, 'u1');
      await catalogue(c, [['role', 'admin']]);
      await applyClaimsLogin(login('u1', { roles: ['admin'] }), runner);
      await c.query(`UPDATE directory_users SET disabled = true WHERE app_user_id = 'u1'`);
      const res = await applyClaimsLogin(login('u1', { roles: ['admin'] }), runner);
      expect(res.outcome).toBe('skipped_disabled');
      expect(await claimRoles(c, 'u1')).toEqual([]);
      expect(await external(c, 'u1')).toEqual([]);
      await close();
    }));

  it('concurrent logins of one person end in a consistent state with one directory row', () =>
    withFreshSchema(async (c, schema) => {
      const { runner, close } = schemaRunner(c, schema);
      await addUser(c, 'u1');
      await catalogue(c, [['role', 'admin'], ['role', 'su']]);
      await Promise.all(
        Array.from({ length: 6 }, (_v, i) => applyClaimsLogin(login('u1', { roles: i % 2 ? ['admin'] : ['su'] }), runner)),
      );
      const roles = await claimRoles(c, 'u1');
      expect(roles).toHaveLength(1);
      expect(['tt-administrator', 'tt-skabelonansvarlig']).toContain(roles[0]);
      expect((await external(c, 'u1'))).toHaveLength(1);
      expect((await c.query(`SELECT count(*)::int AS n FROM directory_users`)).rows[0].n).toBe(1);
      await close();
    }));

  it('a failure half way through rolls the whole replacement back', () =>
    withFreshSchema(async (c, schema) => {
      const { runner, close } = schemaRunner(c, schema);
      await addUser(c, 'u1');
      await catalogue(c, [['role', 'admin']]);
      await applyClaimsLogin(login('u1', { roles: ['admin'] }), runner);
      // A role key the CHECK-free table accepts but a broken external_roles row cannot: make the LAST step fail.
      await c.query(`ALTER TABLE user_external_roles ADD CONSTRAINT zz_fail CHECK (identifier <> 'su')`);
      await c.query(`INSERT INTO external_roles (kind, identifier, name, source) VALUES ('role', 'su', 'su', 'config')`);
      await expect(applyClaimsLogin(login('u1', { roles: ['su'] }), runner)).rejects.toMatchObject({ code: CHECK_VIOLATION });
      expect(await claimRoles(c, 'u1')).toEqual(['tt-administrator']); // untouched
      expect(await external(c, 'u1')).toEqual(['role:admin']);
      await close();
    }));

  it('clearClaimsRoles removes the claims rows and external roles only', () =>
    withFreshSchema(async (c, schema) => {
      const { runner, close } = schemaRunner(c, schema);
      await addUser(c, 'u1');
      await catalogue(c, [['role', 'admin']]);
      await applyClaimsLogin(login('u1', { roles: ['admin'] }), runner);
      const du = (await c.query(`SELECT uuid FROM directory_users WHERE app_user_id = 'u1'`)).rows[0].uuid;
      await c.query(`INSERT INTO role_assignments (directory_user_uuid, role_key, source) VALUES ($1, 'tt-logleser', 'local')`, [du]);
      await clearClaimsRoles('u1', runner);
      expect(await claimRoles(c, 'u1')).toEqual([]);
      expect(await external(c, 'u1')).toEqual([]);
      expect((await c.query(`SELECT role_key FROM role_assignments`)).rows).toEqual([{ role_key: 'tt-logleser' }]);
      await close();
    }));
});

describe.skipIf(!hasPg)('external roles tables (real Postgres)', () => {
  it('the database itself refuses a stored value that is not in the catalogue', () =>
    withFreshSchema(async (c) => {
      await addUser(c, 'u1');
      await catalogue(c, [['role', 'admin']]);
      await c.query(`INSERT INTO user_external_roles (user_id, kind, identifier) VALUES ('u1', 'role', 'admin')`);
      await expect(c.query(`INSERT INTO user_external_roles (user_id, kind, identifier) VALUES ('u1', 'role', 'nope')`)).rejects.toMatchObject({ code: FK_VIOLATION });
      await expect(c.query(`INSERT INTO user_external_roles (user_id, kind, identifier) VALUES ('u1', 'group', 'admin')`)).rejects.toMatchObject({ code: FK_VIOLATION });
    }));

  it('removing a catalogue entry, or the user, removes what was stored', () =>
    withFreshSchema(async (c) => {
      await addUser(c, 'u1');
      await addUser(c, 'u2');
      await catalogue(c, [['role', 'a'], ['role', 'b']]);
      for (const u of ['u1', 'u2']) for (const r of ['a', 'b']) await c.query(`INSERT INTO user_external_roles (user_id, kind, identifier) VALUES ($1, 'role', $2)`, [u, r]);
      await c.query(`DELETE FROM external_roles WHERE identifier = 'a'`);
      expect((await c.query(`SELECT identifier FROM user_external_roles ORDER BY user_id`)).rows.map((r) => r.identifier)).toEqual(['b', 'b']);
      await c.query(`DELETE FROM users WHERE id = 'u1'`);
      expect((await c.query(`SELECT user_id FROM user_external_roles`)).rows).toEqual([{ user_id: 'u2' }]);
    }));

  it('constrains kind, source, and the length of identifier and name', () =>
    withFreshSchema(async (c) => {
      const insert = (kind: string, identifier: string, name: string, source = 'config') =>
        c.query(`INSERT INTO external_roles (kind, identifier, name, source) VALUES ($1, $2, $3, $4)`, [kind, identifier, name, source]);
      await expect(insert('team', 'x', 'x')).rejects.toMatchObject({ code: CHECK_VIOLATION });
      await expect(insert('role', 'x', 'x', 'ldap')).rejects.toMatchObject({ code: CHECK_VIOLATION });
      await expect(insert('role', '', 'x')).rejects.toMatchObject({ code: CHECK_VIOLATION });
      await expect(insert('role', 'x'.repeat(201), 'x')).rejects.toMatchObject({ code: CHECK_VIOLATION });
      await expect(insert('role', 'x', '')).rejects.toMatchObject({ code: CHECK_VIOLATION });
      await insert('role', 'x', 'x', 'rollekatalog');
      await insert('group', 'x', 'x', 'claims');
    }));

  it("accepts source 'claims' on directory_users, org_units and role_assignments", () =>
    withFreshSchema(async (c) => {
      const du = (await c.query(`INSERT INTO directory_users (name, source) VALUES ('x', 'claims') RETURNING uuid`)).rows[0].uuid;
      await c.query(`INSERT INTO org_units (name, source) VALUES ('x', 'claims')`);
      await c.query(`INSERT INTO role_assignments (directory_user_uuid, role_key, source) VALUES ($1, 'tt-bruger', 'claims')`, [du]);
      await expect(c.query(`INSERT INTO directory_users (name, source) VALUES ('x', 'ldap')`)).rejects.toMatchObject({ code: CHECK_VIOLATION });
    }));
});

describe.skipIf(!hasPg)('config catalogue sync (real Postgres)', () => {
  const entry = (kind: 'role' | 'group', identifier: string, name = identifier) => ({ kind, identifier, name });

  it('inserts, renames, and deactivates what left the file; leaves other sources alone', () =>
    withFreshSchema(async (c, schema) => {
      const { runner, close } = schemaRunner(c, schema);
      await c.query(`INSERT INTO external_roles (kind, identifier, name, source) VALUES ('role', 'from-rk', 'Fra Rollekatalog', 'rollekatalog')`);

      expect(await syncConfigCatalogue([entry('role', 'a', 'A'), entry('group', 'g', 'G'), entry('role', 'from-rk', 'Hijack')], runner)).toEqual({ upserted: 2, deactivated: 0 });
      const rows = () => c.query(`SELECT kind, identifier, name, source, active FROM external_roles ORDER BY kind, identifier`).then((r) => r.rows);
      expect(await rows()).toEqual([
        { kind: 'group', identifier: 'g', name: 'G', source: 'config', active: true },
        { kind: 'role', identifier: 'a', name: 'A', source: 'config', active: true },
        { kind: 'role', identifier: 'from-rk', name: 'Fra Rollekatalog', source: 'rollekatalog', active: true }, // not overwritten
      ]);

      expect(await syncConfigCatalogue([entry('role', 'a', 'A2')], runner)).toEqual({ upserted: 1, deactivated: 1 });
      expect((await rows()).map((r) => [r.identifier, r.name, r.active])).toEqual([
        ['g', 'G', false],
        ['a', 'A2', true],
        ['from-rk', 'Fra Rollekatalog', true],
      ]);

      // Back in the file: active again. An empty file deactivates every config entry, never the others.
      await syncConfigCatalogue([entry('group', 'g')], runner);
      expect((await rows()).find((r) => r.identifier === 'g')?.active).toBe(true);
      await syncConfigCatalogue([], runner);
      expect((await rows()).map((r) => [r.identifier, r.active])).toEqual([['g', false], ['a', false], ['from-rk', true]]);
      await close();
    }));

  it('a person who logs in after an entry was deactivated no longer gets it stored', () =>
    withFreshSchema(async (c, schema) => {
      const { runner, close } = schemaRunner(c, schema);
      await addUser(c, 'u1');
      await syncConfigCatalogue([entry('role', 'admin')], runner);
      await applyClaimsLogin(login('u1', { roles: ['admin'] }), runner);
      expect(await external(c, 'u1')).toEqual(['role:admin']);
      await syncConfigCatalogue([], runner);
      await applyClaimsLogin(login('u1', { roles: ['admin'] }), runner);
      expect(await external(c, 'u1')).toEqual([]);
      await close();
    }));
});

describe.skipIf(!hasPg)('SAML identity snapshot (real Postgres)', () => {
  it('stores the whitelisted attributes of an assertion, and cannot be taken over by a second user', () =>
    withFreshSchema(async (c, schema) => {
      const { runner, close } = schemaRunner(c, schema);
      await addUser(c, 'u1');
      await addUser(c, 'u2');
      const attrs = { id: 'ola01', email: 'ola@k.dk', name: 'Ola', upn: 'ola01@k.dk', preferred_username: ['ola01'], emailVerified: false, roles: ['admin'], groups: 'g' };
      const id = await captureIdentityFromAttributes('u1', 'saml', attrs, runner);
      expect(id).toMatchObject({ providerId: 'saml', subject: 'ola01' });
      const stored = (await c.query(`SELECT claims FROM external_identities`)).rows[0].claims;
      expect(stored).toEqual({ sub: 'ola01', email: 'ola@k.dk', name: 'Ola', upn: 'ola01@k.dk', preferred_username: 'ola01', email_verified: false });
      expect(JSON.stringify(stored)).not.toContain('admin'); // roles and groups never reach this table
      expect(await captureIdentityFromAttributes('u2', 'saml', attrs, runner)).toBeNull();
      expect(await captureIdentityFromAttributes('u1', 'credential', attrs, runner)).toBeNull();
      await close();
    }));
});
