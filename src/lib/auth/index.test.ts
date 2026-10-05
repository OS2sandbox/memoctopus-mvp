import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {}, pool: {} }));
const runLoginHooks = vi.fn();
vi.mock('@/lib/authz/login-hook', () => ({ runLoginHooks: (...a: unknown[]) => runLoginHooks(...a) }));

beforeEach(() => {
  vi.resetModules();
  runLoginHooks.mockReset();
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
