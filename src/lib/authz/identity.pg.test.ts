// Needs a real Postgres 15+; skipped unless TEST_DATABASE_URL is set (see src/test/pg.ts).
// The code under test writes public.<table>; here that qualifier is redirected to the
// throwaway schema so nothing touches real data.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { hasPg, withFreshSchema } from '@/test/pg';
import { createRunner, type ClientLike, type SqlResult, type SqlRunner } from './pg-runner';

vi.mock('@/lib/db', () => ({ pool: {} }));

import { maybeBootstrapAdmin } from './bootstrap';
import { matchDirectoryUser } from './directory-match';
import { captureExternalIdentity } from './identity';

function jwt(payload: unknown): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc(payload)}.sig`;
}

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

async function addUser(c: Client, id: string, email: string) {
  await c.query('INSERT INTO users (id, name, email) VALUES ($1, $1, $2)', [id, email]);
}
async function addSsoAccount(c: Client, userId: string, providerId: string, claims: object) {
  await c.query(
    'INSERT INTO accounts (id, account_id, provider_id, user_id, id_token) VALUES ($1, $2, $3, $4, $5)',
    [`acc-${userId}-${providerId}`, (claims as { sub: string }).sub, providerId, userId, jwt(claims)],
  );
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubEnv('ACCESS_SOURCE', 'local');
  vi.stubEnv('BOOTSTRAP_ADMIN_EMAILS', 'a@example.dk,b@example.dk');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe.skipIf(!hasPg)('identity link and bootstrap (real Postgres)', () => {
  it('captures a whitelisted snapshot and updates it on the next login', () =>
    withFreshSchema(async (c, schema) => {
      const { runner, close } = schemaRunner(c, schema);
      await addUser(c, 'u1', 'a@example.dk');
      await addSsoAccount(c, 'u1', 'oidc', { sub: 's1', email: 'a@example.dk', email_verified: true, groups: ['g'] });

      await captureExternalIdentity('u1', runner);
      await captureExternalIdentity('u1', runner);
      const rows = (await c.query('SELECT claims, user_id FROM external_identities')).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0].claims).toEqual({ sub: 's1', email: 'a@example.dk', email_verified: true });
      await close();
    }));

  it('does not let a second app user take over an existing (provider, subject)', () =>
    withFreshSchema(async (c, schema) => {
      const { runner, close } = schemaRunner(c, schema);
      await addUser(c, 'u1', 'a@example.dk');
      await addUser(c, 'u2', 'b@example.dk');
      await addSsoAccount(c, 'u1', 'oidc', { sub: 'same' });
      await addSsoAccount(c, 'u2', 'oidc', { sub: 'same' });
      await captureExternalIdentity('u1', runner);
      expect(await captureExternalIdentity('u2', runner)).toEqual([]);
      expect((await c.query('SELECT user_id FROM external_identities')).rows).toEqual([{ user_id: 'u1' }]);
      await close();
    }));

  it('two concurrent first logins by allow-listed users create exactly one administrator', () =>
    withFreshSchema(async (c, schema) => {
      const { runner, close } = schemaRunner(c, schema);
      for (const [id, email] of [['u1', 'a@example.dk'], ['u2', 'b@example.dk']]) {
        await addUser(c, id, email);
        await addSsoAccount(c, id, 'oidc', { sub: `s-${id}`, email, email_verified: true });
        await captureExternalIdentity(id, runner);
      }
      const results = await Promise.all([maybeBootstrapAdmin('u1', runner), maybeBootstrapAdmin('u2', runner)]);
      expect(results.filter((r) => r.granted)).toHaveLength(1);
      const admins = await c.query("SELECT 1 FROM role_assignments WHERE role_key = 'tt-administrator'");
      expect(admins.rowCount).toBe(1);
      await close();
    }));

  it('grants nothing to a credential-only user, even with an allow-listed email', () =>
    withFreshSchema(async (c, schema) => {
      const { runner, close } = schemaRunner(c, schema);
      await addUser(c, 'u1', 'a@example.dk');
      await c.query("INSERT INTO accounts (id, account_id, provider_id, user_id, password) VALUES ('c1','u1','credential','u1','hash')");
      await captureExternalIdentity('u1', runner);
      expect((await maybeBootstrapAdmin('u1', runner)).granted).toBe(false);
      expect((await c.query('SELECT 1 FROM role_assignments')).rowCount).toBe(0);
      await close();
    }));

  describe('directory link (rollekatalog mode)', () => {
    const identity = (userId: string, claims = { sub: 's', preferred_username: 'ABC123' }) => ({
      userId,
      providerId: 'oidc',
      subject: claims.sub,
      claims,
    });

    it('links once, is idempotent, and never relinks to another app user', () =>
      withFreshSchema(async (c, schema) => {
        vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
        const { runner, close } = schemaRunner(c, schema);
        await addUser(c, 'u1', 'a@example.dk');
        await addUser(c, 'u2', 'b@example.dk');
        await c.query("INSERT INTO directory_users (name, ext_user_id, source) VALUES ('X', 'abc123', 'rollekatalog')");

        expect((await matchDirectoryUser(identity('u1'), 'userid-claim', runner)).status).toBe('linked');
        expect((await matchDirectoryUser(identity('u1'), 'userid-claim', runner)).status).toBe('already_linked');
        expect((await matchDirectoryUser(identity('u2'), 'userid-claim', runner)).status).toBe('conflict');
        expect((await c.query('SELECT app_user_id FROM directory_users')).rows).toEqual([{ app_user_id: 'u1' }]);
        await close();
      }));

    it('moves a leftover source=local link to the rollekatalog row (mode switch)', () =>
      withFreshSchema(async (c, schema) => {
        vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
        const { runner, close } = schemaRunner(c, schema);
        await addUser(c, 'u1', 'a@example.dk');
        await c.query("INSERT INTO directory_users (name, source, app_user_id) VALUES ('Own', 'local', 'u1')");
        await c.query("INSERT INTO directory_users (name, ext_user_id, source) VALUES ('X', 'abc123', 'rollekatalog')");
        expect((await matchDirectoryUser(identity('u1'), 'userid-claim', runner)).status).toBe('linked');
        expect((await c.query('SELECT source, app_user_id FROM directory_users ORDER BY source')).rows).toEqual([
          { source: 'local', app_user_id: null },
          { source: 'rollekatalog', app_user_id: 'u1' },
        ]);
        await close();
      }));

    it('refuses to link a user who already holds a link to another ROLLEKATALOG row (unique app_user_id)', () =>
      withFreshSchema(async (c, schema) => {
        vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
        const { runner, close } = schemaRunner(c, schema);
        await addUser(c, 'u1', 'a@example.dk');
        await c.query("INSERT INTO directory_users (name, ext_user_id, source, app_user_id) VALUES ('Own', 'other', 'rollekatalog', 'u1')");
        await c.query("INSERT INTO directory_users (name, ext_user_id, source) VALUES ('X', 'abc123', 'rollekatalog')");
        expect((await matchDirectoryUser(identity('u1'), 'userid-claim', runner)).status).toBe('conflict');
        expect((await c.query("SELECT name FROM directory_users WHERE app_user_id = 'u1'")).rows).toEqual([{ name: 'Own' }]);
        await close();
      }));

    it('treats duplicate candidates as ambiguous', () =>
      withFreshSchema(async (c, schema) => {
        vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
        const { runner, close } = schemaRunner(c, schema);
        await addUser(c, 'u1', 'a@example.dk');
        await c.query("INSERT INTO directory_users (name, ext_user_id, source) VALUES ('X', 'abc123', 'rollekatalog'), ('Y', 'ABC123', 'rollekatalog')");
        expect((await matchDirectoryUser(identity('u1'), 'userid-claim', runner)).status).toBe('ambiguous');
        expect((await c.query('SELECT 1 FROM directory_users WHERE app_user_id IS NOT NULL')).rowCount).toBe(0);
        await close();
      }));
  });
});
