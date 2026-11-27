import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/authz/app-access', () => ({ appAccessForUser: vi.fn() }));
vi.mock('./addin-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./addin-auth')>()),
  authenticateAddinRequest: vi.fn(),
}));

import { appAccessForUser } from '@/lib/authz/app-access';
import { AddinAuthError, authenticateAddinRequest } from './addin-auth';
import { requireAddinUser } from './addin-gate';

const mockAccess = vi.mocked(appAccessForUser);
const mockAuthenticate = vi.mocked(authenticateAddinRequest);

// The add-in has no session cookie, so requireAppAccess never runs for it: this gate is
// where a disabled person, or one without a role, is turned away from the add-in.
describe('requireAddinUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticate.mockResolvedValue('user-1');
  });

  it('lets a person with access through, by the user id their token names', async () => {
    mockAccess.mockResolvedValueOnce({ userId: 'user-1' } as never);
    await expect(requireAddinUser(new Headers())).resolves.toBe('user-1');
    expect(mockAccess).toHaveBeenCalledWith('user-1');
  });

  it('refuses a person the access check refuses (disabled, or no role when one is required)', async () => {
    mockAccess.mockResolvedValueOnce('forbidden');
    const err = await requireAddinUser(new Headers()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AddinAuthError);
    expect(err).toMatchObject({ code: 'forbidden', status: 403 });
  });

  it('fails closed when the access check cannot be made', async () => {
    mockAccess.mockResolvedValueOnce('unavailable');
    await expect(requireAddinUser(new Headers())).rejects.toMatchObject({ code: 'unavailable', status: 503 });
  });

  it('never asks about access for a token it could not verify', async () => {
    mockAuthenticate.mockRejectedValueOnce(new AddinAuthError('invalid_token'));
    await expect(requireAddinUser(new Headers())).rejects.toMatchObject({ code: 'invalid_token' });
    expect(mockAccess).not.toHaveBeenCalled();
  });
});
