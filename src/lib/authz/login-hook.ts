// Runs after a better-auth session is created (databaseHooks.session.create.after).
// Contract: NEVER throws. A bug or outage here must not block or break login, so
// every step is isolated and logs only a step label and the error class.
import { createHmac } from 'node:crypto';
import { recordEvent } from '@/lib/audit/record';
import { asHeaderSource, clientIp, requestIdOf, userAgentOf, type HeaderSource } from '@/lib/audit/request-context';
import { CODE_RE } from '@/lib/audit/events/types';
import { maybeBootstrapAdmin } from './bootstrap';
import { enabledAuthProviders } from '@/lib/auth/providers';
import { accessSource } from './config';
import { matchDirectoryUser } from './directory-match';
import { captureExternalIdentity, type ExternalIdentity } from './identity';
import { errorLabel } from './pg-runner';

export async function runLoginHooks(userId: string): Promise<void> {
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
  if (accessSource() !== 'rollekatalog') return;
  for (const identity of identities) {
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    await Promise.race([
      work(),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, AUDIT_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    if (timedOut) console.warn(`[audit] ${label} timed out`);
  } catch (err) {
    console.error(`[authz] audit step failed: ${label} (${errorLabel(err)})`);
  } finally {
    if (timer) clearTimeout(timer);
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

export type LoginMethod = 'password' | 'oidc' | 'microsoft' | 'unknown';

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

export interface LoginSession {
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

/**
 * Fixed-window counter per key with a hard cap on tracked keys, so an attacker
 * rotating source addresses cannot grow memory. In-memory and per process:
 * with several app instances the effective limit is per instance.
 */
export function createThrottle(opts: { limit: number; windowMs: number; maxKeys: number; now?: () => number }) {
  const now = opts.now ?? Date.now;
  const windows = new Map<string, { start: number; count: number }>();
  return {
    /** True when this event may be recorded; false once the key is over its limit for the window. */
    allow(key: string): boolean {
      const t = now();
      const w = windows.get(key);
      if (w && t - w.start < opts.windowMs) {
        w.count += 1;
        return w.count <= opts.limit;
      }
      windows.delete(key);
      if (windows.size >= opts.maxKeys) {
        for (const [k, v] of windows) if (t - v.start >= opts.windowMs) windows.delete(k);
        // Still full of live windows: evict the oldest (Map keeps insertion order).
        while (windows.size >= opts.maxKeys) {
          const oldest = windows.keys().next();
          if (oldest.done) break;
          windows.delete(oldest.value);
        }
      }
      windows.set(key, { start: t, count: 1 });
      return true;
    },
    size: () => windows.size,
  };
}

const failureThrottle = createThrottle({ limit: 20, windowMs: 60_000, maxKeys: 10_000 });

/** Shared per-IP budget for login_failed events (20 per minute). Events without an IP share one bucket. */
export const allowLoginFailureEvent = (ip: string | null): boolean => failureThrottle.allow(ip ?? 'no-ip');

type FailedReason = 'invalid_credentials' | 'oauth_error' | 'account_not_linked' | 'rate_limited' | 'unknown';

export interface AuthFailure {
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
  if (ctx.path === '/callback/:id' || ctx.path === '/oauth2/callback/:providerId') {
    const location = locationOf(ctx);
    if (!location) return null;
    let error: string | null;
    try {
      error = new URL(location, 'http://localhost').searchParams.get('error');
    } catch {
      return null;
    }
    if (!error) return null;
    return { reason: error === 'account_not_linked' ? 'account_not_linked' : 'oauth_error', method, provider };
  }
  return null;
}

/** auth.login_failed: no actor (the attempt has no session), throttled per IP. */
export async function auditAuthFailure(ctx: AuthHookContext | null | undefined): Promise<void> {
  try {
    // Cheap path filter first: this hook sees every better-auth request.
    if (ctx?.path !== '/sign-in/email' && ctx?.path !== '/callback/:id' && ctx?.path !== '/oauth2/callback/:providerId') return;
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
