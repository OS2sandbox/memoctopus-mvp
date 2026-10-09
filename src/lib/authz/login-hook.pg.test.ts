// Needs a real Postgres 15+; skipped unless TEST_DATABASE_URL is set (see src/test/pg.ts).
// The login hook removes the provider tokens from public.accounts once it has read them.
import { describe, expect, it, vi } from 'vitest';
import { addUser, hasPg, schemaRunner, withFreshSchema } from '@/test/pg';

vi.mock('@/lib/db', () => ({ pool: {} }));

import { scrubAccountTokens } from './login-hook';

const account = (id: string, userId: string, provider: string): [string, unknown[]] =>
  [
    `INSERT INTO accounts (id, account_id, provider_id, user_id, access_token, refresh_token, id_token,
       access_token_expires_at, refresh_token_expires_at, scope, password)
     VALUES ($1, $1, $3, $2, 'at', 'rt', 'idt', now(), now(), 'openid email', $4)`,
    [id, userId, provider, provider === 'credential' ? 'hashed-password' : null],
  ];

describe.skipIf(!hasPg)('scrubAccountTokens (real Postgres)', () => {
  it('nulls the tokens and their expiries of the user\'s SSO accounts, and nothing else', () =>
    withFreshSchema(async (c, schema) => {
      const { runner, close } = schemaRunner(c, schema);
      await addUser(c, 'u1');
      await addUser(c, 'u2');
      for (const [id, user, provider] of [['a1', 'u1', 'oidc'], ['a2', 'u1', 'microsoft'], ['a3', 'u1', 'credential'], ['a4', 'u2', 'oidc']] as const) {
        await c.query(...account(id, user, provider));
      }
      await scrubAccountTokens('u1', runner);
      const rows = (await c.query('SELECT id, access_token, refresh_token, id_token, access_token_expires_at, refresh_token_expires_at, scope, password FROM accounts ORDER BY id')).rows;
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      for (const id of ['a1', 'a2']) {
        expect(byId[id]).toMatchObject({ access_token: null, refresh_token: null, id_token: null, access_token_expires_at: null, refresh_token_expires_at: null, scope: 'openid email' });
      }
      expect(byId.a3).toMatchObject({ password: 'hashed-password', access_token: 'at' }); // the password account is not an IdP account
      expect(byId.a4).toMatchObject({ id_token: 'idt' }); // another person's account
      await close();
    }));

  it('swallows a database error (never blocks a login)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = { query: async () => { throw new Error('boom'); }, transaction: async () => { throw new Error('boom'); } };
    await expect(scrubAccountTokens('u1', broken as never)).resolves.toBeUndefined();
  });
});
