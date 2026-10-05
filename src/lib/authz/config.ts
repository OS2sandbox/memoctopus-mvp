// Access-control settings. Read from process.env at CALL time (same idiom as
// src/lib/auth/providers.ts) so an operator can change .env and restart
// without an image rebuild. Never NEXT_PUBLIC_*.

export type AccessSource = 'local' | 'rollekatalog';
export type DirectoryMatchMode = 'userid-claim' | 'extuuid-claim' | 'email';

function clean(name: string): string {
  return (process.env[name] ?? '').trim();
}

/** Unknown or empty values fall back to 'local' (no throw: a typo must not take the app down). */
export function accessSource(): AccessSource {
  return clean('ACCESS_SOURCE').toLowerCase() === 'rollekatalog' ? 'rollekatalog' : 'local';
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
