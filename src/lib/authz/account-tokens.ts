import { defaultRunner, errorLabel, type SqlQueryable } from './pg-runner';

/**
 * Removes the stored id token of the person's Microsoft account. The login hook does it at every login, and the
 * Graph token calls (src/lib/teams/graph-client.ts) do it again after every access-token fetch: better-auth's
 * refresh writes `idToken: newTokens.idToken || account.idToken` and Entra answers a refresh that asks for `openid`
 * with a fresh id token, which would otherwise sit in `public.accounts` in plaintext, with its identity and
 * role/group claims, until the next login. Nothing reads a stored id token after the login hooks, so this is safe
 * at any other time. Never throws.
 */
export async function scrubMicrosoftIdToken(userId: string, runner: SqlQueryable = defaultRunner()): Promise<void> {
  try {
    await runner.query(
      `UPDATE public.accounts SET id_token = NULL
        WHERE user_id = $1 AND provider_id = 'microsoft' AND id_token IS NOT NULL`,
      [userId],
    );
  } catch (err) {
    console.error(`[authz] token step failed: scrub_id_token (${errorLabel(err)})`);
  }
}
