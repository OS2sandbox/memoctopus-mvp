// Runs after a better-auth session is created (databaseHooks.session.create.after).
// Contract: NEVER throws. A bug or outage here must not block or break login, so
// every step is isolated and logs only a step label and the error class.
import { maybeBootstrapAdmin } from './bootstrap';
import { accessSource } from './config';
import { matchDirectoryUser } from './directory-match';
import { captureExternalIdentity, type ExternalIdentity } from './identity';
import { errorLabel } from './pg-runner';

export async function runLoginHooks(userId: string): Promise<void> {
  let identities: ExternalIdentity[] = [];

  try {
    identities = await captureExternalIdentity(userId);
  } catch (err) {
    console.error(`[authz] login step failed: capture_identity (${errorLabel(err)})`);
  }

  try {
    await maybeBootstrapAdmin(userId);
  } catch (err) {
    console.error(`[authz] login step failed: bootstrap_admin (${errorLabel(err)})`);
  }

  // Local mode links roles to app users directly; claims are never used there.
  if (accessSource() !== 'rollekatalog') return;
  for (const identity of identities) {
    try {
      await matchDirectoryUser(identity);
    } catch (err) {
      console.error(`[authz] login step failed: match_directory_user (${errorLabel(err)})`);
    }
  }
}
