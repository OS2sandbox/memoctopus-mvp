import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';

// With overrideUserInfoOnSignIn (one named tenant, see auth/index.ts) better-auth writes
// the Entra claims over the stored user on every sign-in: name, email, and emailVerified
// as the claim states it. Two of those writes are wrong for us:
//
// - An email that another user row already holds. users.email is UNIQUE and better-auth
//   does not catch the failed update, so that user could no longer sign in with Microsoft
//   at all — on every attempt, until someone edited the database.
// - emailVerified from a claim Entra usually does not send: when the address changes,
//   better-auth takes the claim's value, which downgrades a verified user to unverified
//   and so blocks later account linking.
//
// better-auth's update hook (databaseHooks.user.update.before) is not told which user it
// is updating, so it cannot tell "this user already has that address" from "someone else
// has it". The provider's mapProfileToUser runs earlier with the subject claim in hand,
// which identifies the linked user — so the claims are adjusted there instead.

export interface StoredUser {
  id: string;
  email: string;
  emailVerified: boolean;
}

export interface UserLookups {
  /** The user the Microsoft account with this subject claim is linked to, if any. */
  userForMicrosoftAccount(accountId: string): Promise<StoredUser | null>;
  /** The id of the user row holding this (lower-case) email, if any. */
  userIdForEmail(email: string): Promise<string | null>;
}

const dbUserLookups: UserLookups = {
  async userForMicrosoftAccount(accountId) {
    const [row] = await db
      .select({ id: users.id, email: users.email, emailVerified: users.emailVerified })
      .from(accounts)
      .innerJoin(users, eq(accounts.userId, users.id))
      .where(and(eq(accounts.providerId, 'microsoft'), eq(accounts.accountId, accountId)))
      .limit(1);
    return row ?? null;
  },
  async userIdForEmail(email) {
    const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    return row?.id ?? null;
  },
};

/**
 * The Microsoft provider's mapProfileToUser: overrides for the claims better-auth is about
 * to write. The name always follows Entra. The email follows it only when no other user
 * holds the new address (logged when skipped). A verified user stays verified.
 *
 * Returns {} — better-auth's own behaviour — on a first sign-in (nothing stored to protect)
 * and if the lookup fails.
 */
export async function entraUserInfoOverrides(
  profile: { sub?: unknown; email?: unknown },
  lookups: UserLookups = dbUserLookups,
): Promise<{ email?: string; emailVerified?: boolean }> {
  if (typeof profile.sub !== 'string' || !profile.sub) return {};
  try {
    const stored = await lookups.userForMicrosoftAccount(profile.sub);
    if (!stored) return {};

    const overrides: { email?: string; emailVerified?: boolean } = {};
    const claimed = typeof profile.email === 'string' ? profile.email.toLowerCase() : null;
    if (claimed && claimed !== stored.email) {
      const holder = await lookups.userIdForEmail(claimed);
      if (holder && holder !== stored.id) {
        console.warn(
          `[auth] Entra reports a changed email for user ${stored.id}, but another user ` +
            `already has that address; keeping the stored email.`,
        );
        overrides.email = stored.email;
      }
    }
    if (stored.emailVerified) overrides.emailVerified = true;
    return overrides;
  } catch (err) {
    console.error('[auth] could not check the Entra user info before sign-in:', err);
    return {};
  }
}
