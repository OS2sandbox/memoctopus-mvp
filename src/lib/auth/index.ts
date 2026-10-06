import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';
import { createAuthMiddleware } from 'better-auth/api';
import { genericOAuth } from 'better-auth/plugins';
import { db } from '@/lib/db';
import {
  auditAuthFailure,
  auditLogin,
  auditLogout,
  runLoginHooks,
  type AuthHookContext,
} from '@/lib/authz/login-hook';
import { users, sessions, accounts, verifications } from '@/lib/db/schema';
import {
  emailPasswordEnabled,
  microsoftConfig,
  oidcConfig,
  warnDeprecatedAuthEnv,
} from './providers';
import { authIpHeaders } from './ip-headers';

// Resolved in ./providers so the sign-in page renders exactly what is
// registered here.
const microsoft = microsoftConfig();
const oidc = oidcConfig();
const ipAddressHeaders = authIpHeaders();

warnDeprecatedAuthEnv();

// ─── Real better-auth instance ────────────────────────────────────────────────
// Each user gets a stable `user.id`, which the rest of the app uses as the
// per-user PostgreSQL schema key (see ensureUserSchema / queryUserSchema).

// better-auth validates the request Origin against trustedOrigins whenever a
// cookie is present (i.e. every browser request). It auto-trusts the baseURL
// origin only, which breaks the moment the dev server runs on a different port.
// In development trust ANY localhost / 127.0.0.1 port (wildcard patterns) so a
// fresh test setup works on whatever port `next dev -p <port>` happens to use,
// without INVALID_ORIGIN. Extra origins can be added via BETTER_AUTH_TRUSTED_ORIGINS.
const devTrustedOrigins =
  process.env.NODE_ENV === 'production'
    ? []
    : ['http://localhost:*', 'http://127.0.0.1:*'];

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins: [
    ...(process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    ...devTrustedOrigins,
  ],
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: users,
      session: sessions,
      account: accounts,
      verification: verifications,
    },
  }),
  emailAndPassword: {
    enabled: emailPasswordEnabled(),
  },
  ...(ipAddressHeaders ? { advanced: { ipAddress: { ipAddressHeaders } } } : {}),
  // Identity capture / first-admin bootstrap / directory link. Fires after the
  // session row is committed; runLoginHooks never throws, so it cannot block a
  // login. No session.cookieCache: roles are resolved live per request.
  // The audit* helpers share that contract (never throw, bounded wait).
  databaseHooks: {
    session: {
      create: {
        after: async (session, ctx) => {
          await runLoginHooks(session.userId);
          // After the hooks above, so the actor snapshot sees a freshly linked org unit.
          await auditLogin(session, ctx as AuthHookContext | null);
        },
      },
      delete: {
        // Fires for expiry cleanup and revocation too; auditLogout keeps only /sign-out.
        after: async (session, ctx) => {
          await auditLogout(session, ctx as AuthHookContext | null);
        },
      },
    },
  },
  // Failed sign-ins have no session, so they cannot come from databaseHooks.
  // Returns nothing: it must never change the response.
  hooks: {
    after: createAuthMiddleware(async (ctx) => {
      await auditAuthFailure(ctx as unknown as AuthHookContext);
    }),
  },
  socialProviders: microsoft ? { microsoft } : {},
  // No `account.accountLinking` override on purpose. Adding providers to
  // `trustedProviders` would drop better-auth's requirement that the *incoming*
  // IdP asserted email_verified (see dist/oauth2/link-account.mjs) — an attacker
  // who can self-register an unverified account at any configured IdP under a
  // victim's address could then link into that victim's account. Here user.id is
  // the per-user PostgreSQL schema key, so that is a data breach. The defaults
  // require both sides to be verified; leave them alone.
  // Consequences: password sign-ups stay emailVerified=false, so an SSO login for an
  // existing password account is REFUSED (error=account_not_linked), not merged. For
  // Microsoft and password sign-ups emailVerified is usually false, so the first-admin
  // bootstrap (authz/bootstrap.ts) is evaluated per provider, not on emailVerified.
  plugins: [
    ...(oidc
      ? [
          genericOAuth({
            config: [
              {
                providerId: oidc.providerId,
                clientId: oidc.clientId,
                clientSecret: oidc.clientSecret,
                discoveryUrl: oidc.discoveryUrl,
                scopes: ['openid', 'profile', 'email'],
                pkce: oidc.pkce,
              },
            ],
          }),
        ]
      : []),
    // nextCookies must be last so it can set cookies on the response.
    nextCookies(),
  ],
});

export type Auth = typeof auth;
