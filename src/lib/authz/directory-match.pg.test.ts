// Needs a real Postgres 15+; skipped unless TEST_DATABASE_URL is set (see src/test/pg.ts).
// Proves the mode-switch relink against the real unique index and row locks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { hasPg, withFreshSchema } from '@/test/pg';
import { createRunner, type ClientLike, type SqlResult, type SqlRunner } from './pg-runner';

vi.mock('@/lib/db', () => ({ pool: {}, db: {} }));
// src/test/setup.ts replaces the audit seam with a no-op. The relink's "audit and link
// commit or roll back together" guarantee is only provable with the real writer, which
// inserts on the transaction into the throwaway schema (the actor snapshot is best effort).
vi.unmock('@/lib/audit/seam');

import { matchDirectoryUser } from './directory-match';

/** SqlRunner over the throwaway schema; each transaction gets its own connection so locks really contend. */
function schemaRunner(base: Client, schema: string): { runner: SqlRunner; close: () => Promise<void> } {
  const rewrite = (sql: string) => sql.replaceAll('public.', `"${schema}".`);
  const wrap = (c: Client) => ({
    query: (sql: string, params?: readonly unknown[]) =>
      c.query(rewrite(sql), params as unknown[] | undefined) as unknown as Promise<SqlResult<never>>,
  });
  const extra: Client[] = [];
  const runner = createRunner(wrap(base), async (): Promise<ClientLike> => {
    const c = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await c.connect();
    await c.query(`SET search_path TO "${schema}"`);
    extra.push(c);
    return { ...wrap(c), release: () => void c.end() };
  });
  return { runner, close: async () => void (await Promise.allSettled(extra.map((c) => c.end().catch(() => {})))) };
}

const addUser = (c: Client, id: string) =>
  c.query('INSERT INTO users (id, name, email) VALUES ($1, $1, $2)', [id, `${id}@example.dk`]);

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
  it('moves a link from a source=local row to the matching rollekatalog row and audits it', () =>
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
      const audit = await c.query("SELECT entity_id, details FROM audit_events WHERE event_type = 'access.user_link'");
      expect(audit.rowCount).toBe(1);
      expect(audit.rows[0].details).toEqual({ via: 'userid-claim', automatic: true });
      // Second login: stable.
      expect((await matchDirectoryUser(identity('u1'), 'userid-claim', runner)).status).toBe('already_linked');
      await close();
    }));

  it('matches a UPN claim with DIRECTORY_USERID_TRANSFORM=strip-upn-domain', () =>
    withFreshSchema(async (c, schema) => {
      vi.stubEnv('DIRECTORY_USERID_TRANSFORM', 'strip-upn-domain');
      const { runner, close } = schemaRunner(c, schema);
      await addUser(c, 'u1');
      await c.query("INSERT INTO directory_users (name, ext_user_id, source) VALUES ('Rk', 'abc123', 'rollekatalog')");
      expect((await matchDirectoryUser(identity('u1', 'ABC123@kommune.dk'), 'userid-claim', runner)).status).toBe('linked');
      await close();
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

  it('a failure after the release (here: the audit insert) rolls the whole relink back and restores the local link', () =>
    withFreshSchema(async (c, schema) => {
      const { runner, close } = schemaRunner(c, schema);
      await addUser(c, 'u1');
      await c.query("INSERT INTO directory_users (name, source, app_user_id) VALUES ('Local', 'local', 'u1')");
      await c.query("INSERT INTO directory_users (name, ext_user_id, source) VALUES ('Rk', 'abc123', 'rollekatalog')");
      // A failing audit insert aborts the transaction after the release and the link.
      await c.query('ALTER TABLE audit_events ADD CONSTRAINT never_ok CHECK (false) NOT VALID');
      await expect(matchDirectoryUser(identity('u1'), 'userid-claim', runner)).rejects.toThrow();
      expect(await links(c)).toEqual([
        { source: 'local', app_user_id: 'u1' },
        { source: 'rollekatalog', app_user_id: null },
      ]);
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
      expect((await c.query("SELECT 1 FROM audit_events WHERE event_type = 'access.user_link'")).rowCount).toBe(1);
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
});
