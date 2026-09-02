import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';
import { genericOAuth } from 'better-auth/plugins';
import { db } from '@/lib/db';
import { users, sessions, accounts, verifications } from '@/lib/db/schema';
import {
  emailPasswordEnabled,
  microsoftConfig,
  oidcConfig,
  warnDeprecatedAuthEnv,
} from './providers';

// Resolved in ./providers so the sign-in page renders exactly what is
// registered here.
const microsoft = microsoftConfig();
const oidc = oidcConfig();

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
  socialProviders: microsoft ? { microsoft } : {},
  // No `account.accountLinking` override on purpose. Adding providers to
  // `trustedProviders` would drop better-auth's requirement that the *incoming*
  // IdP asserted email_verified (see dist/oauth2/link-account.mjs) — an attacker
  // who can self-register an unverified account at any configured IdP under a
  // victim's address could then link into that victim's account. Here user.id is
  // the per-user PostgreSQL schema key, so that is a data breach. The defaults
  // require both sides to be verified; leave them alone.
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
