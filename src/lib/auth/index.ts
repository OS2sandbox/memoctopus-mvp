import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';
import { createAuthMiddleware } from 'better-auth/api';
import { genericOAuth } from 'better-auth/plugins';
import { sso } from '@better-auth/sso';
import { db } from '@/lib/db';
import {
  auditAuthFailure,
  auditLogin,
  auditLogout,
  runLoginHooks,
  runSamlLoginHooks,
  type AuthHookContext,
} from '@/lib/authz/login-hook';
import { accessSource, roleClaimsMaxSeconds } from '@/lib/authz/config';
import { users, sessions, accounts, verifications } from '@/lib/db/schema';
import {
  authRolesConfig,
  emailPasswordEnabled,
  microsoftConfig,
  oidcProviders,
  samlProviders,
  warnDeprecatedAuthEnv,
} from './providers';
import { authIpHeaders } from './ip-headers';
import { genericOAuthConfigFor } from './oidc-config';
import { SSO_DISABLED_PATHS, ssoPluginOptions } from './saml';
import { samlBeforeHook } from './saml-guard';

// Resolved in ./providers so the sign-in page renders exactly what is
// registered here.
const microsoft = microsoftConfig();
const oidc = oidcProviders();
const samlConfigured = samlProviders();
const ssoOptions = ssoPluginOptions(samlConfigured, {
  onLogin: runSamlLoginHooks,
});
// Only the providers the plugin actually got (one without a usable SP entity id is skipped there).
const samlList = samlConfigured.filter((p) => ssoOptions?.defaultSSO?.some((d) => d.providerId === p.id));
const ipAddressHeaders = authIpHeaders();

warnDeprecatedAuthEnv();

// A deployment that reads roles from claims but has no usable role mapping would silently give
// everybody the baseline: say so once at start. Content-free (no claim names or values).
function warnClaimsMode(): void {
  try {
    if (accessSource() !== 'claims') return;
    const roles = authRolesConfig();
    if (roles.state !== 'ok') {
      console.warn(
        `[auth] ACCESS_SOURCE=claims but the config file has ${roles.state === 'unset' ? 'no' : 'an invalid'} "roles" section: nobody will get a role from claims.`,
      );
    }
  } catch {
    // An invalid ACCESS_SOURCE is reported (503) by the request guards; startup stays alive.
  }
}
warnClaimsMode();

// In claims mode the roles of a login are a snapshot that expires (ROLE_CLAIMS_MAX_SECONDS), so
// a session must not outlive it: it then ends and the next sign-in refreshes the roles. updateAge
// equal to expiresIn means the session is never silently extended.
function claimsSession(): { session: { expiresIn: number; updateAge: number } } | Record<string, never> {
  try {
    if (accessSource() !== 'claims') return {};
  } catch {
    return {};
  }
  const seconds = roleClaimsMaxSeconds();
  return { session: { expiresIn: seconds, updateAge: seconds } };
}

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
  ...claimsSession(),
  // The sso plugin can also manage identity providers in a database table; this app configures
  // them in AUTH_CONFIG_FILE only, so those endpoints must not exist.
  ...(ssoOptions ? { disabledPaths: SSO_DISABLED_PATHS } : {}),
  ...(ipAddressHeaders ? { advanced: { ipAddress: { ipAddressHeaders } } } : {}),
  // Identity capture / first-admin bootstrap / directory link. Fires after the
  // session row is committed; runLoginHooks never throws, so it cannot block a
  // login. No session.cookieCache: roles are resolved live per request.
  // The audit* helpers share that contract (never throw, bounded wait).
  databaseHooks: {
    session: {
      create: {
        after: async (session, ctx) => {
          await runLoginHooks(session.userId, ctx as AuthHookContext | null);
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
    // An sso request for a provider that is not configured is a plain 404 (the plugin would
    // otherwise query a provider table that does not exist here).
    // Unknown sso provider ids are a plain 404, and a SAML response must pass the audience /
    // recipient / request checks of saml-guard.ts before the plugin sees it.
    ...(ssoOptions
      ? {
          before: samlBeforeHook(samlList, {
            // The refusal happens before better-auth's `after` hooks can see the request: report it as a failed login.
            onRefused: (ctx) => {
              const c = ctx as AuthHookContext & { request?: { headers?: unknown } | null };
              return auditAuthFailure({
                path: c.path,
                params: c.params,
                headers: c.headers ?? c.request?.headers,
                context: { returned: { statusCode: 400 } },
              });
            },
          }),
        }
      : {}),
    after: createAuthMiddleware(async (ctx) => {
      await auditAuthFailure(ctx as unknown as AuthHookContext);
    }),
  },
  socialProviders: microsoft
    ? {
        microsoft: {
          clientId: microsoft.clientId,
          clientSecret: microsoft.clientSecret,
          tenantId: microsoft.tenantId,
          ...(microsoft.scopes ? { scope: microsoft.scopes } : {}),
        },
      }
    : {},
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
    ...(oidc.length > 0 ? [genericOAuth({ config: oidc.map(genericOAuthConfigFor) })] : []),
    ...(ssoOptions ? [sso(ssoOptions)] : []),
    // nextCookies must be last so it can set cookies on the response.
    nextCookies(),
  ],
});

export type Auth = typeof auth;
