import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {}, pool: {} }));
const runLoginHooks = vi.fn();
const calls: string[] = [];
const auditLogin = vi.fn();
const auditAuthFailure = vi.fn();
const runSamlLoginHooks = vi.fn();
vi.mock('@/lib/authz/login-hook', () => ({
  runLoginHooks: (...a: unknown[]) => runLoginHooks(...a),
  runSamlLoginHooks: (...a: unknown[]) => runSamlLoginHooks(...a),
  auditLogin: (...a: unknown[]) => auditLogin(...a),
  auditAuthFailure: (...a: unknown[]) => auditAuthFailure(...a),
}));

beforeEach(() => {
  vi.resetModules();
  calls.length = 0;
  runLoginHooks.mockReset().mockImplementation(async () => void calls.push('hooks'));
  auditLogin.mockReset().mockImplementation(async () => void calls.push('audit'));
  auditAuthFailure.mockReset().mockResolvedValue(undefined);
  vi.stubEnv('BETTER_AUTH_SECRET', 'x'.repeat(40));
  vi.stubEnv('BETTER_AUTH_URL', 'http://localhost:3004');
  vi.stubEnv('AUTH_IP_HEADERS', '');
});

async function loadOptions() {
  const { auth } = await import('./index');
  return (auth as unknown as { options: Record<string, any> }).options;
}

describe('auth wiring', () => {
  it('runs the login hooks with the new session user', async () => {
    runLoginHooks.mockResolvedValue(undefined);
    const options = await loadOptions();
    await options.databaseHooks.session.create.after({ userId: 'u1', token: 'secret-token' }, null);
    expect(runLoginHooks).toHaveBeenCalledWith('u1', null);
  });

  it('records auth.login after the login hooks, with the hook context', async () => {
    const options = await loadOptions();
    const session = { userId: 'u1', token: 'secret-token', ipAddress: '203.0.113.1' };
    const ctx = { path: '/sign-in/email' };
    await options.databaseHooks.session.create.after(session, ctx);
    expect(calls).toEqual(['hooks', 'audit']);
    expect(auditLogin).toHaveBeenCalledWith(session, ctx);
  });

  it('feeds every request to the failed-login audit and never alters the response', async () => {
    const options = await loadOptions();
    const ctx = { path: '/sign-in/email', headers: new Headers(), context: { returned: { statusCode: 401 } }, returnHeaders: true };
    const out = await options.hooks.after(ctx);
    expect(auditAuthFailure).toHaveBeenCalledTimes(1);
    expect(auditAuthFailure.mock.calls[0][0]).toMatchObject({ path: '/sign-in/email' });
    // returnHeaders:true wraps the handler result as { headers, response }; response must stay empty.
    expect(out?.response).toBeUndefined();
  });

  it('adds no account linking, no cookie cache and no extra trust', async () => {
    const options = await loadOptions();
    // `account` only carries token encryption (see the Microsoft / Teams tests below), never linking rules.
    expect(options.account).toEqual({ encryptOAuthTokens: true });
    expect(options.account.accountLinking).toBeUndefined();
    expect(options.session).toBeUndefined();
  });

  it('leaves the ip header default alone unless AUTH_IP_HEADERS is set', async () => {
    expect((await loadOptions()).advanced).toBeUndefined();
    vi.resetModules();
    vi.stubEnv('AUTH_IP_HEADERS', 'x-real-ip');
    expect((await loadOptions()).advanced).toEqual({ ipAddress: { ipAddressHeaders: ['x-real-ip'] } });
  });
});

// ─── providers and access mode from AUTH_CONFIG_FILE ─────────────────────────

describe('auth wiring from the config file', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'auth-index-'));
    vi.stubEnv('EMAIL_PASSWORD_ENABLED', 'false');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function useConfig(content: unknown) {
    const file = path.join(dir, 'auth.json');
    writeFileSync(file, JSON.stringify(content));
    vi.stubEnv('AUTH_CONFIG_FILE', file);
  }
  const OIDC = (id: string, extra: object = {}) => ({
    type: 'oidc',
    id,
    clientId: `${id}-client`,
    clientSecret: `${id}-secret`,
    discoveryUrl: `https://${id}.example/.well-known/openid-configuration`,
    ...extra,
  });
  const SAML = { type: 'saml', id: 'kommune', entryPoint: 'https://idp.example/sso', idpEntityId: 'https://idp.example', cert: 'MIICcert' };
  const plugin = (options: any, id: string) => options.plugins.find((p: { id: string }) => p.id === id);
  const names = (options: any) => options.plugins.map((p: { id: string }) => p.id);

  it('registers every OIDC provider of the file with its own scopes and pkce', async () => {
    useConfig({ providers: [OIDC('fka'), OIDC('authentik', { scopes: ['openid', 'profile', 'email', 'groups'], pkce: false })] });
    const options = await loadOptions();
    const configs = plugin(options, 'generic-oauth').options.config;
    expect(configs.map((c: any) => c.providerId)).toEqual(['fka', 'authentik']);
    expect(configs[0]).toMatchObject({ scopes: ['openid', 'profile', 'email'], pkce: true, clientSecret: 'fka-secret' });
    expect(configs[1]).toMatchObject({ scopes: ['openid', 'profile', 'email', 'groups'], pkce: false });
  });

  it('keeps the legacy OIDC_* variables working when there is no file, as one provider', async () => {
    vi.stubEnv('OIDC_CLIENT_ID', 'legacy-id');
    vi.stubEnv('OIDC_CLIENT_SECRET', 'legacy-secret');
    vi.stubEnv('OIDC_DISCOVERY_URL', 'https://legacy.example/.well-known/openid-configuration');
    const configs = plugin(await loadOptions(), 'generic-oauth').options.config;
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({ providerId: 'oidc', clientId: 'legacy-id', scopes: ['openid', 'profile', 'email'], pkce: true });
  });

  it('registers no sso plugin, no sso paths and no extra hook without a SAML provider', async () => {
    useConfig({ providers: [OIDC('fka')] });
    const options = await loadOptions();
    expect(names(options)).not.toContain('sso');
    expect(options.disabledPaths).toBeUndefined();
    expect(options.hooks.before).toBeUndefined();
  });

  it('registers the sso plugin for a SAML provider, closes its provider-management endpoints and guards unknown providers', async () => {
    useConfig({ providers: [SAML] });
    const options = await loadOptions();
    expect(names(options)).toContain('sso');
    expect(names(options).at(-1)).toBe('next-cookies');
    const sso = plugin(options, 'sso').options;
    expect(sso).toMatchObject({ providersLimit: 0, trustEmailVerified: false, provisionUserOnEveryLogin: true });
    expect(sso.defaultSSO.map((d: any) => d.providerId)).toEqual(['kommune']);
    expect(options.disabledPaths).toEqual(expect.arrayContaining(['/sso/register', '/sso/update-provider', '/sso/delete-provider']));
    expect(typeof options.hooks.before).toBe('function');
  });

  it('delivers SAML attributes to the SAML login hook', async () => {
    useConfig({ providers: [SAML] });
    const sso = plugin(await loadOptions(), 'sso').options;
    await sso.provisionUser({ user: { id: 'u1' }, userInfo: { id: 'x', roles: ['r'] }, provider: { providerId: 'kommune' } });
    expect(runSamlLoginHooks).toHaveBeenCalledWith('u1', 'kommune', { id: 'x', roles: ['r'] });
  });

  it('skips a SAML provider that has no SP entity id (no BETTER_AUTH_URL) instead of failing the whole app', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('BETTER_AUTH_URL', '');
    useConfig({ providers: [SAML, OIDC('fka')] });
    const options = await loadOptions();
    expect(names(options)).not.toContain('sso');
    expect(plugin(options, 'generic-oauth').options.config).toHaveLength(1);
  });

  it('passes the Entra tenant and scopes of the file to the Microsoft provider: explicit scopes, no offline_access', async () => {
    const tenant = '11111111-2222-3333-4444-555555555555';
    useConfig({ providers: [{ type: 'entra', clientId: 'e-id', clientSecret: 'e-secret', tenantId: tenant, scopes: ['User.Read', 'offline_access'] }] });
    const options = await loadOptions();
    expect(options.socialProviders.microsoft).toMatchObject({
      clientId: 'e-id',
      clientSecret: 'e-secret',
      tenantId: tenant,
      disableDefaultScope: true,
      scope: ['openid', 'profile', 'email', 'User.Read'],
    });
    expect(typeof options.socialProviders.microsoft.getUserInfo).toBe('function');
  });

  it('does not register an Entra provider on a multi-tenant authority', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    useConfig({ providers: [{ type: 'entra', clientId: 'e-id', clientSecret: 'e-secret', tenantId: 'common' }] });
    expect((await loadOptions()).socialProviders).toEqual({});
  });

  describe('claims mode is not open', () => {
    beforeEach(() => {
      vi.stubEnv('ACCESS_SOURCE', 'claims');
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    it('turns e-mail/password off and closes sign-up, even with EMAIL_PASSWORD_ENABLED=true', async () => {
      vi.stubEnv('EMAIL_PASSWORD_ENABLED', '');
      expect((await loadOptions()).emailAndPassword).toEqual({ enabled: false, disableSignUp: true });
      vi.resetModules();
      vi.stubEnv('EMAIL_PASSWORD_ENABLED', 'true');
      expect((await loadOptions()).emailAndPassword).toEqual({ enabled: false, disableSignUp: true });
    });

    it('leaves sign-up alone outside claims mode', async () => {
      vi.stubEnv('ACCESS_SOURCE', 'local');
      vi.stubEnv('EMAIL_PASSWORD_ENABLED', 'true');
      expect((await loadOptions()).emailAndPassword).toEqual({ enabled: true });
    });

    it('warns (content-free) when roles are not required; no password warning, passwords are simply off', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.stubEnv('REQUIRE_ROLE_TO_LOGIN', 'false');
      vi.stubEnv('EMAIL_PASSWORD_ENABLED', 'true');
      await loadOptions();
      const out = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(out).toContain('REQUIRE_ROLE_TO_LOGIN=false');
      expect(out).not.toContain('EMAIL_PASSWORD_ENABLED');
    });
  });

  describe('the real instance, end to end through its handler (no database needed)', () => {
    const call = async (path: string, body?: unknown) => {
      const { auth } = await import('./index');
      return auth.handler(
        new Request(`http://localhost:3004/api/auth${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { 'content-type': 'application/json', origin: 'http://localhost:3004' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    };

    it('builds and answers', async () => {
      const res = await call('/ok');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });

    it('claims mode: nobody can register or sign in with a password, even with EMAIL_PASSWORD_ENABLED=true', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.stubEnv('ACCESS_SOURCE', 'claims');
      for (const v of ['', 'true']) {
        vi.resetModules();
        vi.stubEnv('EMAIL_PASSWORD_ENABLED', v);
        const signUp = await call('/sign-up/email', { email: 'a@b.dk', password: 'correct horse battery', name: 'A' });
        expect(signUp.status, v).toBe(400);
        const signIn = await call('/sign-in/email', { email: 'a@b.dk', password: 'correct horse battery' });
        expect(signIn.status, v).toBe(400);
      }
    });
  });

  describe('start-up warnings about risky combinations', () => {
    it('warns about ACCESS_SOURCE=local in production, and about a roles section outside claims mode', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('BETTER_AUTH_URL', 'https://referat.example');
      vi.stubEnv('ACCESS_SOURCE', 'local');
      useConfig({ providers: [OIDC('fka')], roles: { appRoleMap: { x: 'bruger' } } });
      await loadOptions();
      const out = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(out).toContain('ACCESS_SOURCE=local in production');
      expect(out).toContain('"roles" section but ACCESS_SOURCE is not claims');
      expect(out).not.toContain('bruger');
    });
  });

  describe('session lifetime in claims mode', () => {
    it('ends a session with the role snapshot: expiresIn and updateAge both ROLE_CLAIMS_MAX_SECONDS (default 8 h)', async () => {
      vi.stubEnv('ACCESS_SOURCE', 'claims');
      expect((await loadOptions()).session).toEqual({ expiresIn: 28_800, updateAge: 28_800, disableSessionRefresh: true });
      vi.resetModules();
      vi.stubEnv('ROLE_CLAIMS_MAX_SECONDS', '3600');
      expect((await loadOptions()).session).toEqual({ expiresIn: 3600, updateAge: 3600, disableSessionRefresh: true });
    });

    it.each(['local', 'rollekatalog'])('leaves the session default alone in %s mode', async (mode) => {
      vi.stubEnv('ACCESS_SOURCE', mode);
      expect((await loadOptions()).session).toBeUndefined();
    });

    it('does not crash at start on an invalid ACCESS_SOURCE (the request guards answer 503)', async () => {
      vi.stubEnv('ACCESS_SOURCE', 'rolekatalog');
      expect((await loadOptions()).session).toBeUndefined();
    });
  });

  it('warns once, without values, when claims mode has no usable roles section', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('ACCESS_SOURCE', 'claims');
    useConfig({ providers: [OIDC('fka')], roles: { appRoleMap: { x: 'tt-god' } } });
    await loadOptions();
    const out = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('ACCESS_SOURCE=claims'));
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('invalid');
    expect(out[0]).not.toContain('tt-god');
  });
});

// ─── Microsoft login with the Teams / Graph integration ───────────────────────

describe('Microsoft login and the Teams / Graph integration', () => {
  const TENANT = '11111111-2222-3333-4444-555555555555';
  beforeEach(() => {
    vi.stubEnv('EMAIL_PASSWORD_ENABLED', 'false');
    vi.stubEnv('MICROSOFT_CLIENT_ID', 'client-id');
    vi.stubEnv('MICROSOFT_CLIENT_SECRET', 'client-secret');
    vi.stubEnv('MICROSOFT_TENANT_ID', TENANT);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  const microsoft = async () => (await loadOptions()).socialProviders.microsoft;

  it('keeps the legacy MICROSOFT_* variables working: tenant, credentials and the hardened id token check', async () => {
    const m = await microsoft();
    expect(m).toMatchObject({ clientId: 'client-id', clientSecret: 'client-secret', tenantId: TENANT, disableDefaultScope: true });
    expect(typeof m.getUserInfo).toBe('function');
  });

  it('requests the Graph scopes once Teams is enabled (with User.Read and offline_access for the refresh token)', async () => {
    vi.stubEnv('TEAMS_GRAPH_ENABLED', 'true');
    expect((await microsoft()).scope).toEqual([
      'openid',
      'profile',
      'email',
      'User.Read',
      'offline_access',
      'OnlineMeetings.ReadWrite',
      'OnlineMeetingTranscript.Read.All',
      'OnlineMeetingRecording.Read.All',
      'Files.ReadWrite',
    ]);
  });

  it('leaves the recording and files scopes out in transcript-only mode without recording deletion', async () => {
    vi.stubEnv('TEAMS_GRAPH_ENABLED', 'true');
    vi.stubEnv('TEAMS_ARTIFACT_MODE', 'transcript-only');
    vi.stubEnv('TEAMS_DELETE_RECORDING', 'false');
    const scope = (await microsoft()).scope as string[];
    expect(scope).toContain('OnlineMeetingTranscript.Read.All');
    expect(scope).not.toContain('OnlineMeetingRecording.Read.All');
    expect(scope).not.toContain('Files.ReadWrite');
  });

  // Some tenants have not granted admin consent for the *.Read.All scopes, and Entra answers "Need admin approval"
  // to any authorize request that names them, so requesting them unconditionally locks every Microsoft user out.
  it('requests no Graph scope, no User.Read and no offline_access while Teams is disabled', async () => {
    expect((await microsoft()).scope).toEqual(['openid', 'profile', 'email']);
  });

  it('keeps the stored name and e-mail in step with Entra for one named tenant only', async () => {
    expect((await microsoft()).overrideUserInfoOnSignIn).toBe(true);
    vi.resetModules();
    vi.stubEnv('MICROSOFT_TENANT_ID', 'organizations');
    expect((await microsoft()).overrideUserInfoOnSignIn).toBeUndefined();
  });

  // The refresh token gives about 90 days of offline access to meeting transcripts and recordings once Teams is
  // enabled, so it must not sit in the database (or a backup of it) in the clear.
  it('encrypts stored OAuth tokens at rest', async () => {
    expect((await loadOptions()).account.encryptOAuthTokens).toBe(true);
  });

  // Account linking stays at better-auth's defaults on purpose: user.id is the per-user Postgres schema key, so a
  // relaxed linking rule is a data-breach risk, not a convenience.
  it('does not mark any provider as trusted for account linking', async () => {
    expect((await loadOptions()).account.accountLinking).toBeUndefined();
  });
});
