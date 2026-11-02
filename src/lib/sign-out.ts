import { flushAuditNow } from '@/lib/audit/client';
import { signOut } from '@/lib/auth-client';

/**
 * Signs the person out after delivering the queued audit events (at most 2 s, see flushAuditNow):
 * once the session is gone they can only be delivered at the next login. Never rejects; a failed
 * sign-out is logged, and the caller navigates away either way.
 */
export async function signOutAfterFlush(): Promise<void> {
  try {
    await flushAuditNow();
    await signOut();
  } catch (err) {
    console.error('signOut failed', err);
  }
}
