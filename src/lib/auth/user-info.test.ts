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
vi.mock('@/lib/db/schema', () => ({ users: {}, sessions: {}, accounts: {}, verifications: {} }));

const ENV_KEYS = [
  'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_TENANT_ID', 'MICROSOFT_ENABLED',
  'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_DISCOVERY_URL', 'OIDC_PROVIDER_ID', 'OIDC_ENABLED',
  'AUTHENTIK_CLIENT_ID', 'AUTHENTIK_CLIENT_SECRET', 'AUTHENTIK_DISCOVERY_URL',
  'EMAIL_PASSWORD_ENABLED', 'NEXT_PUBLIC_EMAIL_PASSWORD_ENABLED', 'NEXT_PUBLIC_MICROSOFT_ENABLED',
  'BETTER_AUTH_URL', 'BETTER_AUTH_SECRET', 'BETTER_AUTH_TRUSTED_ORIGINS',
];
const saved: Record<string, string | undefined> = {};

async function microsoftOptions(env: Record<string, string>) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, {
    MICROSOFT_CLIENT_ID: 'client-id',
    MICROSOFT_CLIENT_SECRET: 'client-secret',
    BETTER_AUTH_URL: 'https://example.test',
    BETTER_AUTH_SECRET: 'secret',
    ...env,
  });
  captured.options = undefined;
  vi.resetModules();
  await import('./index');
  const social = captured.options!.socialProviders as Record<string, Record<string, unknown>>;
  return social.microsoft;
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

// better-auth matches an account on the provider's subject claim and writes name and email
// only when it first creates the user. Without this flag a user whose mail attribute changes
// in Entra keeps the address they signed up with, which reads in the UI as being logged in
// as somebody else. That happened once. But the flag makes the stored email follow the
// `email` claim on every sign-in, so it is only safe where that claim can be trusted.
describe('Microsoft: stored name and email follow Entra', () => {
  it('refreshes them on every sign-in when one named tenant is configured', async () => {
    const microsoft = await microsoftOptions({ MICROSOFT_TENANT_ID: '11111111-2222-3333-4444-555555555555' });
    expect(microsoft.overrideUserInfoOnSignIn).toBe(true);
  });

  it.each([
    ['blank (defaults to common)', {}],
    ['common', { MICROSOFT_TENANT_ID: 'common' }],
    ['organizations', { MICROSOFT_TENANT_ID: 'organizations' }],
    ['consumers', { MICROSOFT_TENANT_ID: 'consumers' }],
    ['Common in another case', { MICROSOFT_TENANT_ID: 'Common' }],
  ])('does not, under the multi-tenant authority: %s', async (_label, env) => {
    // There the claim is set by whichever tenant the user comes from, and Entra does not
    // guarantee it is verified or unchanged.
    const microsoft = await microsoftOptions(env);
    expect(microsoft).not.toHaveProperty('overrideUserInfoOnSignIn');
  });

  it('leaves the rest of the provider config alone', async () => {
    const microsoft = await microsoftOptions({ MICROSOFT_TENANT_ID: 'contoso-tenant-id' });
    expect(microsoft).toMatchObject({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tenantId: 'contoso-tenant-id',
    });
  });
});
