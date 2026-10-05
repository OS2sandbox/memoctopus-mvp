// SQL fragments shared by the two places that must agree on what "an
// administrator who can still use the UI" is: the last-admin guard when
// revoking (access-admin.ts) and the first-admin bootstrap (bootstrap.ts).
// If they drift apart, bootstrap refuses forever while nobody can log in.

/** Row is within [start_date, stop_date). `alias` is a trusted constant, never user input. */
export const activeSql = (alias: string) =>
  `(${alias}.start_date IS NULL OR ${alias}.start_date <= now()) AND (${alias}.stop_date IS NULL OR ${alias}.stop_date > now())`;

/**
 * Expects `public.role_assignments ra JOIN public.directory_users du`. Only
 * local, global, active assignments of an enabled, login-capable person count:
 * a scoped or synced admin row does not give access.manage here.
 */
export const USABLE_LOCAL_ADMIN_SQL = `ra.role_key = 'tt-administrator' AND ra.source = 'local'
  AND ra.scope_org_unit_uuid IS NULL
  AND ${activeSql('ra')}
  AND du.disabled = false AND du.app_user_id IS NOT NULL`;
