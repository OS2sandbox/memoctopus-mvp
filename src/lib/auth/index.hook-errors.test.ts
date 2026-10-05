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
});
