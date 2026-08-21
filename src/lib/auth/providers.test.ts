import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  emailPasswordEnabled,
  enabledAuthProviders,
  microsoftConfig,
  oidcConfig,
  resetDeprecationWarning,
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
    if (/^(OIDC_|AUTHENTIK_|MICROSOFT_|EMAIL_PASSWORD_|NEXT_PUBLIC_)/.test(key)) delete clean[key];
  }
  process.env = clean as NodeJS.ProcessEnv;
  resetDeprecationWarning();
});

afterEach(() => {
  process.env = ENV;
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

  it('honours the deprecated NEXT_PUBLIC_MICROSOFT_ENABLED kill switch', () => {
    Object.assign(process.env, MICROSOFT, { NEXT_PUBLIC_MICROSOFT_ENABLED: 'false' });
    expect(microsoftConfig()).toBeNull();
  });

  it('lets the canonical kill switch override the deprecated one', () => {
    Object.assign(process.env, MICROSOFT, {
      MICROSOFT_ENABLED: 'true',
      NEXT_PUBLIC_MICROSOFT_ENABLED: 'false',
    });
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
      legacy: false,
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

  it('rejects a provider id that is not a safe URL path segment', () => {
    Object.assign(process.env, OIDC, { OIDC_PROVIDER_ID: 'foo/bar' });
    expect(() => oidcConfig()).toThrow(/Invalid OIDC_PROVIDER_ID/);

    process.env.OIDC_PROVIDER_ID = 'Foo Bar';
    expect(() => oidcConfig()).toThrow(/Invalid OIDC_PROVIDER_ID/);
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
      legacy: true,
    });
  });

  it('never mixes credential sets — a partial OIDC_* triple falls back wholesale', () => {
    Object.assign(process.env, AUTHENTIK, {
      OIDC_CLIENT_ID: 'oidc-id',
      OIDC_CLIENT_SECRET: 'oidc-secret',
      // no OIDC_DISCOVERY_URL
    });
    expect(oidcConfig()).toMatchObject({
      clientId: 'ak-id',
      clientSecret: 'ak-secret',
      legacy: true,
    });
  });

  it('prefers a complete OIDC_* triple over the legacy one', () => {
    Object.assign(process.env, AUTHENTIK, OIDC);
    expect(oidcConfig()).toMatchObject({ clientId: 'oidc-id', providerId: 'oidc', legacy: false });
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

describe('warnDeprecatedAuthEnv', () => {
  it('stays silent when only canonical vars are set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    Object.assign(process.env, OIDC, MICROSOFT);
    warnDeprecatedAuthEnv();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns once, naming the deprecated vars in use', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    Object.assign(process.env, AUTHENTIK);
    warnDeprecatedAuthEnv();
    warnDeprecatedAuthEnv();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('AUTHENTIK_CLIENT_ID');
    warn.mockRestore();
  });
});
