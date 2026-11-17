import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {} }));

import { entraUserInfoOverrides, type StoredUser, type UserLookups } from './entra-user-info';

// better-auth's overrideUserInfoOnSignIn writes the Entra claims over the stored user on
// every sign-in: name, email, and emailVerified as the claim states it. Writing an email
// another user row already holds breaks the UNIQUE constraint on users.email, and the
// write is not caught, so that user could no longer sign in with Microsoft at all.
// entraUserInfoOverrides runs first (as the provider's mapProfileToUser) and adjusts the
// claims it hands on.

const ME: StoredUser = { id: 'user-me', email: 'old@example.test', emailVerified: true };

function lookups(opts: { linked?: StoredUser | null; holders?: Record<string, string> }): UserLookups {
  return {
    userForMicrosoftAccount: vi.fn(async () => opts.linked ?? null),
    userIdForEmail: vi.fn(async (email: string) => opts.holders?.[email] ?? null),
  };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('entraUserInfoOverrides', () => {
  it('keeps the stored email when another user already holds the new one, and says so', async () => {
    const l = lookups({ linked: ME, holders: { 'new@example.test': 'user-other' } });

    const out = await entraUserInfoOverrides({ sub: 'sub-1', email: 'New@Example.test' }, l);

    expect(out.email).toBe('old@example.test');
    expect(l.userForMicrosoftAccount).toHaveBeenCalledWith('sub-1');
    expect(l.userIdForEmail).toHaveBeenCalledWith('new@example.test');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('user-me'));
    // The address itself stays out of the log.
    expect(String(vi.mocked(console.warn).mock.calls[0][0])).not.toContain('new@example.test');
  });

  it('lets a free new email through', async () => {
    const out = await entraUserInfoOverrides(
      { sub: 'sub-1', email: 'new@example.test' },
      lookups({ linked: ME }),
    );

    expect(out).not.toHaveProperty('email');
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('does not look the email up when it has not changed', async () => {
    const l = lookups({ linked: ME });

    const out = await entraUserInfoOverrides({ sub: 'sub-1', email: 'OLD@example.test' }, l);

    expect(out).not.toHaveProperty('email');
    expect(l.userIdForEmail).not.toHaveBeenCalled();
  });

  it('never downgrades a verified user, whatever the claim says', async () => {
    const out = await entraUserInfoOverrides(
      { sub: 'sub-1', email: 'new@example.test' },
      lookups({ linked: ME }),
    );

    expect(out.emailVerified).toBe(true);
  });

  it('leaves emailVerified to the claim for a user who was never verified', async () => {
    const out = await entraUserInfoOverrides(
      { sub: 'sub-1', email: 'new@example.test' },
      lookups({ linked: { ...ME, emailVerified: false } }),
    );

    expect(out).not.toHaveProperty('emailVerified');
  });

  it('asserts a verified email on a first sign-in, so the account can be linked', async () => {
    const l = lookups({ linked: null, holders: { 'new@example.test': 'user-other' } });

    // Entra sends no email_verified claim, so without this better-auth maps the profile
    // unverified and refuses to link it to the existing user (?error=account_not_linked).
    expect(await entraUserInfoOverrides({ sub: 'sub-1', email: 'new@example.test' }, l)).toEqual({
      emailVerified: true,
    });
    expect(l.userIdForEmail).not.toHaveBeenCalled();
  });

  it('changes nothing without a subject claim', async () => {
    const l = lookups({ linked: ME });

    expect(await entraUserInfoOverrides({ email: 'new@example.test' }, l)).toEqual({});
    expect(l.userForMicrosoftAccount).not.toHaveBeenCalled();
  });

  it("falls back to better-auth's behaviour when the lookup fails", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const l: UserLookups = {
      userForMicrosoftAccount: vi.fn(async () => {
        throw new Error('db down');
      }),
      userIdForEmail: vi.fn(),
    };

    expect(await entraUserInfoOverrides({ sub: 'sub-1', email: 'new@example.test' }, l)).toEqual({});
  });
});
