// Needs a real Postgres 15+; skipped unless TEST_DATABASE_URL is set (see src/test/pg.ts).
// Proves the mode-switch relink against the real unique index and row locks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import { addUser, hasPg, schemaRunner, withFreshSchema } from '@/test/pg';

vi.mock('@/lib/db', () => ({ pool: {}, db: {} }));
// Linking is not audited (rights and organisation changes are out of the log), so these
// tests also assert that no audit row is written.

import { matchDirectoryUser } from './directory-match';

const identity = (userId: string, preferred_username = 'ABC123') => ({
  userId,
  providerId: 'oidc',
  subject: `s-${userId}`,
  claims: { sub: `s-${userId}`, preferred_username },
});

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
  vi.stubEnv('DIRECTORY_USERID_CLAIM', '');
  vi.stubEnv('DIRECTORY_USERID_TRANSFORM', '');
  vi.stubEnv('DIRECTORY_USERID_DOMAIN', '');
  vi.stubEnv('MICROSOFT_TENANT_ID', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const links = async (c: Client) =>
  (await c.query('SELECT source, app_user_id FROM directory_users ORDER BY source, name')).rows as Array<{
    source: string;
    app_user_id: string | null;
  }>;

describe.skipIf(!hasPg)('mode-switch relink (real Postgres)', () => {
  it('moves a link from a source=local row to the matching rollekatalog row', () =>
    withFreshSchema(async (c, schema) => {
      const { runner, close } = schemaRunner(c, schema);
      await addUser(c, 'u1');
      await c.query("INSERT INTO directory_users (name, source, app_user_id) VALUES ('Local', 'local', 'u1')");
      await c.query("INSERT INTO directory_users (name, ext_user_id, source) VALUES ('Rk', 'abc123', 'rollekatalog')");

      expect((await matchDirectoryUser(identity('u1'), 'userid-claim', runner)).status).toBe('linked');
      expect(await links(c)).toEqual([
        { source: 'local', app_user_id: null },
        { source: 'rollekatalog', app_user_id: 'u1' },
      ]);
      // Linking is not audited.
      expect((await c.query('SELECT 1 FROM audit_events')).rowCount).toBe(0);
      // Second login: stable.
      expect((await matchDirectoryUser(identity('u1'), 'userid-claim', runner)).status).toBe('already_linked');
      await close();
    }));

  it('matches a UPN claim with DIRECTORY_USERID_TRANSFORM=strip-upn-domain', () =>
    withFreshSchema(async (c, schema) => {
      vi.stubEnv('DIRECTORY_USERID_TRANSFORM', 'strip-upn-domain');
      vi.stubEnv('DIRECTORY_USERID_DOMAIN', 'kommune.dk');
      const { runner, close } = schemaRunner(c, schema);
      await addUser(c, 'u1');
      await c.query("INSERT INTO directory_users (name, ext_user_id, source) VALUES ('Rk', 'abc123', 'rollekatalog')");
      expect((await matchDirectoryUser(identity('u1', 'ABC123@evil.com'), 'userid-claim', runner)).status).toBe('no_match');
      expect((await matchDirectoryUser(identity('u1', 'ABC123@kommune.dk'), 'userid-claim', runner)).status).toBe('linked');
      await close();
    }));

  it('has expression indexes for the lower(ext_user_id) / lower(email) lookups', () =>
    withFreshSchema(async (c) => {
      const r = await c.query(`SELECT indexdef FROM pg_indexes WHERE tablename = 'directory_users' AND schemaname = current_schema()`);
      const defs = r.rows.map((x: { indexdef: string }) => x.indexdef).join('\n');
      expect(defs).toContain('lower(ext_user_id)');
      expect(defs).toContain('lower(email)');
    }));

  it('never steals a rollekatalog row linked to a different app user', () =>
    withFreshSchema(async (c, schema) => {
      const { runner, close } = schemaRunner(c, schema);
      await addUser(c, 'u1');
      await addUser(c, 'u2');
      await c.query("INSERT INTO directory_users (name, source, app_user_id) VALUES ('Local', 'local', 'u1')");
      await c.query("INSERT INTO directory_users (name, ext_user_id, source, app_user_id) VALUES ('Rk', 'abc123', 'rollekatalog', 'u2')");

      expect((await matchDirectoryUser(identity('u1'), 'userid-claim', runner)).status).toBe('conflict');
      // u1 keeps the local link: nothing was released.
      expect(await links(c)).toEqual([
        { source: 'local', app_user_id: 'u1' },
        { source: 'rollekatalog', app_user_id: 'u2' },
      ]);
      await close();
    }));

  it('does not move a link that points at another ROLLEKATALOG row', () =>
    withFreshSchema(async (c, schema) => {
      const { runner, close } = schemaRunner(c, schema);
      await addUser(c, 'u1');
      await c.query("INSERT INTO directory_users (name, ext_user_id, source, app_user_id) VALUES ('Old', 'old.id', 'rollekatalog', 'u1')");
      await c.query("INSERT INTO directory_users (name, ext_user_id, source) VALUES ('New', 'abc123', 'rollekatalog')");
      expect((await matchDirectoryUser(identity('u1'), 'userid-claim', runner)).status).toBe('conflict');
      expect((await c.query("SELECT name FROM directory_users WHERE app_user_id = 'u1'")).rows).toEqual([{ name: 'Old' }]);
      await close();
    }));

  it('person deleted and re-created in Rollekatalog (same userId, new uuid): releases the disabled old row and links the new one', () =>
    withFreshSchema(async (c, schema) => {
      const { runner, close } = schemaRunner(c, schema);
      await addUser(c, 'u1');
      await c.query("INSERT INTO directory_users (name, ext_user_id, source, disabled, app_user_id) VALUES ('Old', 'abc123', 'rollekatalog', true, 'u1')");
      await c.query("INSERT INTO directory_users (name, ext_user_id, source) VALUES ('New', 'abc123', 'rollekatalog')");

      expect((await matchDirectoryUser(identity('u1'), 'userid-claim', runner)).status).toBe('linked');
      expect((await c.query('SELECT name, app_user_id FROM directory_users ORDER BY name')).rows).toEqual([
        { name: 'New', app_user_id: 'u1' },
        { name: 'Old', app_user_id: null },
      ]);
      expect((await c.query('SELECT 1 FROM audit_events')).rowCount).toBe(0);
      expect((await matchDirectoryUser(identity('u1'), 'userid-claim', runner)).status).toBe('already_linked');
      await close();
    }));

  it('keeps an ENABLED old rollekatalog link: conflict, nothing released', () =>
    withFreshSchema(async (c, schema) => {
      const { runner, close } = schemaRunner(c, schema);
      await addUser(c, 'u1');
      await c.query("INSERT INTO directory_users (name, ext_user_id, source, app_user_id) VALUES ('Old', 'old.id', 'rollekatalog', 'u1')");
      await c.query("INSERT INTO directory_users (name, ext_user_id, source) VALUES ('New', 'abc123', 'rollekatalog')");

      expect((await matchDirectoryUser(identity('u1'), 'userid-claim', runner)).status).toBe('conflict');
      expect((await c.query("SELECT name FROM directory_users WHERE app_user_id = 'u1'")).rows).toEqual([{ name: 'Old' }]);
      await close();
    }));

  it('does not steal a link that belongs to a DIFFERENT app user, even when the own old row is disabled', () =>
    withFreshSchema(async (c, schema) => {
      const { runner, close } = schemaRunner(c, schema);
      await addUser(c, 'u1');
      await addUser(c, 'u2');
      await c.query("INSERT INTO directory_users (name, ext_user_id, source, disabled, app_user_id) VALUES ('Old', 'gone', 'rollekatalog', true, 'u1')");
      await c.query("INSERT INTO directory_users (name, ext_user_id, source, app_user_id) VALUES ('New', 'abc123', 'rollekatalog', 'u2')");

      expect((await matchDirectoryUser(identity('u1'), 'userid-claim', runner)).status).toBe('conflict');
      expect((await c.query('SELECT name, app_user_id FROM directory_users ORDER BY name')).rows).toEqual([
        { name: 'New', app_user_id: 'u2' },
        { name: 'Old', app_user_id: 'u1' },
      ]);
      await close();
    }));

  it('leaves the local row (and its assignments) intact apart from the released link', () =>
    withFreshSchema(async (c, schema) => {
      const { runner, close } = schemaRunner(c, schema);
      await addUser(c, 'u1');
      const local = (
        await c.query("INSERT INTO directory_users (name, source, app_user_id) VALUES ('Local', 'local', 'u1') RETURNING uuid")
      ).rows[0].uuid;
      await c.query("INSERT INTO role_assignments (directory_user_uuid, role_key, source) VALUES ($1, 'tt-logleser', 'local')", [local]);
      await c.query("INSERT INTO directory_users (name, ext_user_id, source) VALUES ('Rk', 'abc123', 'rollekatalog')");
      await matchDirectoryUser(identity('u1'), 'userid-claim', runner);
      expect((await c.query('SELECT 1 FROM role_assignments WHERE directory_user_uuid = $1', [local])).rowCount).toBe(1);
      await close();
    }));

  it('a disabled row that still holds a reused userId does not make the new person ambiguous', () =>
    withFreshSchema(async (c, schema) => {
      const { runner, close } = schemaRunner(c, schema);
      await addUser(c, 'u1');
      await c.query("INSERT INTO directory_users (name, ext_user_id, source, disabled) VALUES ('Old', 'abc123', 'rollekatalog', true)");
      await c.query("INSERT INTO directory_users (name, ext_user_id, source) VALUES ('New', 'abc123', 'rollekatalog')");
      expect((await matchDirectoryUser(identity('u1'), 'userid-claim', runner)).status).toBe('linked');
      expect((await c.query("SELECT name FROM directory_users WHERE app_user_id = 'u1'")).rows).toEqual([{ name: 'New' }]);
      await close();
    }));

  it('two concurrent logins of the same user link exactly once and keep the unique index intact', () =>
    withFreshSchema(async (c, schema) => {
      const { runner, close } = schemaRunner(c, schema);
      await addUser(c, 'u1');
      await c.query("INSERT INTO directory_users (name, source, app_user_id) VALUES ('Local', 'local', 'u1')");
      await c.query("INSERT INTO directory_users (name, ext_user_id, source) VALUES ('Rk', 'abc123', 'rollekatalog')");
      const results = await Promise.all([
        matchDirectoryUser(identity('u1'), 'userid-claim', runner),
        matchDirectoryUser(identity('u1'), 'userid-claim', runner),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(['already_linked', 'linked']);
      expect(await links(c)).toEqual([
        { source: 'local', app_user_id: null },
        { source: 'rollekatalog', app_user_id: 'u1' },
      ]);
      expect((await c.query('SELECT 1 FROM audit_events')).rowCount).toBe(0);
      await close();
    }));

  it('two different users racing for one rollekatalog row: one wins, the other gets a conflict and keeps its local link', () =>
    withFreshSchema(async (c, schema) => {
      const { runner, close } = schemaRunner(c, schema);
      await addUser(c, 'u1');
      await addUser(c, 'u2');
      await c.query("INSERT INTO directory_users (name, source, app_user_id) VALUES ('L1', 'local', 'u1'), ('L2', 'local', 'u2')");
      await c.query("INSERT INTO directory_users (name, ext_user_id, source) VALUES ('Rk', 'abc123', 'rollekatalog')");
      const results = await Promise.all([
        matchDirectoryUser(identity('u1'), 'userid-claim', runner),
        matchDirectoryUser(identity('u2'), 'userid-claim', runner),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(['conflict', 'linked']);
      const rk = (await c.query("SELECT app_user_id FROM directory_users WHERE source = 'rollekatalog'")).rows[0].app_user_id;
      const loser = rk === 'u1' ? 'u2' : 'u1';
      expect((await c.query("SELECT 1 FROM directory_users WHERE source = 'local' AND app_user_id = $1", [loser])).rowCount).toBe(1);
      await close();
    }));

  describe('Microsoft tenant pinning (end to end)', () => {
    const TID = '99999999-8888-4777-8666-555555555555';
    const ms = (userId: string, tid?: string) => ({
      ...identity(userId),
      providerId: 'microsoft',
      claims: { sub: `s-${userId}`, preferred_username: 'ABC123', ...(tid ? { tid } : {}) },
    });

    it('refuses an unpinned tenant (common) and a foreign tid: no row is linked, nothing audited', () =>
      withFreshSchema(async (c, schema) => {
        const { runner, close } = schemaRunner(c, schema);
        await addUser(c, 'u1');
        await c.query("INSERT INTO directory_users (name, ext_user_id, source) VALUES ('Rk', 'abc123', 'rollekatalog')");

        vi.stubEnv('MICROSOFT_TENANT_ID', 'common');
        expect((await matchDirectoryUser(ms('u1', TID), 'userid-claim', runner)).status).toBe('refused');
        vi.stubEnv('MICROSOFT_TENANT_ID', TID);
        expect((await matchDirectoryUser(ms('u1', '00000000-0000-4000-8000-000000000000'), 'userid-claim', runner)).status).toBe('refused');
        expect((await matchDirectoryUser(ms('u1'), 'userid-claim', runner)).status).toBe('refused');

        expect(await links(c)).toEqual([{ source: 'rollekatalog', app_user_id: null }]);
        expect((await c.query('SELECT 1 FROM audit_events')).rowCount).toBe(0);
        await close();
      }));

    it('links with the pinned tenant and a matching tid', () =>
      withFreshSchema(async (c, schema) => {
        const { runner, close } = schemaRunner(c, schema);
        await addUser(c, 'u1');
        await c.query("INSERT INTO directory_users (name, ext_user_id, source) VALUES ('Rk', 'abc123', 'rollekatalog')");
        vi.stubEnv('MICROSOFT_TENANT_ID', TID);
        expect((await matchDirectoryUser(ms('u1', TID.toUpperCase()), 'userid-claim', runner)).status).toBe('linked');
        expect(await links(c)).toEqual([{ source: 'rollekatalog', app_user_id: 'u1' }]);
        expect((await c.query('SELECT 1 FROM audit_events')).rowCount).toBe(0);
        await close();
      }));
  });
});
