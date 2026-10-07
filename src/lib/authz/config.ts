// Access-control settings. Read from process.env at CALL time (same idiom as
// src/lib/auth/providers.ts) so an operator can change .env and restart
// without an image rebuild. Never NEXT_PUBLIC_*.
import { microsoftTenantId } from '@/lib/auth/providers';

export type AccessSource = 'local' | 'rollekatalog' | 'claims';
export type DirectoryMatchMode = 'userid-claim' | 'extuuid-claim' | 'email';

function clean(name: string): string {
  return (process.env[name] ?? '').trim();
}

/**
 * An unusable security setting. Thrown instead of silently picking a default so a
 * typo can never flip the security model. The message never echoes the value.
 * Route wrappers answer 503; the (app) layout shows the retry screen.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Unset or blank => 'local' (the default). 'local' / 'rollekatalog' / 'claims' (trimmed,
 * case-insensitive) as written. Anything else THROWS ConfigError: 'local' is the
 * permissive mode (bootstrap admin, writable local admin API, IdP roles ignored), so a
 * typo such as "rolekatalog" or "claim" must fail closed, never fall back to it.
 *
 *  - local:        roles are assigned in the app's own admin UI.
 *  - rollekatalog: roles and org units are synced from Rollekatalog.
 *  - claims:       roles come from the IdP's role/group claims at every login (see
 *                  auth/config-file.ts for the mapping); the app has no role admin.
 */
export function accessSource(): AccessSource {
  const v = clean('ACCESS_SOURCE').toLowerCase();
  if (v === '' || v === 'local') return 'local';
  if (v === 'rollekatalog') return 'rollekatalog';
  if (v === 'claims') return 'claims';
  throw new ConfigError('ACCESS_SOURCE must be "local", "rollekatalog" or "claims"');
}

/**
 * Kill switch for the in-app role administration: role grant/revoke, local org-unit
 * and member edits, and the first-administrator bootstrap. Only meaningful in 'local'
 * mode (in the others every local write would be inert, because local rows are
 * ignored), so there it is always false whatever the variable says. In 'local' mode
 * it defaults to on, and ACCESS_LOCAL_ADMIN=false turns it off. Municipal deployments
 * run claims (or rollekatalog) and never expose a local admin.
 */
export function localAdminEnabled(): boolean {
  if (accessSource() !== 'local') return false;
  return clean('ACCESS_LOCAL_ADMIN').toLowerCase() !== 'false';
}

const DEFAULT_ROLE_CLAIMS_MAX_SECONDS = 8 * 3600;

/**
 * How long roles taken from IdP claims count after the login that wrote them
 * (ROLE_CLAIMS_MAX_SECONDS, default 8 hours). Claims only change at login, so this is
 * also how long a removed role can linger; in claims mode the session lifetime is set
 * to the same value (auth/index.ts) so a session never outlives its role snapshot.
 * Fail closed: an unusable value falls back to the DEFAULT, never to "unlimited".
 */
export function roleClaimsMaxSeconds(): number {
  const raw = clean('ROLE_CLAIMS_MAX_SECONDS');
  if (raw === '') return DEFAULT_ROLE_CLAIMS_MAX_SECONDS;
  const n = /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
  return n >= 60 && n <= 30 * 86_400 ? n : DEFAULT_ROLE_CLAIMS_MAX_SECONDS;
}

/**
 * How fresh (seconds) a user's role/group claim row must be to count, or null when claim-based
 * roles are off. `override` is a test seam (null switches them off); otherwise
 * ROLE_CLAIMS_MAX_SECONDS in claims mode, else null. `source` defaults to ACCESS_SOURCE.
 */
export function claimsFreshnessSeconds(override?: number | null, source: AccessSource = accessSource()): number | null {
  if (override !== undefined) return override;
  return source === 'claims' ? roleClaimsMaxSeconds() : null;
}

/**
 * "No role, no access". Default off, except in claims mode: there the roles come from the IdP, so a
 * person the IdP maps to no role (a stranger from another tenant, a password account, somebody whose
 * group was not mapped) must be refused rather than get the baseline. Explicit REQUIRE_ROLE_TO_LOGIN=false
 * is the only way to open it up there (then ordinary users need no mapping to tt-bruger).
 */
export function requireRoleToLogin(): boolean {
  const v = clean('REQUIRE_ROLE_TO_LOGIN').toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  try {
    return accessSource() === 'claims';
  } catch {
    return false;
  }
}

export function bootstrapAdminEmails(): string[] {
  return [
    ...new Set(
      clean('BOOTSTRAP_ADMIN_EMAILS')
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

export function directoryMatchMode(): DirectoryMatchMode {
  const v = clean('DIRECTORY_MATCH').toLowerCase();
  return v === 'extuuid-claim' || v === 'email' ? v : 'userid-claim';
}

export function directoryUserIdClaim(): string {
  return clean('DIRECTORY_USERID_CLAIM') || 'preferred_username';
}

// Multi-tenant aliases are not a single tenant: any Entra tenant can sign in.
const MULTI_TENANT_ALIASES = new Set(['common', 'organizations', 'consumers']);

/** The configured Entra tenant (config file, else MICROSOFT_TENANT_ID) when it names exactly one tenant, else null. */
export function singleTenantId(): string | null {
  const tenant = (microsoftTenantId() ?? '').trim().toLowerCase();
  return tenant && !MULTI_TENANT_ALIASES.has(tenant) ? tenant : null;
}
