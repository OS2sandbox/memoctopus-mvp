import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {}, pool: {} }));
const runLoginHooks = vi.fn();
const calls: string[] = [];
const auditLogin = vi.fn();
const auditLogout = vi.fn();
const auditAuthFailure = vi.fn();
vi.mock('@/lib/authz/login-hook', () => ({
  runLoginHooks: (...a: unknown[]) => runLoginHooks(...a),
  auditLogin: (...a: unknown[]) => auditLogin(...a),
  auditLogout: (...a: unknown[]) => auditLogout(...a),
  auditAuthFailure: (...a: unknown[]) => auditAuthFailure(...a),
}));

beforeEach(() => {
  vi.resetModules();
  calls.length = 0;
  runLoginHooks.mockReset().mockImplementation(async () => void calls.push('hooks'));
  auditLogin.mockReset().mockImplementation(async () => void calls.push('audit'));
  auditLogout.mockReset().mockResolvedValue(undefined);
  auditAuthFailure.mockReset().mockResolvedValue(undefined);
  vi.stubEnv('BETTER_AUTH_SECRET', 'x'.repeat(40));
  vi.stubEnv('BETTER_AUTH_URL', 'http://localhost:3004');
  vi.stubEnv('AUTH_IP_HEADERS', '');
});

async function loadOptions() {
  const { auth } = await import('./index');
  return (auth as unknown as { options: Record<string, any> }).options;
}

describe('auth wiring', () => {
  it('runs the login hooks with the new session user', async () => {
    runLoginHooks.mockResolvedValue(undefined);
    const options = await loadOptions();
    await options.databaseHooks.session.create.after({ userId: 'u1', token: 'secret-token' }, null);
    expect(runLoginHooks).toHaveBeenCalledWith('u1');
  });

  it('records auth.login after the login hooks, with the hook context', async () => {
    const options = await loadOptions();
    const session = { userId: 'u1', token: 'secret-token', ipAddress: '203.0.113.1' };
    const ctx = { path: '/sign-in/email' };
    await options.databaseHooks.session.create.after(session, ctx);
    expect(calls).toEqual(['hooks', 'audit']);
    expect(auditLogin).toHaveBeenCalledWith(session, ctx);
  });

  it('records auth.logout from session.delete.after with the hook context', async () => {
    const options = await loadOptions();
    const session = { userId: 'u1' };
    const ctx = { path: '/sign-out' };
    await options.databaseHooks.session.delete.after(session, ctx);
    expect(auditLogout).toHaveBeenCalledWith(session, ctx);
  });

  it('feeds every request to the failed-login audit and never alters the response', async () => {
    const options = await loadOptions();
    const ctx = { path: '/sign-in/email', headers: new Headers(), context: { returned: { statusCode: 401 } }, returnHeaders: true };
    const out = await options.hooks.after(ctx);
    expect(auditAuthFailure).toHaveBeenCalledTimes(1);
    expect(auditAuthFailure.mock.calls[0][0]).toMatchObject({ path: '/sign-in/email' });
    // returnHeaders:true wraps the handler result as { headers, response }; response must stay empty.
    expect(out?.response).toBeUndefined();
  });

  it('adds no account linking, no cookie cache and no extra trust', async () => {
    const options = await loadOptions();
    expect(options.account).toBeUndefined();
    expect(options.session).toBeUndefined();
  });

  it('leaves the ip header default alone unless AUTH_IP_HEADERS is set', async () => {
    expect((await loadOptions()).advanced).toBeUndefined();
    vi.resetModules();
    vi.stubEnv('AUTH_IP_HEADERS', 'x-real-ip');
    expect((await loadOptions()).advanced).toEqual({ ipAddress: { ipAddressHeaders: ['x-real-ip'] } });
  });
});
