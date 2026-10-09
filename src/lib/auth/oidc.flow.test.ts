// A real OIDC login through the real better-auth genericOAuth plugin (and the built-in Microsoft
// provider), against a local mock IdP (discovery, token and userinfo endpoints) and an in-memory
// database: sign-in redirect, the callback, the session, and what the login hook receives.
// Proves the pieces that unit tests can only mock: that the profile loader really is what the
// plugin calls, that the claims reach the hook through the hand-over, that a second login hands
// over the NEW roles, and that a foreign issuer / audience / tenant creates no user and no session.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { genericOAuth } from 'better-auth/plugins';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPrincipalFromAssignments } from '@/lib/authz/capabilities';
import { decideFromClaims } from '@/lib/authz/claims-roles';
import { clearLoginClaimsStash, takeLoginClaims } from '@/lib/authz/claims-stash';
import { requireRoleToLogin } from '@/lib/authz/config';
import { entraSocialConfig, genericOAuthConfigFor } from './oidc-config';
import type { RolesConfig } from './config-file';
import type { OidcProviderConfig } from './providers';

vi.mock('@/lib/db', () => ({ pool: {} }));

const TENANT = '11111111-2222-3333-4444-555555555555';
const role = (m: Record<string, string>) => new Map(Object.entries(m).map(([k, r]) => [k, { role: r as never, global: true }]));
const ROLES: RolesConfig = {
  state: 'ok',
  appRoleMap: role({ 'referat-admin': 'admin', 'referat-bruger': 'bruger' }),
  groupRoleMap: role({}),
};
const SPECS = { claims: {}, rolesClaim: { name: 'roles', format: 'array' as const, separator: ',' } };

interface Issued {
  /** Claims of the id token the token endpoint will issue for this code. */
  idToken: Record<string, unknown>;
  /** What the userinfo endpoint answers for the access token of this code. */
  userinfo?: Record<string, unknown>;
}

describe('OIDC login through the real plugins', () => {
  let idp: http.Server;
  let base: string;
  const issued = new Map<string, Issued>();
  const userinfoCalls: string[] = [];
  let db: Record<string, Array<Record<string, any>>>;
  let auth: ReturnType<typeof makeAuth>;
  /** What the session.create.after hook saw: the account, the handed-over claims and the roles they decide. */
  let logins: Array<{ providerId: string; claims: Record<string, unknown> | null; roles: string[] }>;

  const jwt = (payload: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;
  const tokenClaims = (over: Record<string, unknown> = {}) => ({
    iss: base,
    aud: 'cid',
    sub: 'person-1',
    email: 'ola@kommune.dk',
    name: 'Ola Olsen',
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...over,
  });

  beforeAll(async () => {
    idp = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const json = (body: unknown, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === '/.well-known/openid-configuration') {
        return json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          userinfo_endpoint: `${base}/userinfo`,
        });
      }
      if (req.method === 'POST' && (url.pathname === '/token' || url.pathname.endsWith('/oauth2/v2.0/token'))) {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const code = new URLSearchParams(body).get('code') ?? '';
          const grant = issued.get(code);
          if (!grant) return json({ error: 'invalid_grant' }, 400);
          json({ access_token: `at-${code}`, refresh_token: `rt-${code}`, token_type: 'Bearer', expires_in: 3600, id_token: jwt(grant.idToken) });
        });
        return;
      }
      if (url.pathname === '/userinfo') {
        const code = (req.headers.authorization ?? '').replace('Bearer at-', '');
        userinfoCalls.push(code);
        const grant = issued.get(code);
        return grant?.userinfo ? json(grant.userinfo) : json({ error: 'invalid_token' }, 401);
      }
      json({ error: 'not_found' }, 404);
    });
    await new Promise<void>((resolve) => idp.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => idp.close(() => resolve())));

  function provider(over: Partial<OidcProviderConfig> = {}): OidcProviderConfig {
    return {
      providerId: 'fka',
      providerName: 'FKA',
      clientId: 'cid',
      clientSecret: 'secret',
      discoveryUrl: `${base}/.well-known/openid-configuration`,
      scopes: ['openid', 'profile', 'email'],
      pkce: true,
      claims: {},
      rolesClaim: SPECS.rolesClaim,
      ...over,
    };
  }

  function makeAuth(opts: { oidc?: OidcProviderConfig; entra?: boolean } = {}) {
    const entra = opts.entra ? { ...entraSocialConfig({ clientId: 'cid', clientSecret: 'secret', tenantId: TENANT }), authority: base } : null;
    return betterAuth({
      baseURL: 'http://localhost:3004',
      secret: 'x'.repeat(40),
      database: memoryAdapter(db),
      advanced: { disableOriginCheck: false },
      databaseHooks: {
        session: {
          create: {
            after: async (session) => {
              const account = db.account.find((a) => a.userId === session.userId);
              const claims = account ? takeLoginClaims(account.providerId, account.accountId) : null;
              logins.push({
                providerId: account?.providerId,
                claims,
                roles: decideFromClaims(claims, account?.providerId, ROLES, SPECS, []).roles,
              });
            },
          },
        },
      },
      ...(entra ? { socialProviders: { microsoft: entra as never } } : {}),
      plugins: opts.oidc ? [genericOAuth({ config: [genericOAuthConfigFor(opts.oidc)] })] : [],
    });
  }

  beforeEach(() => {
    vi.stubEnv('ACCESS_SOURCE', 'claims');
    vi.stubEnv('MICROSOFT_TENANT_ID', TENANT);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    db = { user: [], session: [], account: [], verification: [] };
    logins = [];
    issued.clear();
    userinfoCalls.length = 0;
    clearLoginClaimsStash();
    auth = makeAuth({ oidc: provider() });
  });

  const cookiesOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const hasSession = (res: Response) => /session_token=[^;\s]/.test(res.headers.get('set-cookie') ?? '');
  const failure = (res: Response) => new URL(res.headers.get('location') ?? '', 'http://localhost:3004').searchParams.get('error');

  /** Sign-in redirect, then the callback the IdP sends the browser back to. */
  async function login(code: string, grant: Issued, via: 'oauth2' | 'microsoft' = 'oauth2', a = auth) {
    issued.set(code, grant);
    const start =
      via === 'oauth2'
        ? await a.handler(new Request('http://localhost:3004/api/auth/sign-in/oauth2', {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: 'http://localhost:3004' },
            body: JSON.stringify({ providerId: 'fka', callbackURL: '/dashboard' }),
          }))
        : await a.handler(new Request('http://localhost:3004/api/auth/sign-in/social', {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: 'http://localhost:3004' },
            body: JSON.stringify({ provider: 'microsoft', callbackURL: '/dashboard' }),
          }));
    expect(start.status).toBe(200);
    const { url } = (await start.json()) as { url: string };
    const state = new URL(url).searchParams.get('state')!;
    const path = via === 'oauth2' ? '/api/auth/oauth2/callback/fka' : '/api/auth/callback/microsoft';
    return a.handler(
      new Request(`http://localhost:3004${path}?code=${code}&state=${state}`, { headers: { cookie: cookiesOf(start) } }),
    );
  }

  describe('generic OIDC provider', () => {
    it('logs a person in, and hands the roles of THIS login to the hook, keyed by provider and account', async () => {
      const res = await login('c1', { idToken: tokenClaims({ roles: ['referat-admin', 'noise'] }) });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/dashboard');
      expect(hasSession(res)).toBe(true);
      expect(db.user).toHaveLength(1);
      expect(db.account[0]).toMatchObject({ providerId: 'fka', accountId: 'person-1' });
      expect(logins).toEqual([{ providerId: 'fka', claims: { roles: ['referat-admin', 'noise'] }, roles: ['admin'] }]);
    });

    it('a SECOND login hands over the NEW roles for the same person: nothing is carried over', async () => {
      await login('c1', { idToken: tokenClaims({ roles: ['referat-admin'] }) });
      const second = await login('c2', { idToken: tokenClaims({ roles: ['referat-bruger'] }) });
      expect(hasSession(second)).toBe(true);
      expect(db.user).toHaveLength(1); // the same person, not a new account
      expect(db.account).toHaveLength(1);
      expect(logins.map((l) => l.roles)).toEqual([['admin'], ['bruger']]);
      // The hand-over is single use: a later read finds nothing, so a stale entry can never be replayed.
      expect(takeLoginClaims('fka', 'person-1')).toBeNull();
    });

    it('reads a role claim that is only at the userinfo endpoint', async () => {
      await login('c3', { idToken: tokenClaims(), userinfo: { sub: 'person-1', roles: ['referat-admin'] } });
      expect(userinfoCalls).toEqual(['c3']);
      expect(logins[0].roles).toEqual(['admin']);
    });

    it('does not ask userinfo when the id token already carries the claim', async () => {
      await login('c4', { idToken: tokenClaims({ roles: ['referat-bruger'] }), userinfo: { sub: 'person-1', roles: ['referat-admin'] } });
      expect(userinfoCalls).toEqual([]);
      expect(logins[0].roles).toEqual(['bruger']);
    });

    it('a userinfo answer for another subject is ignored: no roles', async () => {
      await login('c5', { idToken: tokenClaims(), userinfo: { sub: 'someone-else', roles: ['referat-admin'] } });
      expect(logins[0].roles).toEqual([]);
    });

    it.each([
      ['a foreign issuer', { iss: 'https://evil.example' }],
      ['a foreign audience', { aud: 'another-client' }],
      ['no audience', { aud: undefined }],
      ['an expired token', { exp: Math.floor(Date.now() / 1000) - 7200 }],
    ])('refuses %s: no user, no account, no session, no hand-over', async (_n, over) => {
      const res = await login('bad', { idToken: tokenClaims({ roles: ['referat-admin'], ...over }) });
      expect(hasSession(res)).toBe(false);
      expect(failure(res)).toBeTruthy();
      expect(db.user).toHaveLength(0);
      expect(db.account).toHaveLength(0);
      expect(db.session).toHaveLength(0);
      expect(logins).toEqual([]);
      expect(takeLoginClaims('fka', 'person-1')).toBeNull();
    });

    it('a person the IdP maps to no role logs in at the IdP but is REFUSED here: roles [] and "no role, no access" is the claims default', async () => {
      const res = await login('c6', { idToken: tokenClaims({ roles: ['some-other-role'] }) });
      expect(hasSession(res)).toBe(true); // the session exists, the app's guards refuse it
      expect(logins[0].roles).toEqual([]);
      const principal = buildPrincipalFromAssignments({
        userId: 'u',
        directoryUserUuid: null,
        disabled: false,
        assignments: [],
        now: new Date(),
        requireRoleToLogin: requireRoleToLogin(),
        source: 'local',
      });
      expect(requireRoleToLogin()).toBe(true);
      expect(principal.roles).toEqual([]);
    });

    it('with an id token that has no e-mail address and no userinfo, the login is refused without logging a claim', async () => {
      const res = await login('c7', { idToken: tokenClaims({ email: undefined, roles: ['top-secret-role'] }) });
      expect(hasSession(res)).toBe(false);
      expect(JSON.stringify((console.warn as any).mock.calls)).not.toContain('top-secret-role');
      expect(db.user).toHaveLength(0);
    });
  });

  describe('Microsoft Entra ID (built-in provider)', () => {
    beforeEach(() => {
      auth = makeAuth({ entra: true });
    });
    const entraToken = (over: Record<string, unknown> = {}) =>
      tokenClaims({ iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, tid: TENANT, sub: 'oid-1', ...over });

    it('logs in a person of the configured tenant, and hands over the tenant for the hook to re-check', async () => {
      const res = await login('e1', { idToken: entraToken() }, 'microsoft');
      expect(hasSession(res)).toBe(true);
      expect(logins[0].claims).toEqual({ tid: TENANT });
      // It asked for explicit scopes only: no refresh token request.
      expect(db.account[0]).toMatchObject({ providerId: 'microsoft', accountId: 'oid-1' });
    });

    it.each([
      ['another tenant (tid)', { tid: '99999999-2222-3333-4444-555555555555' }],
      ['another tenant (issuer)', { iss: 'https://login.microsoftonline.com/99999999-2222-3333-4444-555555555555/v2.0' }],
      ['another application (audience)', { aud: 'another-app' }],
      ['no tenant claim', { tid: undefined }],
    ])('refuses a token from %s: no user and no session', async (_n, over) => {
      const res = await login('e2', { idToken: entraToken(over) }, 'microsoft');
      expect(hasSession(res)).toBe(false);
      expect(db.user).toHaveLength(0);
      expect(db.session).toHaveLength(0);
      expect(logins).toEqual([]);
    });
  });
});
