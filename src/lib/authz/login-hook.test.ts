import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ pool: {} }));
const capture = vi.fn();
const bootstrap = vi.fn();
const match = vi.fn();
vi.mock('./identity', () => ({ captureExternalIdentity: (...a: unknown[]) => capture(...a) }));
vi.mock('./bootstrap', () => ({ maybeBootstrapAdmin: (...a: unknown[]) => bootstrap(...a) }));
vi.mock('./directory-match', () => ({ matchDirectoryUser: (...a: unknown[]) => match(...a) }));

import { runLoginHooks } from './login-hook';

const ID = { userId: 'u1', providerId: 'oidc', subject: 's', claims: { sub: 's', email: 'secret@example.dk' } };

beforeEach(() => {
  vi.stubEnv('ACCESS_SOURCE', 'local');
  capture.mockReset().mockResolvedValue([ID]);
  bootstrap.mockReset().mockResolvedValue({ granted: false, reason: 'no_allowlist' });
  match.mockReset().mockResolvedValue({ status: 'linked' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
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

  it('swallows matching errors', async () => {
    vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
    match.mockRejectedValue(new Error('boom'));
    await expect(runLoginHooks('u1')).resolves.toBeUndefined();
    expect(JSON.stringify((console.error as any).mock.calls)).toContain('match_directory_user');
  });
});
