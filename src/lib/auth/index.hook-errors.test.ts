// The real login hook against a database that is down: login must still succeed.
import { describe, expect, it, vi } from 'vitest';

const down = () => Promise.reject(Object.assign(new Error('connect ECONNREFUSED secret@example.dk'), { code: 'ECONNREFUSED' }));
vi.mock('@/lib/db', () => ({ db: {}, pool: { query: down, connect: down } }));

describe('session.create.after hook', () => {
  it('resolves (never blocks login) when every database call fails, and logs no values', async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', 'x'.repeat(40));
    vi.stubEnv('BETTER_AUTH_URL', 'http://localhost:3004');
    vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
    vi.stubEnv('BOOTSTRAP_ADMIN_EMAILS', 'secret@example.dk');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { auth } = await import('./index');
    const options = (auth as unknown as { options: Record<string, any> }).options;
    await expect(options.databaseHooks.session.create.after({ userId: 'u1' }, null)).resolves.toBeUndefined();

    expect(err).toHaveBeenCalled();
    expect(JSON.stringify(err.mock.calls)).not.toContain('secret@example.dk');
    vi.unstubAllEnvs();
    err.mockRestore();
  });

  it('audit hooks (login, logout, failed login) also resolve with the database down and log no values', async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', 'x'.repeat(40));
    vi.stubEnv('BETTER_AUTH_URL', 'http://localhost:3004');
    vi.resetModules();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { auth } = await import('./index');
    const options = (auth as unknown as { options: Record<string, any> }).options;
    const session = { userId: 'u1', token: 'session-token-secret', ipAddress: '203.0.113.5', userAgent: 'UA' };

    await expect(options.databaseHooks.session.create.after(session, { path: '/sign-in/email' })).resolves.toBeUndefined();
    await expect(options.databaseHooks.session.delete.after(session, { path: '/sign-out' })).resolves.toBeUndefined();
    const failed = await options.hooks.after({
      path: '/sign-in/email',
      body: { email: 'secret@example.dk', password: 'pw-secret' },
      headers: new Headers({ 'x-forwarded-for': '203.0.113.6' }),
      context: { returned: Object.assign(new Error('nope'), { statusCode: 401 }) },
      returnHeaders: true,
    });
    expect(failed.response).toBeUndefined();

    // The writes were attempted and dropped, with content-free warnings only.
    expect(warn.mock.calls.some((c) => String(c[0]).includes('[audit] event dropped type=auth.login'))).toBe(true);
    const logged = JSON.stringify([...err.mock.calls, ...warn.mock.calls]);
    for (const secret of ['secret@example.dk', 'pw-secret', 'session-token-secret']) expect(logged).not.toContain(secret);
    vi.unstubAllEnvs();
    err.mockRestore();
    warn.mockRestore();
  });
});
