import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetAuthConfigCache } from './config-file';
import {
  authRolesConfig,
  emailPasswordEnabled,
  emailPasswordSignUpDisabled,
  enabledAuthProviders,
  microsoftConfig,
  microsoftTenantId,
  oidcConfig,
  oidcProviders,
  providerClaimSpecs,
  samlProviders,
  warnDeprecatedAuthEnv,
} from './providers';

const ENV = process.env;

const OIDC = {
  OIDC_CLIENT_ID: 'oidc-id',
  OIDC_CLIENT_SECRET: 'oidc-secret',
  OIDC_DISCOVERY_URL: 'https://idp.example/.well-known/openid-configuration',
};

const AUTHENTIK = {
  AUTHENTIK_CLIENT_ID: 'ak-id',
  AUTHENTIK_CLIENT_SECRET: 'ak-secret',
  AUTHENTIK_DISCOVERY_URL: 'https://authentik.example/application/o/app/.well-known/openid-configuration',
};

const MICROSOFT = {
  MICROSOFT_CLIENT_ID: 'ms-id',
  MICROSOFT_CLIENT_SECRET: 'ms-secret',
};

beforeEach(() => {
  // Start every case from an env with none of the auth vars set, so a real
  // ambient .env can't leak in and make assertions pass for the wrong reason.
  const clean = { ...ENV } as Record<string, string | undefined>;
  for (const key of Object.keys(clean)) {
    if (/^(OIDC_|AUTHENTIK_|MICROSOFT_|EMAIL_PASSWORD_|NEXT_PUBLIC_|AUTH_CONFIG_FILE|ACCESS_SOURCE|BETTER_AUTH_URL)/.test(key)) delete clean[key];
  }
  process.env = clean as NodeJS.ProcessEnv;
  resetAuthConfigCache();
});

afterEach(() => {
  process.env = ENV;
  vi.restoreAllMocks();
});

describe('claims mode is not open', () => {
  beforeEach(() => {
    process.env.ACCESS_SOURCE = 'claims';
  });

  it('email/password is OFF unless EMAIL_PASSWORD_ENABLED is explicitly "true"', () => {
    expect(emailPasswordEnabled()).toBe(false);
    for (const v of ['', 'yes', '1', 'false', 'TRUE ']) {
      process.env.EMAIL_PASSWORD_ENABLED = v;
      expect(emailPasswordEnabled(), v).toBe(v.trim().toLowerCase() === 'true');
    }
    delete process.env.EMAIL_PASSWORD_ENABLED;
    process.env.NEXT_PUBLIC_EMAIL_PASSWORD_ENABLED = 'true';
    expect(emailPasswordEnabled()).toBe(true);
  });

  it('sign-up stays closed in claims mode, even with passwords enabled; other modes are unchanged', () => {
    process.env.EMAIL_PASSWORD_ENABLED = 'true';
    expect(emailPasswordSignUpDisabled()).toBe(true);
    process.env.ACCESS_SOURCE = 'local';
    expect(emailPasswordSignUpDisabled()).toBe(false);
    process.env.ACCESS_SOURCE = 'rollekatalog';
    expect(emailPasswordSignUpDisabled()).toBe(false);
    delete process.env.EMAIL_PASSWORD_ENABLED;
    expect(emailPasswordEnabled()).toBe(true);
  });

  it('the legacy Microsoft variables need a single-tenant GUID in claims mode (no common default)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    Object.assign(process.env, MICROSOFT);
    expect(microsoftConfig()).toBeNull();
    process.env.MICROSOFT_TENANT_ID = 'organizations';
    expect(microsoftConfig()).toBeNull();
    process.env.MICROSOFT_TENANT_ID = '11111111-2222-3333-4444-555555555555';
    expect(microsoftConfig()?.tenantId).toBe('11111111-2222-3333-4444-555555555555');
    process.env.ACCESS_SOURCE = 'local';
    delete process.env.MICROSOFT_TENANT_ID;
    expect(microsoftConfig()?.tenantId).toBe('common');
  });
});

describe('emailPasswordEnabled', () => {
  it('is on by default', () => {
    expect(emailPasswordEnabled()).toBe(true);
  });

  it('is off only when explicitly "false"', () => {
    process.env.EMAIL_PASSWORD_ENABLED = 'false';
    expect(emailPasswordEnabled()).toBe(false);
  });

  it('treats any other value as on', () => {
    process.env.EMAIL_PASSWORD_ENABLED = '0';
    expect(emailPasswordEnabled()).toBe(true);
  });

  it('honours the deprecated NEXT_PUBLIC_ alias', () => {
    process.env.NEXT_PUBLIC_EMAIL_PASSWORD_ENABLED = 'false';
    expect(emailPasswordEnabled()).toBe(false);
  });

  it('prefers the canonical name over the deprecated alias', () => {
    process.env.EMAIL_PASSWORD_ENABLED = 'true';
    process.env.NEXT_PUBLIC_EMAIL_PASSWORD_ENABLED = 'false';
    expect(emailPasswordEnabled()).toBe(true);
  });
});

describe('microsoftConfig', () => {
  it('is null without credentials', () => {
    expect(microsoftConfig()).toBeNull();
  });

  it('enables on credential presence alone, defaulting the tenant to "common"', () => {
    Object.assign(process.env, MICROSOFT);
    expect(microsoftConfig()).toEqual({
      clientId: 'ms-id',
      clientSecret: 'ms-secret',
      tenantId: 'common',
    });
  });

  it('uses MICROSOFT_TENANT_ID when set', () => {
    Object.assign(process.env, MICROSOFT, { MICROSOFT_TENANT_ID: 'tenant-1' });
    expect(microsoftConfig()?.tenantId).toBe('tenant-1');
  });

  it('is null when half-configured', () => {
    process.env.MICROSOFT_CLIENT_ID = 'ms-id';
    expect(microsoftConfig()).toBeNull();
  });

  it('is disabled by the MICROSOFT_ENABLED kill switch', () => {
    Object.assign(process.env, MICROSOFT, { MICROSOFT_ENABLED: 'false' });
    expect(microsoftConfig()).toBeNull();
  });

  it('ignores a stale NEXT_PUBLIC_MICROSOFT_ENABLED=false', () => {
    // The old .env examples shipped that line as a default, so honouring it
    // would silently break a first-time Microsoft setup after upgrading.
    Object.assign(process.env, MICROSOFT, { NEXT_PUBLIC_MICROSOFT_ENABLED: 'false' });
    expect(microsoftConfig()).not.toBeNull();
  });
});

describe('oidcConfig — OIDC_* path', () => {
  it('is null when nothing is configured', () => {
    expect(oidcConfig()).toBeNull();
  });

  it('resolves a full OIDC_* triple with generic defaults', () => {
    Object.assign(process.env, OIDC);
    expect(oidcConfig()).toEqual({
      providerId: 'oidc',
      providerName: 'SSO',
      clientId: 'oidc-id',
      clientSecret: 'oidc-secret',
      discoveryUrl: OIDC.OIDC_DISCOVERY_URL,
      pkce: true,
    });
  });

  it('title-cases the provider id into a default label', () => {
    Object.assign(process.env, OIDC, { OIDC_PROVIDER_ID: 'keycloak' });
    expect(oidcConfig()).toMatchObject({ providerId: 'keycloak', providerName: 'Keycloak' });
  });

  it('lets OIDC_PROVIDER_NAME override the derived label', () => {
    Object.assign(process.env, OIDC, {
      OIDC_PROVIDER_ID: 'keycloak',
      OIDC_PROVIDER_NAME: 'Hjørring Kommune Login',
    });
    expect(oidcConfig()?.providerName).toBe('Hjørring Kommune Login');
  });

  it('defaults PKCE on and allows opting out', () => {
    Object.assign(process.env, OIDC, { OIDC_PKCE: 'false' });
    expect(oidcConfig()?.pkce).toBe(false);
  });

  it('is disabled by the OIDC_ENABLED kill switch', () => {
    Object.assign(process.env, OIDC, { OIDC_ENABLED: 'false' });
    expect(oidcConfig()).toBeNull();
  });

  it('treats empty strings as unset (docker-compose passes ${VAR:-})', () => {
    Object.assign(process.env, OIDC, { OIDC_CLIENT_SECRET: '   ' });
    expect(oidcConfig()).toBeNull();
  });

  it('lower-cases the provider id rather than rejecting it', () => {
    Object.assign(process.env, OIDC, { OIDC_PROVIDER_ID: 'Keycloak' });
    expect(oidcConfig()).toMatchObject({ providerId: 'keycloak' });
  });

  it('disables OIDC — rather than throwing — on an unusable provider id', () => {
    spyOnWarn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    Object.assign(process.env, OIDC, { OIDC_PROVIDER_ID: 'foo/bar' });

    // Throwing here would 500 every route, including email/password login.
    expect(oidcConfig()).toBeNull();
    expect(error).toHaveBeenCalled();
  });

  it('refuses to reuse a built-in social provider id', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    Object.assign(process.env, OIDC, { OIDC_PROVIDER_ID: 'microsoft' });
    expect(oidcConfig()).toBeNull();
    expect(error).toHaveBeenCalled();
  });
});

describe('oidcConfig — deprecated AUTHENTIK_* fallback', () => {
  it('falls back to the legacy triple, pinning the provider id to "authentik"', () => {
    Object.assign(process.env, AUTHENTIK);
    expect(oidcConfig()).toEqual({
      providerId: 'authentik',
      providerName: 'Authentik',
      clientId: 'ak-id',
      clientSecret: 'ak-secret',
      discoveryUrl: AUTHENTIK.AUTHENTIK_DISCOVERY_URL,
      pkce: true,
    });
  });

  it('never mixes credential sets — a partial OIDC_* triple falls back wholesale', () => {
    Object.assign(process.env, AUTHENTIK, {
      OIDC_CLIENT_ID: 'oidc-id',
      OIDC_CLIENT_SECRET: 'oidc-secret',
      // no OIDC_DISCOVERY_URL
    });
    expect(oidcConfig()).toMatchObject({ clientId: 'ak-id', clientSecret: 'ak-secret' });
  });

  it('prefers a complete OIDC_* triple over the legacy one', () => {
    Object.assign(process.env, AUTHENTIK, OIDC);
    expect(oidcConfig()).toMatchObject({ clientId: 'oidc-id', providerId: 'oidc' });
  });

  it('lets an explicit OIDC_PROVIDER_ID win on the legacy path', () => {
    Object.assign(process.env, AUTHENTIK, { OIDC_PROVIDER_ID: 'keycloak' });
    expect(oidcConfig()).toMatchObject({ providerId: 'keycloak', providerName: 'Keycloak' });
  });

  it('honours NEXT_PUBLIC_AUTHENTIK_ENABLED as a kill switch on the legacy path', () => {
    Object.assign(process.env, AUTHENTIK, { NEXT_PUBLIC_AUTHENTIK_ENABLED: 'false' });
    expect(oidcConfig()).toBeNull();
  });

  it('ignores a stale NEXT_PUBLIC_AUTHENTIK_ENABLED once OIDC_* is configured', () => {
    Object.assign(process.env, OIDC, { NEXT_PUBLIC_AUTHENTIK_ENABLED: 'false' });
    expect(oidcConfig()).not.toBeNull();
  });
});

describe('enabledAuthProviders', () => {
  it('is empty when nothing is configured', () => {
    expect(enabledAuthProviders()).toEqual([]);
  });

  it('lists Microsoft before the OIDC provider', () => {
    Object.assign(process.env, MICROSOFT, OIDC, { OIDC_PROVIDER_NAME: 'Keycloak' });
    expect(enabledAuthProviders()).toEqual([
      { kind: 'social', id: 'microsoft', label: 'Microsoft' },
      { kind: 'oauth2', id: 'oidc', label: 'Keycloak' },
    ]);
  });

  it('never leaks client secrets — the result is sent to the browser', () => {
    Object.assign(process.env, MICROSOFT, OIDC);
    const serialized = JSON.stringify(enabledAuthProviders());
    expect(serialized).not.toContain('oidc-secret');
    expect(serialized).not.toContain('ms-secret');
  });
});

const spyOnWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

describe('warnDeprecatedAuthEnv', () => {
  let warn: ReturnType<typeof spyOnWarn>;

  beforeEach(() => {
    warn = spyOnWarn();
  });

  it('stays silent when only canonical vars are set', () => {
    Object.assign(process.env, OIDC, MICROSOFT);
    warnDeprecatedAuthEnv();
    expect(warn).not.toHaveBeenCalled();
  });

  it('names the deprecated vars in use', () => {
    Object.assign(process.env, AUTHENTIK, { NEXT_PUBLIC_MICROSOFT_ENABLED: 'false' });
    warnDeprecatedAuthEnv();
    expect(warn.mock.calls[0][0]).toContain('AUTHENTIK_CLIENT_ID');
    expect(warn.mock.calls[0][0]).toContain('NEXT_PUBLIC_MICROSOFT_ENABLED');
  });
});

// ─── AUTH_CONFIG_FILE ────────────────────────────────────────────────────────

describe('providers from AUTH_CONFIG_FILE', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'providers-'));
    process.env.BETTER_AUTH_URL = 'https://referat.example';
    spyOnWarn();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    resetAuthConfigCache();
  });
  function config(content: unknown) {
    const file = path.join(dir, 'auth.json');
    writeFileSync(file, JSON.stringify(content));
    process.env.AUTH_CONFIG_FILE = file;
    resetAuthConfigCache();
  }
  const FKA = { type: 'oidc', id: 'fka', label: 'FKA Log ind', clientId: 'a', clientSecret: 'b', discoveryUrl: 'https://fka.example/.well-known/openid-configuration' };
  const HJORRING = { type: 'oidc', id: 'authentik', clientId: 'c', clientSecret: 'd', discoveryUrl: 'https://ak.example/o/app/.well-known/openid-configuration', scopes: ['openid', 'profile', 'email', 'groups'], pkce: false };
  const TENANT = '11111111-2222-3333-4444-555555555555';
  const SAML = { type: 'saml', id: 'os2faktor', label: 'OS2faktor', entryPoint: 'https://idp.example/sso', idpEntityId: 'https://idp.example', cert: 'MIIC' };

  it('lists several OIDC providers, then SAML, with their labels (and no secret)', () => {
    config({ providers: [FKA, HJORRING, SAML, { type: 'entra', clientId: 'e', clientSecret: 'f', tenantId: TENANT, label: 'Entra' }] });
    expect(enabledAuthProviders()).toEqual([
      { kind: 'social', id: 'microsoft', label: 'Entra' },
      { kind: 'oauth2', id: 'fka', label: 'FKA Log ind' },
      { kind: 'oauth2', id: 'authentik', label: 'Authentik' },
      { kind: 'sso', id: 'os2faktor', label: 'OS2faktor' },
    ]);
    const serialized = JSON.stringify(enabledAuthProviders());
    for (const secret of ['"b"', '"d"', '"f"', 'MIIC']) expect(serialized).not.toContain(secret);
  });

  it('does not offer SAML providers the plugin skips (no BETTER_AUTH_URL means no ACS URL)', () => {
    config({ providers: [FKA, SAML] });
    delete process.env.BETTER_AUTH_URL;
    expect(enabledAuthProviders().map((p) => p.id)).toEqual(['fka']);
  });

  it('carries scopes, pkce and endpoints through to the resolved OIDC provider', () => {
    config({ providers: [HJORRING] });
    expect(oidcProviders()).toEqual([
      expect.objectContaining({ providerId: 'authentik', scopes: ['openid', 'profile', 'email', 'groups'], pkce: false, claims: {} }),
    ]);
  });

  it('a configured file REPLACES the legacy variables, even a broken file', () => {
    Object.assign(process.env, OIDC, MICROSOFT);
    config({ providers: [SAML] });
    expect(enabledAuthProviders().map((p) => p.id)).toEqual(['os2faktor']);
    process.env.AUTH_CONFIG_FILE = path.join(dir, 'does-not-exist.json');
    resetAuthConfigCache();
    expect(enabledAuthProviders()).toEqual([]);
    expect(microsoftConfig()).toBeNull();
  });

  it('warns that the legacy variables are ignored, naming the variables only', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    Object.assign(process.env, OIDC);
    config({ providers: [FKA] });
    warnDeprecatedAuthEnv();
    expect(warn.mock.calls.flat().join(' ')).toMatch(/AUTH_CONFIG_FILE is set.*OIDC_CLIENT_ID/);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('oidc-secret');
  });

  it('exposes the claim names per provider, for the login hook', () => {
    config({ providers: [{ ...FKA, claims: { email: 'mail' }, rolesClaim: 'roles', groupsClaim: { name: 'g', format: 'delimited', separator: ';' } }] });
    expect(providerClaimSpecs('fka')).toEqual({
      claims: { email: 'mail' },
      rolesClaim: { name: 'roles', format: 'array', separator: ',' },
      groupsClaim: { name: 'g', format: 'delimited', separator: ';' },
    });
    expect(providerClaimSpecs('nobody')).toBeNull();
  });

  it('has no claim specs for the legacy variables (claims mode needs the file)', () => {
    Object.assign(process.env, OIDC);
    expect(providerClaimSpecs('oidc')).toBeNull();
    expect(oidcProviders()).toEqual([expect.objectContaining({ providerId: 'oidc', scopes: ['openid', 'profile', 'email'] })]);
  });

  it('exposes the SAML providers and the roles section', () => {
    config({ providers: [SAML], roles: { appRoleMap: { admin: 'tt-administrator' } } });
    expect(samlProviders().map((p) => p.id)).toEqual(['os2faktor']);
    expect(authRolesConfig().state).toBe('ok');
  });

  it('takes the Entra tenant from the file, else from MICROSOFT_TENANT_ID', () => {
    process.env.MICROSOFT_TENANT_ID = 'env-tenant';
    expect(microsoftTenantId()).toBe('env-tenant');
    config({ providers: [{ type: 'entra', clientId: 'e', clientSecret: 'f', tenantId: TENANT }] });
    expect(microsoftTenantId()).toBe(TENANT);
    expect(microsoftConfig()).toMatchObject({ tenantId: TENANT });
    config({ providers: [FKA] });
    expect(microsoftTenantId()).toBeUndefined();
  });

  it('passes Entra scopes through', () => {
    config({ providers: [{ type: 'entra', clientId: 'e', clientSecret: 'f', tenantId: TENANT, scopes: ['GroupMember.Read.All'], prompt: 'login' }] });
    expect(microsoftConfig()).toEqual({ clientId: 'e', clientSecret: 'f', tenantId: TENANT, scopes: ['GroupMember.Read.All'], prompt: 'login' });
  });
});
