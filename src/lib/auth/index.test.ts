import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture the options betterAuth is constructed with. The module builds the
// instance at import time, so every test re-imports it with its own env.
const captured: { options?: Record<string, unknown> } = {};
vi.mock('better-auth', () => ({
  betterAuth: (options: Record<string, unknown>) => {
    captured.options = options;
    return { api: {} };
  },
}));
vi.mock('better-auth/adapters/drizzle', () => ({ drizzleAdapter: () => ({}) }));
vi.mock('better-auth/next-js', () => ({ nextCookies: () => ({ id: 'next-cookies' }) }));
vi.mock('better-auth/plugins', () => ({
  genericOAuth: (opts: Record<string, unknown>) => ({ id: 'generic-oauth', opts }),
}));
vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/db/schema', () => ({
  users: {}, sessions: {}, accounts: {}, verifications: {},
}));

const ENV_KEYS = [
  'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_TENANT_ID', 'MICROSOFT_ENABLED',
  'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_DISCOVERY_URL', 'OIDC_PROVIDER_ID', 'OIDC_ENABLED',
  'AUTHENTIK_CLIENT_ID', 'AUTHENTIK_CLIENT_SECRET', 'AUTHENTIK_DISCOVERY_URL',
  'EMAIL_PASSWORD_ENABLED', 'NEXT_PUBLIC_EMAIL_PASSWORD_ENABLED', 'NEXT_PUBLIC_MICROSOFT_ENABLED',
  'BETTER_AUTH_URL', 'BETTER_AUTH_SECRET', 'BETTER_AUTH_TRUSTED_ORIGINS',
];
const saved: Record<string, string | undefined> = {};

async function loadAuth(env: Record<string, string>) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  captured.options = undefined;
  vi.resetModules();
  await import('./index');
  return captured.options!;
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

const MICROSOFT_ENV = {
  MICROSOFT_CLIENT_ID: 'client-id',
  MICROSOFT_CLIENT_SECRET: 'client-secret',
  MICROSOFT_TENANT_ID: 'tenant-id',
  BETTER_AUTH_URL: 'https://example.test',
  BETTER_AUTH_SECRET: 'secret',
};

describe('auth config — user info follows the identity provider', () => {
  // better-auth matches an account on the provider's subject claim and writes
  // name/email only when it first creates the user. Without this flag a user
  // whose mail attribute or display name changes in Entra keeps the address they
  // originally signed up with, which reads in the UI as being logged in as
  // somebody else. It cost real debugging time once; the flag is load-bearing.
  it('refreshes name and email from Entra on every Microsoft sign-in', async () => {
    const options = await loadAuth(MICROSOFT_ENV);
    const social = options.socialProviders as Record<string, Record<string, unknown>>;
    expect(social.microsoft.overrideUserInfoOnSignIn).toBe(true);
  });

  it('still requests the Graph scopes alongside it', async () => {
    const options = await loadAuth(MICROSOFT_ENV);
    const social = options.socialProviders as Record<string, Record<string, unknown>>;
    expect(social.microsoft.scope).toEqual([
      'OnlineMeetings.ReadWrite',
      'OnlineMeetingTranscript.Read.All',
      'OnlineMeetingRecording.Read.All',
    ]);
  });

  it('refreshes user info for the generic OIDC provider too', async () => {
    const options = await loadAuth({
      ...MICROSOFT_ENV,
      OIDC_CLIENT_ID: 'oidc-id',
      OIDC_CLIENT_SECRET: 'oidc-secret',
      OIDC_DISCOVERY_URL: 'https://idp.test/.well-known/openid-configuration',
    });
    const plugins = options.plugins as Array<{ id?: string; opts?: { config?: Array<Record<string, unknown>> } }>;
    const generic = plugins.find((p) => p.id === 'generic-oauth');
    expect(generic?.opts?.config?.[0].overrideUserInfo).toBe(true);
  });

  // Account linking stays at better-auth's defaults on purpose: user.id is the
  // per-user Postgres schema key, so a relaxed linking rule is a data-breach
  // risk, not a convenience. Asserted so it is not loosened by accident.
  it('does not mark any provider as trusted for account linking', async () => {
    const options = await loadAuth(MICROSOFT_ENV);
    const account = options.account as { accountLinking?: unknown } | undefined;
    expect(account?.accountLinking).toBeUndefined();
  });
});
