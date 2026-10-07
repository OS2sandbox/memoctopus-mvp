import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ pool: {} }));
const capture = vi.fn();
const bootstrap = vi.fn();
const match = vi.fn();
vi.mock('./identity', () => ({ captureExternalIdentity: (...a: unknown[]) => capture(...a) }));
vi.mock('./bootstrap', () => ({ maybeBootstrapAdmin: (...a: unknown[]) => bootstrap(...a) }));
vi.mock('./directory-match', () => ({ matchDirectoryUser: (...a: unknown[]) => match(...a) }));
const recordEvent = vi.fn();
vi.mock('@/lib/audit/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit/record')>()),
  recordEvent: (...a: unknown[]) => recordEvent(...a),
}));

import {
  allowLoginFailureEvent,
  auditAuthFailure,
  auditLogin,
  auditLogout,
  authMethodOf,
  classifyAuthFailure,
  createThrottle,
  emailHmac,
  LOGIN_FAILURE_LIMIT_PER_MINUTE,
  runLoginHooks,
} from './login-hook';
import { createHmac } from 'node:crypto';
import { EVENT_CATALOGUE } from '@/lib/audit/events';
import { checkDetailsShape, validateEvent } from '@/lib/audit/record';

const ID = { userId: 'u1', providerId: 'oidc', subject: 's', claims: { sub: 's', email: 'secret@example.dk' } };

beforeEach(() => {
  vi.stubEnv('ACCESS_SOURCE', 'local');
  // Configured sign-in providers: the only provider ids the audit log will record.
  vi.stubEnv('MICROSOFT_CLIENT_ID', 'ms-id');
  vi.stubEnv('MICROSOFT_CLIENT_SECRET', 'ms-secret');
  vi.stubEnv('OIDC_CLIENT_ID', 'oidc-id');
  vi.stubEnv('OIDC_CLIENT_SECRET', 'oidc-secret');
  vi.stubEnv('OIDC_DISCOVERY_URL', 'https://idp.example/.well-known/openid-configuration');
  vi.stubEnv('OIDC_PROVIDER_ID', 'keycloak');
  capture.mockReset().mockResolvedValue([ID]);
  bootstrap.mockReset().mockResolvedValue({ granted: false, reason: 'no_allowlist' });
  match.mockReset().mockResolvedValue({ status: 'linked' });
  recordEvent.mockReset().mockResolvedValue({ status: 'stored' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('runLoginHooks', () => {
  it('runs capture then bootstrap, and no matching in local mode', async () => {
    await runLoginHooks('u1');
    expect(capture).toHaveBeenCalledWith('u1');
    expect(bootstrap).toHaveBeenCalledWith('u1');
    expect(match).not.toHaveBeenCalled();
  });

  it('matches every captured identity in rollekatalog mode', async () => {
    vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
    await runLoginHooks('u1');
    expect(match).toHaveBeenCalledWith(ID);
  });

  it('never throws and still runs later steps when each step fails', async () => {
    vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
    capture.mockRejectedValue(new Error('db down: secret@example.dk'));
    bootstrap.mockRejectedValue(Object.assign(new TypeError('x secret@example.dk'), { code: '08006' }));
    await expect(runLoginHooks('u1')).resolves.toBeUndefined();
    expect(bootstrap).toHaveBeenCalled();
    const logged = JSON.stringify((console.error as any).mock.calls);
    expect(logged).toContain('capture_identity');
    expect(logged).toContain('TypeError/08006');
    expect(logged).not.toContain('secret@example.dk');
  });

  it('never throws on an invalid ACCESS_SOURCE: logs the class only and skips matching', async () => {
    vi.stubEnv('ACCESS_SOURCE', 'rolekatalog');
    await expect(runLoginHooks('u1')).resolves.toBeUndefined();
    expect(capture).toHaveBeenCalled();
    expect(bootstrap).toHaveBeenCalled(); // bootstrap itself fails closed on the same ConfigError
    expect(match).not.toHaveBeenCalled();
    const logged = JSON.stringify((console.error as any).mock.calls);
    expect(logged).toContain('access_source (ConfigError)');
    expect(logged).not.toContain('rolekatalog');
  });

  it('matches AFTER capturing the identity', async () => {
    vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
    const order: string[] = [];
    capture.mockImplementation(async () => (order.push('capture'), [ID]));
    match.mockImplementation(async () => (order.push('match'), { status: 'linked' }));
    await runLoginHooks('u1');
    expect(order).toEqual(['capture', 'match']);
  });

  it('swallows matching errors', async () => {
    vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
    match.mockRejectedValue(new Error('boom'));
    await expect(runLoginHooks('u1')).resolves.toBeUndefined();
    expect(JSON.stringify((console.error as any).mock.calls)).toContain('match_directory_user');
  });
});

const SECRET = 'x'.repeat(40);
const apiError = (statusCode: number) => Object.assign(new Error('boom'), { statusCode });
const passwordCtx = (returned: unknown, email: unknown = 'Secret.Person@Example.dk', ip = '203.0.113.7') => ({
  path: '/sign-in/email',
  body: { email, password: 'hunter2-secret' },
  headers: new Headers({ 'x-forwarded-for': ip, 'user-agent': 'UA/1' }),
  context: { returned, responseHeaders: undefined },
});
const oauthCtx = (path: string, params: Record<string, string>, location: string | null, ip = '203.0.113.7') => ({
  path,
  params,
  headers: new Headers({ 'x-forwarded-for': ip }),
  context: { returned: apiError(302), responseHeaders: location ? new Headers({ location }) : new Headers() },
});

describe('authMethodOf', () => {
  it('derives method and provider from the route template', () => {
    expect(authMethodOf({ path: '/sign-in/email' })).toEqual({ method: 'password', provider: 'password' });
    expect(authMethodOf({ path: '/sign-up/email' })).toEqual({ method: 'password', provider: 'password' });
    expect(authMethodOf({ path: '/oauth2/callback/:providerId', params: { providerId: 'keycloak' } })).toEqual({ method: 'oidc', provider: 'keycloak' });
    expect(authMethodOf({ path: '/callback/:id', params: { id: 'microsoft' } })).toEqual({ method: 'microsoft', provider: 'microsoft' });
    expect(authMethodOf({ path: '/callback/:id', params: { id: 'github' } })).toEqual({ method: 'unknown', provider: 'unknown' });
  });
  it('only records configured provider ids: a well-formed but unconfigured id from the URL becomes unknown', () => {
    expect(authMethodOf({ path: '/callback/:id', params: { id: 'Some_Name.Here-0123456789' } }).provider).toBe('unknown');
    expect(authMethodOf({ path: '/oauth2/callback/:providerId', params: { providerId: 'oidc' } }).provider).toBe('unknown');
    vi.stubEnv('MICROSOFT_ENABLED', 'false');
    expect(authMethodOf({ path: '/callback/:id', params: { id: 'microsoft' } })).toEqual({ method: 'unknown', provider: 'unknown' });
  });
  it('falls back to unknown, and never passes a non-code provider through', () => {
    expect(authMethodOf(null)).toEqual({ method: 'unknown', provider: 'unknown' });
    expect(authMethodOf({ path: '/verify-email' })).toEqual({ method: 'unknown', provider: 'unknown' });
    expect(authMethodOf({ path: '/oauth2/callback/:providerId', params: { providerId: 'a provider name' } }).provider).toBe('unknown');
  });
});

describe('auditLogin', () => {
  const session = { userId: 'u1', token: 'session-token-secret', ipAddress: '198.51.100.4', userAgent: 'UA/9' } as any;

  it('records one auth.login with method/provider, the session ip/ua, and no token', async () => {
    await auditLogin(session, { path: '/oauth2/callback/:providerId', params: { providerId: 'keycloak' } });
    expect(recordEvent).toHaveBeenCalledTimes(1);
    const [event, opts] = recordEvent.mock.calls[0];
    expect(event).toEqual({ type: 'auth.login', actorUserId: 'u1', details: { method: 'oidc', provider: 'keycloak' } });
    expect(opts.context).toMatchObject({ ip: '198.51.100.4', userAgent: 'UA/9' });
    expect(JSON.stringify(recordEvent.mock.calls)).not.toContain('session-token-secret');
    expect(EVENT_CATALOGUE['auth.login'].details.safeParse(event.details).success).toBe(true);
    expect(checkDetailsShape(event.details)).toBeNull();
    expect(validateEvent(event).ok).toBe(true);
  });

  it('labels password and a null context', async () => {
    await auditLogin(session, { path: '/sign-in/email' });
    expect(recordEvent.mock.calls[0][0].details).toEqual({ method: 'password', provider: 'password' });
    recordEvent.mockClear();
    await auditLogin(session, null);
    expect(recordEvent.mock.calls[0][0].details).toEqual({ method: 'unknown', provider: 'unknown' });
  });

  it('resolves when the audit write rejects or throws', async () => {
    recordEvent.mockRejectedValue(new Error('db down: secret@example.dk'));
    await expect(auditLogin(session, null)).resolves.toBeUndefined();
    recordEvent.mockImplementation(() => {
      throw new Error('sync boom');
    });
    await expect(auditLogin(session, null)).resolves.toBeUndefined();
    expect(JSON.stringify((console.error as any).mock.calls)).not.toContain('secret@example.dk');
  });

  it('does not wait for a hung audit write', async () => {
    vi.useFakeTimers();
    try {
      recordEvent.mockReturnValue(new Promise(() => {}));
      const done = vi.fn();
      const p = auditLogin(session, null).then(done);
      await vi.advanceTimersByTimeAsync(1500);
      expect(done).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(600);
      await p;
      expect(done).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('auditLogout', () => {
  const session = { userId: 'u1', ipAddress: '198.51.100.4', userAgent: 'UA/9' };

  it('records auth.logout only for the /sign-out path', async () => {
    await auditLogout(session, { path: '/sign-out', headers: new Headers({ 'x-forwarded-for': '203.0.113.9' }) });
    expect(recordEvent).toHaveBeenCalledTimes(1);
    const [event, opts] = recordEvent.mock.calls[0];
    expect(event).toEqual({ type: 'auth.logout', actorUserId: 'u1' });
    expect(opts.context.ip).toBe('203.0.113.9');
  });

  it.each([[null], [{ path: '/revoke-session' }], [{ path: '/revoke-sessions' }], [{ path: '/reset-password' }]])(
    'ignores expiry cleanup and revocation (%j)',
    async (ctx) => {
      await auditLogout(session, ctx as any);
      expect(recordEvent).not.toHaveBeenCalled();
    },
  );

  it('resolves when the write fails', async () => {
    recordEvent.mockRejectedValue(new Error('x'));
    await expect(auditLogout(session, { path: '/sign-out' })).resolves.toBeUndefined();
  });
});

describe('emailHmac', () => {
  beforeEach(() => vi.stubEnv('BETTER_AUTH_SECRET', SECRET));

  it('is the first 16 hex chars of HMAC-SHA256 over the lower-cased email', () => {
    const expected = createHmac('sha256', SECRET).update('secret.person@example.dk').digest('hex').slice(0, 16);
    expect(emailHmac('  Secret.Person@Example.dk ')).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{16}$/);
  });
  it('is null without a secret or a usable email', () => {
    expect(emailHmac(undefined)).toBeNull();
    expect(emailHmac('')).toBeNull();
    expect(emailHmac(42)).toBeNull();
    vi.stubEnv('BETTER_AUTH_SECRET', '');
    expect(emailHmac('a@b.dk')).toBeNull();
  });
});

describe('classifyAuthFailure', () => {
  beforeEach(() => vi.stubEnv('BETTER_AUTH_SECRET', SECRET));

  it('classifies a rejected password sign-in with an emailHmac and no email', () => {
    const f = classifyAuthFailure(passwordCtx(apiError(401)));
    expect(f).toEqual({
      reason: 'invalid_credentials',
      method: 'password',
      provider: 'password',
      emailHmac: emailHmac('secret.person@example.dk'),
    });
    expect(JSON.stringify(f)).not.toMatch(/secret\.person|example\.dk|hunter2/i);
  });
  it('maps 429 to rate_limited and other errors to unknown', () => {
    expect(classifyAuthFailure(passwordCtx(apiError(429)))?.reason).toBe('rate_limited');
    expect(classifyAuthFailure(passwordCtx(apiError(400)))?.reason).toBe('unknown');
  });
  it('is null for a successful sign-in or an unrelated path', () => {
    expect(classifyAuthFailure(passwordCtx({ token: 't', user: {} }))).toBeNull();
    expect(classifyAuthFailure({ ...passwordCtx(apiError(401)), path: '/get-session' })).toBeNull();
    expect(classifyAuthFailure(null)).toBeNull();
  });
  it('omits emailHmac when no email was attempted', () => {
    const f = classifyAuthFailure(passwordCtx(apiError(401), null));
    expect(f).not.toHaveProperty('emailHmac');
  });
  it('detects an OAuth failure from the error param in the redirect location', () => {
    const f = classifyAuthFailure(oauthCtx('/oauth2/callback/:providerId', { providerId: 'keycloak' }, 'http://localhost:3004/?error=unable_to_create_session'));
    expect(f).toEqual({ reason: 'oauth_error', method: 'oidc', provider: 'keycloak' });
    const ms = classifyAuthFailure(oauthCtx('/callback/:id', { id: 'microsoft' }, '/?error=account_not_linked'));
    expect(ms).toEqual({ reason: 'account_not_linked', method: 'microsoft', provider: 'microsoft' });
  });
  it('is null for a successful OAuth redirect', () => {
    expect(classifyAuthFailure(oauthCtx('/callback/:id', { id: 'microsoft' }, 'http://localhost:3004/dashboard'))).toBeNull();
    expect(classifyAuthFailure(oauthCtx('/callback/:id', { id: 'microsoft' }, null))).toBeNull();
  });
});

describe('auditAuthFailure', () => {
  beforeEach(() => vi.stubEnv('BETTER_AUTH_SECRET', SECRET));

  it('records one auth.login_failed with no actor, valid details and the request ip', async () => {
    await auditAuthFailure(passwordCtx(apiError(401), 'Secret.Person@Example.dk', '203.0.113.20'));
    expect(recordEvent).toHaveBeenCalledTimes(1);
    const [event, opts] = recordEvent.mock.calls[0];
    expect(event.type).toBe('auth.login_failed');
    expect(event.actorUserId).toBeUndefined();
    expect(event.details).toMatchObject({ reason: 'invalid_credentials', method: 'password', provider: 'password' });
    expect(EVENT_CATALOGUE['auth.login_failed'].details.safeParse(event.details).success).toBe(true);
    expect(checkDetailsShape(event.details)).toBeNull();
    expect(validateEvent(event).ok).toBe(true);
    expect(opts.context).toMatchObject({ ip: '203.0.113.20', userAgent: 'UA/1' });
    expect(JSON.stringify(recordEvent.mock.calls)).not.toMatch(/secret\.person|hunter2|example\.dk/i);
  });

  it('records nothing for success, other paths or missing context', async () => {
    await auditAuthFailure(passwordCtx({ ok: true }));
    await auditAuthFailure({ path: '/get-session' });
    await auditAuthFailure(undefined);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('never stores an attacker-chosen provider id from the callback URL', async () => {
    await auditAuthFailure(oauthCtx('/callback/:id', { id: 'Some_Name.Here-0123456789' }, '/?error=x', '203.0.113.22'));
    expect(recordEvent.mock.calls[0][0].details).toEqual({ reason: 'oauth_error', method: 'unknown', provider: 'unknown' });
    expect(JSON.stringify(recordEvent.mock.calls)).not.toContain('Some_Name');
  });

  it('records OAuth failures', async () => {
    await auditAuthFailure(oauthCtx('/callback/:id', { id: 'microsoft' }, '/?error=access_denied', '203.0.113.21'));
    expect(recordEvent.mock.calls[0][0].details).toEqual({ reason: 'oauth_error', method: 'microsoft', provider: 'microsoft' });
  });

  it('caps the rows per IP and minute but never drops silently: the excess becomes one summary row', async () => {
    vi.useFakeTimers();
    try {
      const over = 25;
      for (let i = 0; i < LOGIN_FAILURE_LIMIT_PER_MINUTE + over; i++) {
        await auditAuthFailure(passwordCtx(apiError(401), 'a@b.dk', '203.0.113.30'));
      }
      expect(recordEvent).toHaveBeenCalledTimes(LOGIN_FAILURE_LIMIT_PER_MINUTE);
      // Other IPs are unaffected.
      await auditAuthFailure(passwordCtx(apiError(401), 'a@b.dk', '203.0.113.31'));
      expect(recordEvent).toHaveBeenCalledTimes(LOGIN_FAILURE_LIMIT_PER_MINUTE + 1);
      // When the window ends the burst is evidenced, without any further failure arriving.
      await vi.advanceTimersByTimeAsync(60_001);
      expect(recordEvent).toHaveBeenCalledTimes(LOGIN_FAILURE_LIMIT_PER_MINUTE + 2);
      const [event, opts] = recordEvent.mock.calls.at(-1)!;
      expect(event).toMatchObject({ type: 'auth.login_failed', details: { reason: 'burst_summary', droppedCount: over } });
      expect(event.actorUserId).toBeUndefined();
      expect(opts.context).toMatchObject({ ip: '203.0.113.30' });
      expect(validateEvent(event).ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never throws, even when the audit write fails or throws synchronously', async () => {
    recordEvent.mockRejectedValue(new Error('db down'));
    await expect(auditAuthFailure(passwordCtx(apiError(401), 'a@b.dk', '203.0.113.40'))).resolves.toBeUndefined();
    recordEvent.mockImplementation(() => {
      throw new Error('sync');
    });
    await expect(auditAuthFailure(passwordCtx(apiError(401), 'a@b.dk', '203.0.113.41'))).resolves.toBeUndefined();
    await expect(auditAuthFailure({ get path(): string { throw new Error('getter'); } } as any)).resolves.toBeUndefined();
  });
});

describe('createThrottle', () => {
  it('allows up to the limit per window and resets in the next window', () => {
    let t = 0;
    const th = createThrottle({ limit: 3, windowMs: 1000, maxKeys: 10, now: () => t });
    expect([1, 2, 3, 4].map(() => th.allow('a'))).toEqual([true, true, true, false]);
    t = 1000;
    expect(th.allow('a')).toBe(true);
  });
  it('keeps memory bounded when many keys arrive', () => {
    let t = 0;
    const th = createThrottle({ limit: 1, windowMs: 60_000, maxKeys: 100, now: () => t });
    for (let i = 0; i < 5000; i++) {
      t = i;
      th.allow(`k${i}`);
    }
    expect(th.size()).toBeLessThanOrEqual(100);
  });
  it('sweeps expired windows before evicting live ones', () => {
    let t = 0;
    const th = createThrottle({ limit: 1, windowMs: 100, maxKeys: 3, now: () => t });
    th.allow('a');
    th.allow('b');
    t = 50;
    th.allow('c');
    t = 120; // a and b expired, c still live
    th.allow('d');
    expect(th.size()).toBe(2);
    expect(th.allow('c')).toBe(false);
  });
  it('reports how many were counted instead of stored when the window ends (timer, next window, eviction)', () => {
    vi.useFakeTimers();
    try {
      const onSummary = vi.fn();
      const th = createThrottle({ limit: 2, windowMs: 1000, maxKeys: 2, onSummary });
      for (let i = 0; i < 5; i++) th.allow('a');
      expect(onSummary).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1001);
      expect(onSummary).toHaveBeenCalledExactlyOnceWith('a', 3);
      expect(th.size()).toBe(0);

      // The next window of a key also flushes the previous one (when its timer has not fired yet).
      onSummary.mockClear();
      for (let i = 0; i < 4; i++) th.allow('b');
      vi.setSystemTime(Date.now() + 1001);
      th.allow('b');
      expect(onSummary).toHaveBeenCalledExactlyOnceWith('b', 2);

      // Eviction of a live window with a count flushes it too.
      onSummary.mockClear();
      for (let i = 0; i < 3; i++) th.allow('c');
      th.allow('d');
      th.allow('e');
      expect(onSummary).toHaveBeenCalledWith('c', 1);
    } finally {
      vi.useRealTimers();
    }
  });
  it('a failing summary callback never breaks the caller', () => {
    const th = createThrottle({ limit: 1, windowMs: 100, maxKeys: 5, now: () => 0, onSummary: () => { throw new Error('x'); } });
    th.allow('a');
    th.allow('a');
    expect(() => th.allow('b')).not.toThrow();
  });
  it('exposes a shared per-IP budget that buckets a missing ip', () => {
    const results = Array.from({ length: LOGIN_FAILURE_LIMIT_PER_MINUTE + 1 }, () => allowLoginFailureEvent(null));
    expect(results.filter(Boolean)).toHaveLength(LOGIN_FAILURE_LIMIT_PER_MINUTE);
  });
});
