// Access-control settings. Read from process.env at CALL time (same idiom as
// src/lib/auth/providers.ts) so an operator can change .env and restart
// without an image rebuild. Never NEXT_PUBLIC_*.

export type AccessSource = 'local' | 'rollekatalog';
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
 * Unset or blank => 'local' (the default). 'local' / 'rollekatalog' (trimmed,
 * case-insensitive) as written. Anything else THROWS ConfigError: 'local' is the
 * permissive mode (bootstrap admin, writable local admin API, Rollekatalog roles
 * ignored), so a typo such as "rolekatalog" must fail closed, never fall back to it.
 */
export function accessSource(): AccessSource {
  const v = clean('ACCESS_SOURCE').toLowerCase();
  if (v === '' || v === 'local') return 'local';
  if (v === 'rollekatalog') return 'rollekatalog';
  throw new ConfigError('ACCESS_SOURCE must be "local" or "rollekatalog"');
}

export function requireRoleToLogin(): boolean {
  return clean('REQUIRE_ROLE_TO_LOGIN').toLowerCase() === 'true';
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

/** MICROSOFT_TENANT_ID when it names exactly one tenant, else null. */
export function singleTenantId(): string | null {
  const tenant = clean('MICROSOFT_TENANT_ID').toLowerCase();
  return tenant && !MULTI_TENANT_ALIASES.has(tenant) ? tenant : null;
}
