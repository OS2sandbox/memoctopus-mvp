import { appAccessForUser } from '@/lib/authz/app-access';
import { AddinAuthError, authenticateAddinRequest } from './addin-auth';

/**
 * The gate for the add-in's routes: who is calling (authenticateAddinRequest, the
 * Entra token), then the same live access check as every session route
 * (requireAppAccess): a disabled person, or one without a role while
 * REQUIRE_ROLE_TO_LOGIN is on, is refused here too, and a failing lookup fails
 * closed. Returns the user id, or throws an AddinAuthError the pane can show.
 */
export async function requireAddinUser(headers: Headers): Promise<string> {
  const userId = await authenticateAddinRequest(headers);
  const access = await appAccessForUser(userId);
  if (access === 'unavailable') throw new AddinAuthError('unavailable', 'access check failed');
  if (access === 'forbidden') throw new AddinAuthError('forbidden');
  return userId;
}
