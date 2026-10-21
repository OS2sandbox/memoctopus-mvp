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
  runLoginHooks,
  runSamlLoginHooks,
  type AuthHookContext,
} from '@/lib/authz/login-hook';
import { accessSource, requireRoleToLogin, roleClaimsMaxSeconds } from '@/lib/authz/config';
import { users, sessions, accounts, verifications } from '@/lib/db/schema';
import {
  authRolesConfig,
  emailPasswordEnabled,
  emailPasswordSignUpDisabled,
  microsoftConfig,
  microsoftGraphScopes,
  microsoftSingleTenant,
  oidcProviders,
  samlProviders,
  warnDeprecatedAuthEnv,
} from './providers';
import { authIpHeaders } from './ip-headers';
import { entraSocialConfig, genericOAuthConfigFor } from './oidc-config';
import { SSO_DISABLED_PATHS, ssoPluginOptions } from './saml';
import { samlBeforeHook } from './saml-guard';

// Resolved in ./providers so the sign-in page renders exactly what is
// registered here.
const microsoft = microsoftConfig();
const oidc = oidcProviders();
const graphScopes = microsoftGraphScopes();
const samlConfigured = samlProviders();
const ssoOptions = ssoPluginOptions(samlConfigured, runSamlLoginHooks);
// Only the providers the plugin actually got (one without a usable SP entity id is skipped there).
const samlList = samlConfigured.filter((p) => ssoOptions?.defaultSSO?.some((d) => d.providerId === p.id));
const ipAddressHeaders = authIpHeaders();

warnDeprecatedAuthEnv();

// Start-up warnings about risky combinations. All content-free (no claim names, values or secrets), once.
function warnRiskyConfig(): void {
  let mode: ReturnType<typeof accessSource>;
  try {
    mode = accessSource();
  } catch {
    // An invalid ACCESS_SOURCE is reported (503) by the request guards; startup stays alive.
    return;
  }
  if (mode === 'local' && process.env.NODE_ENV === 'production') {
    console.warn(
      '[auth] ACCESS_SOURCE=local in production: the in-app role admin and the first-administrator bootstrap are active. ' +
        'Municipal installations should use claims or rollekatalog (local mode is for development and demos).',
    );
  }
  const roles = authRolesConfig();
  if (mode !== 'claims' && roles.state !== 'unset') {
    console.warn(`[auth] The config file has a "roles" section but ACCESS_SOURCE is not claims: it is ignored.`);
  }
  if (mode !== 'claims') return;
  // A deployment that reads roles from claims but has no usable role mapping would silently give
  // everybody the baseline: say so once at start.
  if (roles.state !== 'ok') {
    console.warn(
      `[auth] ACCESS_SOURCE=claims but the config file has ${roles.state === 'unset' ? 'no' : 'an invalid'} "roles" section: nobody will get a role from claims.`,
    );
  }
  if (!requireRoleToLogin()) {
    console.warn('[auth] ACCESS_SOURCE=claims with REQUIRE_ROLE_TO_LOGIN=false: a person the IdP maps to no role still gets the baseline role.');
  }
}
warnRiskyConfig();

// In claims mode the roles of a login are a snapshot that expires (ROLE_CLAIMS_MAX_SECONDS), so
// a session must not outlive it: it then ends and the next sign-in refreshes the roles. updateAge
// equal to expiresIn means the session is never silently extended (disableSessionRefresh makes that explicit:
// better-auth's own refresh on activity would otherwise push the expiry past the role snapshot).
function claimsSession(): { session: { expiresIn: number; updateAge: number; disableSessionRefresh: true } } | Record<string, never> {
  try {
    if (accessSource() !== 'claims') return {};
  } catch {
    return {};
  }
  const seconds = roleClaimsMaxSeconds();
  return { session: { expiresIn: seconds, updateAge: seconds, disableSessionRefresh: true } };
}

// Microsoft Entra, as registered with better-auth: the hardened base config of ./oidc-config.ts plus what the
// Teams/Graph integration needs on top of it.
//
// overrideUserInfoOnSignIn keeps the stored name and email in step with Entra on every sign-in. Without it
// better-auth writes them once, at account creation, and never again: it matches the account on the provider's
// subject claim, so a user whose mail attribute or display name later changes keeps the address they first
// signed up with (an account created under one address kept showing it after the user moved to another
// mailbox, which reads as being logged in as the wrong person). Only for one named tenant: there the tenant
// admin controls the `email` claim. Under the multi-tenant authorities (blank, common, organizations,
// consumers) it comes from whichever tenant the user signs in from, and Entra does not guarantee it is
// verified or unchanged, so it must not overwrite what we store.
//
// The Teams integration reads Graph as the signed-in user (delegated), so the Graph scopes must be consented
// to at login, but only when TEAMS_GRAPH_ENABLED is set: two of them need tenant-admin consent, and a tenant
// that has not granted it rejects the whole sign-in. With the flag off the scopes are exactly those of
// entraSocialConfig (no User.Read, no offline_access, nothing from Graph). With it on, User.Read and
// offline_access are added too: offline_access is what yields the refresh token that auth.api.getAccessToken()
// later trades for a fresh access token, and scrubAccountTokens (authz/login-hook.ts) leaves the Microsoft
// access/refresh token in place in that case only. Users who signed in before these scopes existed keep a token
// without them; hasGraphScopes() in src/lib/teams/graph-client.ts detects that and the UI asks them to sign in
// again.
function microsoftSocial(m: NonNullable<typeof microsoft>) {
  const base = entraSocialConfig(m);
  return {
    ...base,
    ...(microsoftSingleTenant() && { overrideUserInfoOnSignIn: true }),
    ...(graphScopes.length > 0 && {
      scope: [...new Set([...base.scope, 'User.Read', 'offline_access', ...graphScopes])],
    }),
  };
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
    // Claims mode: enabled is false there (providers.ts) and sign-up is closed as well.
    ...(emailPasswordSignUpDisabled() ? { disableSignUp: true } : {}),
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
    },
  },
  // Failed sign-ins have no session, so they cannot come from databaseHooks.
  // Returns nothing: it must never change the response.
  hooks: {
    // Unknown sso provider ids are a plain 404 (the plugin would otherwise query a provider table
    // that does not exist here), and a SAML response must pass the audience / recipient / request
    // checks of saml-guard.ts before the plugin sees it.
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
  // Entra: one tenant, audience / issuer / tenant checked before the login is built (see
  // entraSocialConfig). Scopes are explicit and minimal (no offline_access, no Graph) unless the Teams/Graph
  // integration is on, see microsoftSocial() above.
  socialProviders: microsoft ? { microsoft: microsoftSocial(microsoft) } : {},
  // OAuth access and refresh tokens are encrypted at rest with BETTER_AUTH_SECRET. Once
  // Teams is enabled the refresh token gives about 90 days of offline access to meeting
  // transcripts and recordings, so a database dump or backup must not hand it out. Rows
  // written before this stay readable: better-auth returns a token that does not look
  // encrypted unchanged and encrypts it the next time the account is written (a sign-in
  // or a token refresh). Rotating BETTER_AUTH_SECRET makes the stored tokens undecryptable;
  // the affected users then sign in again.
  account: { encryptOAuthTokens: true },
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
