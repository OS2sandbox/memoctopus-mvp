// Runs after a better-auth session is created (databaseHooks.session.create.after).
// Contract: NEVER throws. A bug or outage here must not block or break login, so
// every step is isolated and logs only a step label and the error class.
import { createHmac } from 'node:crypto';
import { recordEvent } from '@/lib/audit/record';
import { asHeaderSource, clientIp, requestIdOf, userAgentOf, type HeaderSource } from '@/lib/audit/request-context';
import { CODE_RE } from '@/lib/audit/events/types';
import { createThrottle } from '@/lib/audit/throttle';
import { withTimeout } from '@/lib/audit/with-timeout';
import { maybeBootstrapAdmin } from './bootstrap';
import { enabledAuthProviders } from '@/lib/auth/providers';
import { applyClaimsLoginSafely, clearClaimsRoles } from './claims-roles';
import { takeLoginClaims } from './claims-stash';
import { accessSource, singleTenantId } from './config';
import { matchDirectoryUser } from './directory-match';
import { captureExternalIdentity, captureIdentityFromAttributes, type ExternalIdentity } from './identity';
import { defaultRunner, errorLabel, type SqlRunner } from './pg-runner';

/** The sign-in routes of the better-auth sso plugin that complete a SAML login (route templates). */
const SAML_LOGIN_PATHS = new Set(['/sso/saml2/callback/:providerId', '/sso/saml2/sp/acs/:providerId']);

export async function runLoginHooks(userId: string, ctx?: AuthHookContext | null): Promise<void> {
  try {
    await runLoginSteps(userId, ctx);
  } finally {
    // Whatever the steps did: no provider token stays in the database (never throws).
    await scrubAccountTokens(userId);
  }
}

/**
 * Nothing in this app uses an access or refresh token after the login (no Graph or userinfo call is made later, no
 * refresh), and the id token's claims have been captured into the whitelisted snapshot. Keeping them would put a
 * credential for the person's account at the IdP into every database backup, so they are removed as soon as the
 * login hooks have read them (better-auth rewrites them at the next login). Never throws.
 */
export async function scrubAccountTokens(userId: string, runner: SqlRunner = defaultRunner()): Promise<void> {
  try {
    await runner.query(
      `UPDATE public.accounts
          SET id_token = NULL, access_token = NULL, refresh_token = NULL,
              access_token_expires_at = NULL, refresh_token_expires_at = NULL
        WHERE user_id = $1 AND provider_id <> 'credential'
          AND (id_token IS NOT NULL OR access_token IS NOT NULL OR refresh_token IS NOT NULL)`,
      [userId],
    );
  } catch (err) {
    console.error(`[authz] login step failed: scrub_tokens (${errorLabel(err)})`);
  }
}

async function runLoginSteps(userId: string, ctx?: AuthHookContext | null): Promise<void> {
  const { method, provider } = authMethodOf(ctx);
  // SAML: the assertion's attributes only reach us in the sso plugin's provisionUser callback,
  // which runs right after the session is created. runSamlLoginHooks does ALL the work there
  // (identity capture, first-administrator bootstrap, claims or directory match).
  if (method === 'saml') return;

  let identities: ExternalIdentity[] = [];

  try {
    identities = await captureExternalIdentity(userId);
  } catch (err) {
    console.error(`[authz] login step failed: capture_identity (${errorLabel(err)})`);
  }

  try {
    await maybeBootstrapAdmin(userId);
  } catch (err) {
    console.error(`[authz] login step failed: bootstrap_admin (${errorLabel(err)})`);
  }

  // Local mode links roles to app users directly; claims are never used there.
  // An invalid ACCESS_SOURCE throws ConfigError: log it and skip the match (this hook never throws).
  let mode: ReturnType<typeof accessSource>;
  try {
    mode = accessSource();
  } catch (err) {
    console.error(`[authz] login step failed: access_source (${errorLabel(err)})`);
    return;
  }
  if (mode === 'claims') {
    await applyOidcLoginClaims(userId, method, provider);
    return;
  }
  if (mode !== 'rollekatalog') return;
  for (const identity of identities) {
    try {
      await matchDirectoryUser(identity);
    } catch (err) {
      console.error(`[authz] login step failed: match_directory_user (${errorLabel(err)})`);
    }
  }
}

/**
 * ACCESS_SOURCE=claims, OIDC / Entra: the role claims of THIS login, exactly as the provider mapper saw them
 * (id token + userinfo, after the audience / issuer / tenant checks), handed over in memory. There is no
 * fallback to a stored id token (none is kept, and a stash miss means something went wrong): then the person
 * holds no claim roles. A session that did not come from an IdP (password sign-in) carries no claims either, so
 * it must not keep roles an earlier SSO login wrote: they are cleared. For Entra the tenant is checked once more
 * here. Never throws.
 */
async function applyOidcLoginClaims(userId: string, method: LoginMethod, provider: string): Promise<void> {
  try {
    if (method !== 'oidc' && method !== 'microsoft') {
      await clearClaimsRoles(userId);
      return;
    }
    const res = await defaultRunner().query<{ account_id: string }>(
      'SELECT account_id FROM public.accounts WHERE user_id = $1 AND provider_id = $2 LIMIT 1',
      [userId, provider],
    );
    const account = res.rows[0];
    let claims = account ? takeLoginClaims(provider, account.account_id) : null;
    if (claims && method === 'microsoft') {
      // Only ever one tenant in claims mode: a token of another tenant (or one without `tid`) grants nothing.
      const tenant = singleTenantId();
      const tid = typeof claims.tid === 'string' ? claims.tid.trim().toLowerCase() : null;
      if (tenant === null || tid !== tenant) {
        console.warn('[authz] claims refused: the Microsoft login is not from the configured tenant');
        claims = null;
      }
    }
    await applyClaimsLoginSafely({ userId, providerId: provider, claims });
  } catch (err) {
    console.error(`[authz] login step failed: claims_roles (${errorLabel(err)})`);
    try {
      await clearClaimsRoles(userId);
    } catch (clearErr) {
      console.error(`[authz] login step failed: clear_claims (${errorLabel(clearErr)})`);
    }
  }
}

/**
 * Everything runLoginHooks does for an OIDC login, for a SAML login: called from the sso
 * plugin's provisionUser (provisionUserOnEveryLogin) with the mapped assertion attributes,
 * i.e. after the session exists but before the response is sent. Never throws.
 */
export async function runSamlLoginHooks(
  userId: string,
  providerId: string,
  userInfo: Record<string, unknown>,
): Promise<void> {
  let identity: ExternalIdentity | null = null;
  try {
    identity = await captureIdentityFromAttributes(userId, providerId, userInfo);
  } catch (err) {
    console.error(`[authz] login step failed: capture_identity (${errorLabel(err)})`);
  }

  // The same first-administrator path as an OIDC login. A SAML identity only qualifies where
  // identityQualifies says so (the plugin never asserts email_verified, so in practice it does not:
  // bootstrapping the first administrator needs an OIDC / Entra login).
  try {
    await maybeBootstrapAdmin(userId);
  } catch (err) {
    console.error(`[authz] login step failed: bootstrap_admin (${errorLabel(err)})`);
  }

  let mode: ReturnType<typeof accessSource>;
  try {
    mode = accessSource();
  } catch (err) {
    console.error(`[authz] login step failed: access_source (${errorLabel(err)})`);
    return;
  }
  if (mode === 'claims') {
    await applyClaimsLoginSafely({ userId, providerId, claims: userInfo });
  } else if (mode === 'rollekatalog' && identity) {
    try {
      await matchDirectoryUser(identity);
    } catch (err) {
      console.error(`[authz] login step failed: match_directory_user (${errorLabel(err)})`);
    }
  }
}

// ─── Audit events for login / logout / failed login ──────────────────────────
// Same contract as above: NEVER throws and never waits long. An audit failure or
// a hung database must not block, delay materially or alter a login, so every
// write goes through bestEffort(). Details are enums and short codes only: never
// the email, the session token, or any provider error text.

const AUDIT_TIMEOUT_MS = 2000;

async function bestEffort(label: string, work: () => Promise<unknown>): Promise<void> {
  try {
    if (await withTimeout(work(), AUDIT_TIMEOUT_MS)) console.warn(`[audit] ${label} timed out`);
  } catch (err) {
    console.error(`[authz] audit step failed: ${label} (${errorLabel(err)})`);
  }
}

/** The slice of better-auth's endpoint context these helpers read. */
export interface AuthHookContext {
  path?: string;
  params?: Record<string, unknown> | null;
  headers?: unknown;
  request?: { headers?: unknown } | null;
  body?: unknown;
  context?: { returned?: unknown; responseHeaders?: unknown } | null;
}

type LoginMethod = 'password' | 'oidc' | 'microsoft' | 'saml' | 'unknown';

// The provider id comes from the URL path of an unauthenticated request, so it is
// only stored when it names a provider that is actually configured; anything else
// is attacker-chosen text and becomes 'unknown'.
const asProvider = (v: unknown): string => {
  if (typeof v !== 'string' || !CODE_RE.test(v)) return 'unknown';
  return enabledAuthProviders().some((p) => p.id === v) ? v : 'unknown';
};

/** Which sign-in route a hook context belongs to. `path` is the route template (e.g. `/callback/:id`). */
export function authMethodOf(ctx: AuthHookContext | null | undefined): { method: LoginMethod; provider: string } {
  switch (ctx?.path) {
    case '/sign-in/email':
    case '/sign-up/email':
      return { method: 'password', provider: 'password' };
    case '/oauth2/callback/:providerId':
      return { method: 'oidc', provider: asProvider(ctx.params?.providerId) };
    case '/sso/saml2/callback/:providerId':
    case '/sso/saml2/sp/acs/:providerId':
      return { method: 'saml', provider: asProvider(ctx.params?.providerId) };
    case '/callback/:id': {
      const provider = asProvider(ctx.params?.id);
      return { method: provider === 'microsoft' ? 'microsoft' : 'unknown', provider };
    }
    default:
      return { method: 'unknown', provider: 'unknown' };
  }
}

function headersOf(ctx: AuthHookContext | null | undefined): HeaderSource | null {
  return asHeaderSource({ headers: ctx?.headers ?? ctx?.request?.headers });
}

interface LoginSession {
  userId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** auth.login: call after runLoginHooks so the actor snapshot sees a freshly linked org unit. */
export async function auditLogin(session: LoginSession, ctx: AuthHookContext | null): Promise<void> {
  await bestEffort('audit_login', async () => {
    const headers = headersOf(ctx);
    const { method, provider } = authMethodOf(ctx);
    await recordEvent({
      type: 'auth.login',
      actorUserId: session.userId,
      details: { method, provider },
    }, {
      // The session row already holds what better-auth resolved from the proxy headers.
      context: {
        ip: session.ipAddress ?? (headers ? clientIp(headers) : null),
        userAgent: session.userAgent ?? (headers ? userAgentOf(headers) : null),
        requestId: headers ? requestIdOf(headers) : undefined,
      },
    });
  });
}

/** auth.logout: only an explicit sign-out; the delete hook also fires for expiry cleanup and revocation. */
export async function auditLogout(session: LoginSession, ctx: AuthHookContext | null): Promise<void> {
  if (ctx?.path !== '/sign-out') return;
  await bestEffort('audit_logout', async () => {
    const headers = headersOf(ctx);
    await recordEvent({ type: 'auth.logout', actorUserId: session.userId }, {
      context: {
        ip: (headers ? clientIp(headers) : null) ?? session.ipAddress,
        userAgent: (headers ? userAgentOf(headers) : null) ?? session.userAgent,
        requestId: headers ? requestIdOf(headers) : undefined,
      },
    });
  });
}

// ─── login_failed ────────────────────────────────────────────────────────────

/** Stored one by one per IP and minute; beyond it the failures are counted into summary rows. */
export const LOGIN_FAILURE_LIMIT_PER_MINUTE = 60;
/** Across ALL addresses: a flood from many addresses (or a spoofed forwarding header) cannot fill the log either. */
export const LOGIN_FAILURE_GLOBAL_LIMIT_PER_MINUTE = 300;
/** A burst is also summarised when this many of its failures have been dropped, so a long flood is on record early. */
const SUMMARY_AT = [100, 1000, 10_000];
const NO_IP = 'no-ip';

/** One auth.login_failed row for a burst: how many further failures were not stored one by one (an address, or all of them). */
async function recordFailureSummary(ip: string | null, dropped: number): Promise<void> {
  await bestEffort('audit_login_failed_summary', async () => {
    await recordEvent({
      type: 'auth.login_failed',
      details: { reason: 'burst_summary', droppedCount: dropped },
    }, { context: { ip } });
  });
}

const failureThrottle = createThrottle({
  limit: LOGIN_FAILURE_LIMIT_PER_MINUTE,
  windowMs: 60_000,
  maxKeys: 10_000,
  summaryAt: SUMMARY_AT,
  onSummary: (ip, dropped) => void recordFailureSummary(ip === NO_IP ? null : ip, dropped),
});

const GLOBAL_KEY = 'all';
const globalFailureThrottle = createThrottle({
  limit: LOGIN_FAILURE_GLOBAL_LIMIT_PER_MINUTE,
  windowMs: 60_000,
  maxKeys: 1,
  summaryAt: SUMMARY_AT,
  // A summary with no address: the excess of the global cap, whoever it came from.
  onSummary: (_key, dropped) => void recordFailureSummary(null, dropped),
});

/**
 * Budget for individually stored login_failed events: per IP and minute, then across all addresses. Events
 * without an IP share one per-IP bucket. Whatever is over either cap is counted into a summary, never lost silently.
 */
export const allowLoginFailureEvent = (ip: string | null): boolean =>
  failureThrottle.allow(ip ?? NO_IP) && globalFailureThrottle.allow(GLOBAL_KEY);

/** Test only. */
export function resetLoginFailureThrottles(): void {
  failureThrottle.reset();
  globalFailureThrottle.reset();
}

type FailedReason = 'invalid_credentials' | 'oauth_error' | 'account_not_linked' | 'rate_limited' | 'unknown';

interface AuthFailure {
  reason: FailedReason;
  method: LoginMethod;
  provider: string;
  emailHmac?: string;
}

/** First 16 hex chars of HMAC-SHA256(BETTER_AUTH_SECRET, lower-cased email); null without a secret. */
export function emailHmac(email: unknown): string | null {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || typeof email !== 'string' || email.length === 0 || email.length > 320) return null;
  return createHmac('sha256', secret).update(email.trim().toLowerCase()).digest('hex').slice(0, 16);
}

function statusOf(returned: unknown): number | null {
  const s = (returned as { statusCode?: unknown } | null)?.statusCode;
  return typeof s === 'number' ? s : null;
}

function locationOf(ctx: AuthHookContext): string | null {
  const fromHeaders = (h: unknown) => (h as { get?: (n: string) => string | null } | null)?.get?.('location') ?? null;
  const returned = ctx.context?.returned as { headers?: unknown } | null | undefined;
  return fromHeaders(ctx.context?.responseHeaders) ?? fromHeaders(returned?.headers);
}

/**
 * Turns a finished better-auth request into a failure description, or null when
 * the request was not a failed sign-in. Password: /sign-in/email answered with an
 * error status. OAuth: callbacks answer success AND failure with a redirect, so a
 * failure is an `error` query parameter on the redirect location. Only the
 * allow-listed `account_not_linked` is distinguished: the rest of the provider's
 * error value is attacker-influenced text and is never stored.
 */
export function classifyAuthFailure(ctx: AuthHookContext | null | undefined): AuthFailure | null {
  if (!ctx) return null;
  const { method, provider } = authMethodOf(ctx);
  if (ctx.path === '/sign-in/email') {
    const status = statusOf(ctx.context?.returned);
    if (status === null || status < 400) return null;
    const reason: FailedReason = status === 429 ? 'rate_limited' : status === 401 ? 'invalid_credentials' : 'unknown';
    const hmac = emailHmac((ctx.body as { email?: unknown } | null | undefined)?.email);
    return { reason, method, provider, ...(hmac ? { emailHmac: hmac } : {}) };
  }
  if (ctx.path && SAML_LOGIN_PATHS.has(ctx.path)) {
    // The ACS answers success AND most failures with a redirect (?error=...); a few failures are
    // thrown as a 4xx instead. Neither carries anything but a short code, and none is stored.
    const location = locationOf(ctx);
    if (!location) {
      const status = statusOf(ctx.context?.returned);
      return status !== null && status >= 400 ? { reason: 'oauth_error', method, provider } : null;
    }
    return failureFromLocation(location, method, provider);
  }
  if (ctx.path === '/callback/:id' || ctx.path === '/oauth2/callback/:providerId') {
    const location = locationOf(ctx);
    if (!location) return null;
    return failureFromLocation(location, method, provider);
  }
  return null;
}

function failureFromLocation(location: string, method: LoginMethod, provider: string): AuthFailure | null {
  let error: string | null;
  try {
    error = new URL(location, 'http://localhost').searchParams.get('error');
  } catch {
    return null;
  }
  if (!error) return null;
  return { reason: error === 'account_not_linked' ? 'account_not_linked' : 'oauth_error', method, provider };
}

/** auth.login_failed: no actor (the attempt has no session). Capped per IP, with the excess counted in a summary row. */
export async function auditAuthFailure(ctx: AuthHookContext | null | undefined): Promise<void> {
  try {
    // Cheap path filter first: this hook sees every better-auth request.
    if (
      ctx?.path !== '/sign-in/email' &&
      ctx?.path !== '/callback/:id' &&
      ctx?.path !== '/oauth2/callback/:providerId' &&
      !(ctx?.path && SAML_LOGIN_PATHS.has(ctx.path))
    ) {
      return;
    }
    const failure = classifyAuthFailure(ctx);
    if (!failure) return;
    const headers = headersOf(ctx);
    const ip = headers ? clientIp(headers) : null;
    if (!allowLoginFailureEvent(ip)) return;
    await bestEffort('audit_login_failed', async () => {
      await recordEvent({
        type: 'auth.login_failed',
        details: failure,
      }, {
        context: {
          ip,
          userAgent: headers ? userAgentOf(headers) : null,
          requestId: headers ? requestIdOf(headers) : undefined,
        },
      });
    });
  } catch (err) {
    console.error(`[authz] audit step failed: audit_login_failed (${errorLabel(err)})`);
  }
}
