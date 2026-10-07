// Runs once when the Next.js server starts. Used only to record a change of the
// system configuration in the audit log (see lib/system/config-fingerprint.ts).
// Fire-and-forget: the check never throws and never delays startup. The import sits
// inside a positive NEXT_RUNTIME check so the edge bundle never pulls in `pg`.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { checkConfigOnce } = await import('@/lib/system/config-fingerprint');
      void checkConfigOnce();
    } catch {
      // Startup must never depend on the audit trail.
    }
  }
}
