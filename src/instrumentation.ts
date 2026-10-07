// Runs once when the Next.js server starts: records a change of the system configuration
// in the audit log (lib/system/config-fingerprint.ts) and loads the `catalogue` of the auth
// config file into public.external_roles (lib/authz/external-roles.ts).
// Fire-and-forget: neither step throws or delays startup. The imports sit
// inside a positive NEXT_RUNTIME check so the edge bundle never pulls in `pg`.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { checkConfigOnce } = await import('@/lib/system/config-fingerprint');
      void checkConfigOnce();
      const { syncConfigCatalogueOnce } = await import('@/lib/authz/external-roles');
      void syncConfigCatalogueOnce();
    } catch {
      // Startup must never depend on the audit trail.
    }
  }
}
