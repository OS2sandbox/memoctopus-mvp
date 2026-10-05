// Needs a real Postgres 15+; skipped unless TEST_DATABASE_URL is set (see src/test/pg.ts).
// Proves the three statements of the login refresh against the real schema.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { hasPg, withFreshSchema } from '@/test/pg';
import { createRunner, type ClientLike, type SqlResult, type SqlRunner } from '@/lib/authz/pg-runner';

vi.mock('@/lib/db', () => ({ pool: {} }));

import { startMockRollekatalog, type MockRollekatalog } from './mock-server';
import { refreshUserFromRollekatalog } from './login-refresh';

function schemaRunner(base: Client, schema: string): SqlRunner {
  const rewrite = (sql: string) => sql.replaceAll('public.', `"${schema}".`);
  const wrap = (c: Client) => ({
    query: (sql: string, params?: readonly unknown[]) =>
      c.query(rewrite(sql), params as unknown[] | undefined) as unknown as Promise<SqlResult<never>>,
  });
  return createRunner(wrap(base), async (): Promise<ClientLike> => ({ ...wrap(base), release: () => {} }));
}

let mock: MockRollekatalog;
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
  vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
  vi.stubEnv('ROLLEKATALOG_URL', mock.url);
  vi.stubEnv('ROLLEKATALOG_READ_API_KEY', mock.readKey);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function seed(c: Client, over: { source?: string; extUserId?: string; extUuid?: string } = {}) {
  await c.query("INSERT INTO users (id, name, email) VALUES ('u1', 'u1', 'u1@example.dk'), ('u2', 'u2', 'u2@example.dk')");
  const mk = async (name: string, appUser: string | null, extUserId: string | null, extUuid: string | null, source: string) =>
    (
      await c.query(
        'INSERT INTO directory_users (name, ext_user_id, ext_uuid, source, app_user_id) VALUES ($1, $2, $3, $4, $5) RETURNING uuid',
        [name, extUserId, extUuid, source, appUser],
      )
    ).rows[0].uuid as string;
  const mine = await mk('Anne', 'u1', over.extUserId ?? 'anne.p', over.extUuid ?? '9d3c0000-0000-4000-8000-000000000003', over.source ?? 'rollekatalog');
  const other = await mk('Other', 'u2', 'jens.t', '9d3c0000-0000-4000-8000-000000000002', 'rollekatalog');
  const grant = (uuid: string, role: string, source: string) =>
    c.query('INSERT INTO role_assignments (directory_user_uuid, role_key, source, synced_at) VALUES ($1, $2, $3, now())', [uuid, role, source]);
  await grant(mine, 'tt-bruger', 'rollekatalog');
  await grant(mine, 'tt-skabelonansvarlig', 'rollekatalog');
  await grant(mine, 'tt-logleser', 'local');
  await grant(other, 'tt-skabelonansvarlig', 'rollekatalog');
  return { mine, other };
}

const roles = async (c: Client, uuid: string) =>
  (await c.query('SELECT role_key, source FROM role_assignments WHERE directory_user_uuid = $1 ORDER BY role_key, source', [uuid])).rows;

describe.skipIf(!hasPg)('login refresh (real Postgres)', () => {
  it('revokes only the absent rollekatalog role of THIS user; local rows and other users are untouched', () =>
    withFreshSchema(async (c, schema) => {
      mock.setData({ rolesAsList: { 'anne.p': { systemRoles: ['tt-bruger'], disabled: false } } });
      const { mine, other } = await seed(c);
      const res = await refreshUserFromRollekatalog('u1', { runner: schemaRunner(c, schema) });
      expect(res).toEqual({ status: 'refreshed', markedDisabled: false, revokedRoles: 1 });
      expect(await roles(c, mine)).toEqual([
        { role_key: 'tt-bruger', source: 'rollekatalog' },
        { role_key: 'tt-logleser', source: 'local' },
      ]);
      expect(await roles(c, other)).toEqual([{ role_key: 'tt-skabelonansvarlig', source: 'rollekatalog' }]);
    }));

  it('never inserts: a role only Rollekatalog lists stays absent', () =>
    withFreshSchema(async (c, schema) => {
      mock.setData({
        rolesAsList: { 'anne.p': { systemRoles: ['tt-bruger', 'tt-skabelonansvarlig', 'tt-administrator'], disabled: false } },
      });
      const { mine } = await seed(c);
      await refreshUserFromRollekatalog('u1', { runner: schemaRunner(c, schema) });
      expect((await roles(c, mine)).map((r) => r.role_key)).toEqual(['tt-bruger', 'tt-logleser', 'tt-skabelonansvarlig']);
    }));

  it('a disabled answer marks the row disabled and writes nothing else', () =>
    withFreshSchema(async (c, schema) => {
      mock.setData({ rolesAsList: { 'anne.p': { systemRoles: ['tt-bruger'], disabled: true } } });
      const { mine, other } = await seed(c);
      const res = await refreshUserFromRollekatalog('u1', { runner: schemaRunner(c, schema) });
      expect(res).toEqual({ status: 'refreshed', markedDisabled: true, revokedRoles: 0 });
      expect((await c.query('SELECT uuid, disabled FROM directory_users ORDER BY name')).rows).toEqual(
        expect.arrayContaining([
          { uuid: mine, disabled: true },
          { uuid: other, disabled: false },
        ]),
      );
    }));

  it('a vanished user (404) is marked disabled', () =>
    withFreshSchema(async (c, schema) => {
      const { mine } = await seed(c, { extUserId: 'gone.u', extUuid: '9d3c0000-0000-4000-8000-0000000000ee' });
      expect((await refreshUserFromRollekatalog('u1', { runner: schemaRunner(c, schema) })).status).toBe('refreshed');
      expect((await c.query('SELECT disabled FROM directory_users WHERE uuid = $1', [mine])).rows[0].disabled).toBe(true);
    }));

  it('does nothing for a user linked to a source=local row', () =>
    withFreshSchema(async (c, schema) => {
      const { mine } = await seed(c, { source: 'local' });
      expect(await refreshUserFromRollekatalog('u1', { runner: schemaRunner(c, schema) })).toEqual({ status: 'skipped', reason: 'not_linked' });
      expect(await roles(c, mine)).toHaveLength(3);
    }));

  it('an outage (500) changes nothing', () =>
    withFreshSchema(async (c, schema) => {
      mock.setFaults([{ match: '/api/user/', status: 500 }]);
      const { mine } = await seed(c);
      expect((await refreshUserFromRollekatalog('u1', { runner: schemaRunner(c, schema) })).status).toBe('error');
      expect(await roles(c, mine)).toHaveLength(3);
      expect((await c.query('SELECT disabled FROM directory_users WHERE uuid = $1', [mine])).rows[0].disabled).toBe(false);
    }));
});
