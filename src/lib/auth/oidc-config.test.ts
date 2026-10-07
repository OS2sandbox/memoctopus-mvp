import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearLoginClaimsStash, takeLoginClaims } from '@/lib/authz/claims-stash';
import { checkEntraIdToken, checkIdTokenClaims, entraSocialConfig, genericOAuthConfigFor, loadOidcProfile, mapOidcProfile, resetOidcDiscoveryCache } from './oidc-config';
import type { OidcProviderConfig } from './providers';

const ISS = 'https://idp.example';

function provider(over: Partial<OidcProviderConfig> = {}): OidcProviderConfig {
  return {
    providerId: 'fka',
    providerName: 'FKA',
    clientId: 'cid',
    clientSecret: 'secret',
    discoveryUrl: 'https://idp.example/.well-known/openid-configuration',
    issuer: ISS,
    scopes: ['openid', 'profile', 'email'],
    pkce: true,
    claims: {},
    ...over,
  };
}

/** An id token as the token endpoint would issue it: the right issuer and audience unless a test says otherwise. */
const jwt = (payload: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify({ iss: ISS, aud: 'cid', ...payload })).toString('base64url')}.s`;

beforeEach(() => {
  clearLoginClaimsStash();
  resetOidcDiscoveryCache();
});

describe('mapOidcProfile', () => {
  it('takes the standard claims by default', () => {
    expect(mapOidcProfile(provider(), { sub: 's1', email: 'Ola@Kommune.dk', name: 'Ola Olsen' })).toEqual({
      email: 'ola@kommune.dk',
      name: 'Ola Olsen',
    });
  });

  it('reads the e-mail from the configured claim, then falls back to mail, upn, preferred_username', () => {
    const p = provider({ claims: { email: 'workMail' } });
    expect(mapOidcProfile(p, { workMail: 'a@k.dk', mail: 'b@k.dk' }).email).toBe('a@k.dk');
    expect(mapOidcProfile(provider(), { mail: 'b@k.dk', upn: 'c@k.dk' }).email).toBe('b@k.dk');
    expect(mapOidcProfile(provider(), { upn: 'c@k.dk', preferred_username: 'd@k.dk' }).email).toBe('c@k.dk');
    expect(mapOidcProfile(provider(), { preferred_username: 'd@k.dk' }).email).toBe('d@k.dk');
  });

  it('never takes a bare username for an e-mail address', () => {
    expect(mapOidcProfile(provider(), { preferred_username: 'ola01', upn: 'also-not-an-address' }).email).toBeUndefined();
  });

  it('builds a name from the usual places', () => {
    expect(mapOidcProfile(provider({ claims: { name: 'displayName' } }), { displayName: 'Ola', name: 'x' }).name).toBe('Ola');
    expect(mapOidcProfile(provider(), { given_name: 'Ola', family_name: 'Olsen', email: 'o@k.dk' }).name).toBe('Ola Olsen');
    expect(mapOidcProfile(provider(), { preferred_username: 'ola01', email: 'o@k.dk' }).name).toBe('ola01');
    expect(mapOidcProfile(provider(), { email: 'o@k.dk' }).name).toBe('o@k.dk');
  });

  it('uses the configured user id claim as the account id', () => {
    expect(mapOidcProfile(provider({ claims: { userId: 'employeeId' } }), { sub: 's', employeeId: 4711, email: 'a@k.dk' }).id).toBe('4711');
    expect(mapOidcProfile(provider(), { sub: 's', email: 'a@k.dk' }).id).toBeUndefined();
  });

  describe('emailVerified (used by better-auth to decide on account linking)', () => {
    it('is not asserted unless a claim is configured for it', () => {
      expect(mapOidcProfile(provider(), { email: 'a@k.dk', email_verified: true })).not.toHaveProperty('emailVerified');
    });
    it('is true for a real true, or the string "true", on the e-mail claim', () => {
      const p = provider({ claims: { emailVerified: 'ev' } });
      expect(mapOidcProfile(p, { email: 'a@k.dk', ev: true }).emailVerified).toBe(true);
      expect(mapOidcProfile(p, { email: 'a@k.dk', ev: 'true' }).emailVerified).toBe(true);
      expect(mapOidcProfile(p, { email: 'a@k.dk', ev: 'yes' }).emailVerified).toBe(false);
      expect(mapOidcProfile(p, { email: 'a@k.dk' }).emailVerified).toBe(false);
    });
    it('is never true for an address taken from a fallback claim', () => {
      const p = provider({ claims: { emailVerified: 'ev' } });
      expect(mapOidcProfile(p, { upn: 'u@k.dk', ev: true }).emailVerified).toBe(false);
      expect(mapOidcProfile(provider(), { upn: 'u@k.dk', email_verified: true }).emailVerified).toBe(false);
    });
  });

  it('hands ONLY the role and group claims over to the login hook, keyed by provider and account', () => {
    const p = provider({ rolesClaim: { name: 'roles', format: 'array', separator: ',' }, groupsClaim: { name: 'a.b', format: 'array', separator: ',' } });
    mapOidcProfile(p, { id: 'acct-1', sub: 'acct-1', email: 'a@k.dk', roles: ['x'], a: { b: ['g'] }, secret: 'not-handed-over' });
    expect(takeLoginClaims('fka', 'acct-1')).toEqual({ roles: ['x'], a: { b: ['g'] } });
    expect(takeLoginClaims('fka', 'acct-1')).toBeNull(); // taken once
  });

  it('hands nothing over when the provider reads no role claims', () => {
    mapOidcProfile(provider(), { id: 'acct-2', email: 'a@k.dk', roles: ['x'] });
    expect(takeLoginClaims('fka', 'acct-2')).toBeNull();
  });

  it('keys the hand-over by the mapped id when a user id claim is configured', () => {
    const p = provider({ claims: { userId: 'employeeId' }, rolesClaim: { name: 'roles', format: 'array', separator: ',' } });
    mapOidcProfile(p, { id: 'sub-1', employeeId: 'e1', email: 'a@k.dk', roles: ['x'] });
    expect(takeLoginClaims('fka', 'e1')).toEqual({ roles: ['x'] });
  });
});

describe('loadOidcProfile', () => {
  const reply = (body: unknown, ok = true) => ({ ok, headers: { get: () => null }, text: async () => JSON.stringify(body) });

  it('uses the id_token alone when it has everything', async () => {
    const fetchFn = vi.fn();
    const out = await loadOidcProfile(provider(), { idToken: jwt({ sub: 's1', email: 'a@k.dk' }), accessToken: 'at' }, fetchFn as never);
    expect(out).toMatchObject({ id: 's1', email: 'a@k.dk' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('asks the userinfo endpoint (found through discovery) for a role claim the id_token lacks', async () => {
    const fetchFn = vi.fn(async (url: string, _init?: unknown) =>
      url.includes('openid-configuration') ? reply({ userinfo_endpoint: 'https://idp.example/userinfo' }) : reply({ sub: 's1', roles: ['admin'], email: 'other@k.dk' }),
    );
    const p = provider({ rolesClaim: { name: 'roles', format: 'array', separator: ',' } });
    const out = await loadOidcProfile(p, { idToken: jwt({ sub: 's1', email: 'a@k.dk' }), accessToken: 'at' }, fetchFn as never);
    expect(out).toMatchObject({ roles: ['admin'], email: 'a@k.dk' }); // the id_token wins on a clash
    const call = fetchFn.mock.calls.find((c) => c[0] === 'https://idp.example/userinfo')!;
    expect((call[1] as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer at');
    // The discovery answer is remembered.
    await loadOidcProfile(p, { idToken: jwt({ sub: 's1', email: 'a@k.dk' }), accessToken: 'at' }, fetchFn as never);
    expect(fetchFn.mock.calls.filter((c) => String(c[0]).includes('openid-configuration'))).toHaveLength(1);
  });

  it('uses an explicit userInfoUrl without discovery', async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: unknown) => reply({ sub: 's1', roles: ['r'] }));
    const p = provider({ discoveryUrl: undefined, userInfoUrl: 'https://idp.example/ui', rolesClaim: { name: 'roles', format: 'array', separator: ',' } });
    await loadOidcProfile(p, { idToken: jwt({ sub: 's1', email: 'a@k.dk' }), accessToken: 'at' }, fetchFn as never);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe('https://idp.example/ui');
  });

  it('discards a userinfo answer for another subject', async () => {
    const fetchFn = vi.fn(async () => reply({ sub: 'someone-else', roles: ['admin'] }));
    const p = provider({ discoveryUrl: undefined, userInfoUrl: 'https://idp.example/ui', rolesClaim: { name: 'roles', format: 'array', separator: ',' } });
    const out = await loadOidcProfile(p, { idToken: jwt({ sub: 's1', email: 'a@k.dk' }), accessToken: 'at' }, fetchFn as never);
    expect(out).not.toHaveProperty('roles');
  });

  it('falls back to the id_token when userinfo fails (the claim is then simply absent)', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('network');
    });
    const p = provider({ discoveryUrl: undefined, userInfoUrl: 'https://idp.example/ui', rolesClaim: { name: 'roles', format: 'array', separator: ',' } });
    const out = await loadOidcProfile(p, { idToken: jwt({ sub: 's1', email: 'a@k.dk' }), accessToken: 'at' }, fetchFn as never);
    expect(out).toMatchObject({ id: 's1' });
    expect(out).not.toHaveProperty('roles');
  });

  it('asks userinfo for the e-mail when the id_token has none, and gives up without a subject', async () => {
    const fetchFn = vi.fn(async () => reply({ sub: 's1', mail: 'm@k.dk' }));
    const p = provider({ discoveryUrl: undefined, userInfoUrl: 'https://idp.example/ui' });
    expect(await loadOidcProfile(p, { idToken: jwt({ sub: 's1' }), accessToken: 'at' }, fetchFn as never)).toMatchObject({ mail: 'm@k.dk' });
    expect(await loadOidcProfile(p, { idToken: jwt({ email: 'a@k.dk' }), accessToken: undefined }, fetchFn as never)).toBeNull();
  });

  describe('id token checks (iss, aud, exp) before any claim is trusted', () => {
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => warn.mockRestore());
    const load = (p: OidcProviderConfig, payload: Record<string, unknown>, fetchFn: unknown = vi.fn()) =>
      loadOidcProfile(p, { idToken: jwt(payload), accessToken: undefined }, fetchFn as never);

    it('refuses a foreign issuer (another tenant, another IdP) and a foreign audience', async () => {
      expect(await load(provider(), { sub: 's', email: 'a@k.dk', iss: 'https://evil.example' })).toBeNull();
      expect(await load(provider(), { sub: 's', email: 'a@k.dk', aud: 'someone-elses-client' })).toBeNull();
      expect(await load(provider(), { sub: 's', email: 'a@k.dk', aud: ['x', 'y'] })).toBeNull();
      expect(await load(provider(), { sub: 's', email: 'a@k.dk', aud: undefined })).toBeNull();
      expect(await load(provider(), { sub: 's', email: 'a@k.dk', iss: undefined })).toBeNull();
    });

    it('accepts the audience as one of several, and needs an exact issuer', async () => {
      expect(await load(provider(), { sub: 's', email: 'a@k.dk', aud: ['x', 'cid'] })).toMatchObject({ id: 's' });
      expect(await load(provider(), { sub: 's', email: 'a@k.dk', iss: `${ISS}/` })).toBeNull();
    });

    it('refuses an expired token (with a minute of tolerance)', async () => {
      const now = Math.floor(Date.now() / 1000);
      expect(await load(provider(), { sub: 's', email: 'a@k.dk', exp: now - 3600 })).toBeNull();
      expect(await load(provider(), { sub: 's', email: 'a@k.dk', exp: now - 30 })).toMatchObject({ id: 's' });
      expect(await load(provider(), { sub: 's', email: 'a@k.dk', exp: now + 3600 })).toMatchObject({ id: 's' });
    });

    it('with only a discoveryUrl the issuer is the discovery document\'s; no answer means no login', async () => {
      const p = provider({ issuer: undefined });
      const ok = vi.fn(async () => reply({ issuer: ISS, userinfo_endpoint: 'https://idp.example/ui' }));
      expect(await load(p, { sub: 's', email: 'a@k.dk' }, ok)).toMatchObject({ id: 's' });
      expect(await load(p, { sub: 's', email: 'a@k.dk', iss: 'https://evil.example' }, ok)).toBeNull();

      resetOidcDiscoveryCache();
      const down = vi.fn(async () => {
        throw new Error('network');
      });
      expect(await load(p, { sub: 's', email: 'a@k.dk' }, down)).toBeNull();
      // A blip is not remembered: the next login discovers again.
      expect(await load(p, { sub: 's', email: 'a@k.dk' }, ok)).toMatchObject({ id: 's' });
    });

    it('with explicit endpoints and no issuer there is nothing to compare, but the audience still counts', async () => {
      const p = provider({ issuer: undefined, discoveryUrl: undefined, authorizationUrl: 'https://i/a', tokenUrl: 'https://i/t' });
      expect(await load(p, { sub: 's', email: 'a@k.dk', iss: 'https://anything.example' })).toMatchObject({ id: 's' });
      expect(await load(p, { sub: 's', email: 'a@k.dk', aud: 'other' })).toBeNull();
    });

    it('an undecodable id token is refused rather than ignored', async () => {
      expect(await loadOidcProfile(provider(), { idToken: 'not-a-jwt', accessToken: 'at' }, vi.fn() as never)).toBeNull();
    });

    it('logs the provider and the failing check only, never a claim', async () => {
      await load(provider(), { sub: 's', email: 'secret@k.dk', roles: ['top-secret-role'], iss: 'https://evil.example' });
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).toContain('fka');
      expect(logged).toContain('iss');
      expect(logged).not.toMatch(/secret|evil/);
    });

    it('checkIdTokenClaims reports which check failed', () => {
      expect(checkIdTokenClaims({ aud: 'c', iss: 'i' }, 'c', 'i')).toBe('ok');
      expect(checkIdTokenClaims({ aud: 'x', iss: 'i' }, 'c', 'i')).toBe('aud');
      expect(checkIdTokenClaims({ aud: 'c', iss: 'x' }, 'c', 'i')).toBe('iss');
      expect(checkIdTokenClaims({ aud: 'c', iss: 'i', exp: 1 }, 'c', 'i')).toBe('exp');
      expect(checkIdTokenClaims({ aud: 'c' }, 'c', undefined)).toBe('ok');
    });
  });

  it('refuses a profile without any e-mail address itself, so better-auth never logs the claims', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await loadOidcProfile(provider(), { idToken: jwt({ sub: 's1', roles: ['secret-role'], name: 'Ola Olsen' }), accessToken: undefined }, vi.fn() as never);
    expect(out).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain('fka');
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret-role|Ola/);
    warn.mockRestore();
  });
});

describe('genericOAuthConfigFor', () => {
  it('passes scopes, pkce and the endpoints on, and always brings its own profile loader', () => {
    const cfg = genericOAuthConfigFor(provider({ scopes: ['openid', 'groups'], pkce: false, discoveryUrl: undefined, authorizationUrl: 'https://i/a', tokenUrl: 'https://i/t', userInfoUrl: 'https://i/u', issuer: 'https://i' }));
    expect(cfg).toMatchObject({
      providerId: 'fka',
      clientId: 'cid',
      scopes: ['openid', 'groups'],
      pkce: false,
      authorizationUrl: 'https://i/a',
      tokenUrl: 'https://i/t',
      userInfoUrl: 'https://i/u',
      issuer: 'https://i',
    });
    expect(cfg).not.toHaveProperty('discoveryUrl');
    expect(typeof cfg.getUserInfo).toBe('function');
    expect(typeof cfg.mapProfileToUser).toBe('function');
  });

  it('passes prompt and max_age to the IdP when configured, and nothing otherwise', () => {
    expect(genericOAuthConfigFor(provider({ prompt: 'login', maxAge: 0 }))).toMatchObject({ prompt: 'login', authorizationUrlParams: { max_age: '0' } });
    const plain = genericOAuthConfigFor(provider());
    expect(plain).not.toHaveProperty('prompt');
    expect(plain).not.toHaveProperty('authorizationUrlParams');
  });
});

describe('Microsoft Entra ID (built-in provider)', () => {
  const TENANT = '11111111-2222-3333-4444-555555555555';
  const m = { clientId: 'cid', clientSecret: 'secret', tenantId: TENANT };
  const token = (payload: Record<string, unknown>) =>
    jwt({ iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, aud: 'cid', tid: TENANT, sub: 'oid-1', email: 'a@k.dk', ...payload });

  it('checks audience, issuer and tenant for a single tenant, and only the audience for a multi-tenant authority', () => {
    const good = { iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, aud: 'cid', tid: TENANT };
    expect(checkEntraIdToken(good, m)).toBe('ok');
    expect(checkEntraIdToken({ ...good, aud: 'x' }, m)).toBe('aud');
    expect(checkEntraIdToken({ ...good, iss: 'https://login.microsoftonline.com/other/v2.0' }, m)).toBe('iss');
    // A token with the right issuer but a foreign tenant id cannot happen from Entra, but is refused anyway.
    expect(checkEntraIdToken({ ...good, tid: '99999999-2222-3333-4444-555555555555' }, m)).toBe('tid');
    expect(checkEntraIdToken({ ...good, tid: undefined }, m)).toBe('tid');
    expect(checkEntraIdToken({ aud: 'cid', iss: 'whatever', tid: 'foreign' }, { ...m, tenantId: 'common' })).toBe('ok');
  });

  it('asks for explicit scopes only: no offline_access, no User.Read, no photo', () => {
    const cfg = entraSocialConfig({ ...m, scopes: ['GroupMember.Read.All', 'offline_access', 'openid'], prompt: 'login' });
    expect(cfg).toMatchObject({ disableDefaultScope: true, disableProfilePhoto: true, prompt: 'login', tenantId: TENANT });
    expect(cfg.scope).toEqual(['openid', 'profile', 'email', 'GroupMember.Read.All']);
    expect(entraSocialConfig(m).scope).toEqual(['openid', 'profile', 'email']);
    expect(entraSocialConfig(m)).not.toHaveProperty('prompt');
  });

  it('getUserInfo builds the login from the id token and stashes the claims for the hook in claims mode only', async () => {
    const take = takeLoginClaims;
    vi.stubEnv('ACCESS_SOURCE', 'claims');
    try {
      const out = await entraSocialConfig(m).getUserInfo({ idToken: token({ name: 'Ola', roles: ['admin'] }) });
      expect(out).toMatchObject({ user: { id: 'oid-1', email: 'a@k.dk', name: 'Ola' } });
      // No rolesClaim configured here: only the tenant travels, which is what the hook re-checks.
      expect(take('microsoft', 'oid-1')).toEqual({ tid: TENANT });
    } finally {
      vi.unstubAllEnvs();
    }
    await entraSocialConfig(m).getUserInfo({ idToken: token({}) });
    expect(take('microsoft', 'oid-1')).toBeNull();
  });

  it('getUserInfo refuses (null: the login fails) a token for the wrong audience, issuer or tenant, or without a subject', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = entraSocialConfig(m);
    expect(await cfg.getUserInfo({ idToken: token({ aud: 'x' }) })).toBeNull();
    expect(await cfg.getUserInfo({ idToken: token({ iss: 'https://login.microsoftonline.com/other/v2.0' }) })).toBeNull();
    expect(await cfg.getUserInfo({ idToken: token({ tid: 'other' }) })).toBeNull();
    expect(await cfg.getUserInfo({ idToken: token({ sub: undefined }) })).toBeNull();
    expect(await cfg.getUserInfo({})).toBeNull();
  });
});
