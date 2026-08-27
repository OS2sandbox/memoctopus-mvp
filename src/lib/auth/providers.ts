// Single source of truth for which login methods are enabled. Read by BOTH the
// better-auth instance (src/lib/auth/index.ts, to register providers) and the
// sign-in page (src/app/(marketing)/page.tsx, to render buttons), so the two can
// never disagree — they used to be gated independently, the server on credential
// presence and the UI on a separate NEXT_PUBLIC_*_ENABLED build-time flag.
//
// Everything here is read at REQUEST time, not build time. That is the point:
// an operator edits .env and restarts the container, no image rebuild. Only
// NEXT_PUBLIC_* values are inlined into the browser bundle by Next, and this
// module deliberately uses none — the sign-in page passes the result down as a
// prop instead. (It also indexes process.env dynamically, which Next cannot
// inline at all, so importing it as a *value* from a client component would
// silently yield undefined. Import the AuthProvider type with `import type`.)
//
// Server-only: must not import @/lib/db (it opens a pg.Pool at module scope).

/** Crosses the server→client boundary as a prop — must carry no secrets. */
export type AuthProvider =
  | { kind: 'social'; id: 'microsoft'; label: string }
  | { kind: 'oauth2'; id: string; label: string };

interface OidcConfig {
  providerId: string;
  providerName: string;
  clientId: string;
  clientSecret: string;
  discoveryUrl: string;
  pkce: boolean;
}

const DEFAULT_PROVIDER_ID = 'oidc';
const DEFAULT_PROVIDER_LABEL = 'SSO';
const LEGACY_PROVIDER_ID = 'authentik';

// Pre-generic-OIDC names. One registry so the resolvers below and the startup
// warning can never drift apart. Not all of these are still honoured — see
// microsoftConfig() — but every one of them is worth warning about.
const DEPRECATED_FLAGS = {
  EMAIL_PASSWORD_ENABLED: 'NEXT_PUBLIC_EMAIL_PASSWORD_ENABLED',
  MICROSOFT_ENABLED: 'NEXT_PUBLIC_MICROSOFT_ENABLED',
  OIDC_ENABLED: 'NEXT_PUBLIC_AUTHENTIK_ENABLED',
} as const;

const DEPRECATED_CREDENTIALS = [
  'AUTHENTIK_CLIENT_ID',
  'AUTHENTIK_CLIENT_SECRET',
  'AUTHENTIK_DISCOVERY_URL',
];

// providerId ends up in the callback path (<baseURL>/api/auth/oauth2/callback/
// <providerId>) and in the accounts.provider_id column, so it must be a safe URL
// path segment. Reusing a built-in social provider's id would make two different
// identity sources write the same accounts.provider_id and cross-match.
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const RESERVED_PROVIDER_IDS = ['microsoft'];

// `||` not `??`: docker-compose passes unset variables through as `${VAR:-}`,
// which arrives as an empty string rather than undefined (same hazard documented
// in src/lib/ai/diarization.ts).
function env(key: string): string | undefined {
  return process.env[key]?.trim() || undefined;
}

/** Resolves from the first *defined* name, so a canonical name beats its alias. */
function flag(name: string, alias?: string): boolean {
  for (const key of [name, alias]) {
    const value = key && env(key);
    if (value !== undefined) return value.toLowerCase() !== 'false';
  }
  return true;
}

function titleCase(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function credentials(prefix: 'OIDC' | 'AUTHENTIK') {
  const clientId = env(`${prefix}_CLIENT_ID`);
  const clientSecret = env(`${prefix}_CLIENT_SECRET`);
  const discoveryUrl = env(`${prefix}_DISCOVERY_URL`);
  return clientId && clientSecret && discoveryUrl ? { clientId, clientSecret, discoveryUrl } : null;
}

export function emailPasswordEnabled(): boolean {
  return flag('EMAIL_PASSWORD_ENABLED', DEPRECATED_FLAGS.EMAIL_PASSWORD_ENABLED);
}

/**
 * Microsoft Entra ID, enabled whenever credentials are present. MICROSOFT_ENABLED
 * is a kill switch, not an opt-in — requiring both credentials and a flag is what
 * let the server and the UI disagree.
 *
 * NEXT_PUBLIC_MICROSOFT_ENABLED is deliberately NOT honoured as an alias here:
 * the old .env examples shipped it as "false" by default, so an operator who
 * configures Microsoft for the first time after upgrading would silently get
 * nothing. warnDeprecatedAuthEnv() flags it instead.
 */
export function microsoftConfig() {
  const clientId = env('MICROSOFT_CLIENT_ID');
  const clientSecret = env('MICROSOFT_CLIENT_SECRET');
  if (!clientId || !clientSecret) return null;
  if (!flag('MICROSOFT_ENABLED')) return null;

  return { clientId, clientSecret, tenantId: env('MICROSOFT_TENANT_ID') || 'common' };
}

/**
 * The generic OIDC provider — Keycloak, Authentik, or any compliant IdP.
 *
 * Credential sets are all-or-nothing and never mixed: the OIDC_* triple wins,
 * and the deprecated AUTHENTIK_* triple is used only when OIDC_* is incomplete.
 * On that legacy path the provider id defaults to "authentik" so the redirect URI
 * already registered in the IdP, and the existing accounts rows, keep working.
 */
export function oidcConfig(): OidcConfig | null {
  const primary = credentials('OIDC');
  const legacy = !primary;
  const creds = primary ?? credentials('AUTHENTIK');
  if (!creds) return null;

  // NEXT_PUBLIC_AUTHENTIK_ENABLED only applies when the legacy credentials are
  // actually in use, so a stale "false" left in a migrated .env cannot silently
  // disable a freshly configured Keycloak.
  if (!flag('OIDC_ENABLED', legacy ? DEPRECATED_FLAGS.OIDC_ENABLED : undefined)) return null;

  // Lower-cased first: "Keycloak" is a natural thing to type, and the id is
  // case-insensitive as far as we are concerned.
  const providerId =
    env('OIDC_PROVIDER_ID')?.toLowerCase() ?? (legacy ? LEGACY_PROVIDER_ID : DEFAULT_PROVIDER_ID);

  // Disable OIDC rather than throwing: oidcConfig() runs at module scope in
  // auth/index.ts and per request on the sign-in page, so throwing would 500
  // every route including email/password login — a typo would lock everyone out.
  if (!PROVIDER_ID_RE.test(providerId) || RESERVED_PROVIDER_IDS.includes(providerId)) {
    console.error(
      `[auth] Ignoring OIDC config: OIDC_PROVIDER_ID "${providerId}" must match ` +
        `${PROVIDER_ID_RE} and must not be one of ${RESERVED_PROVIDER_IDS.join(', ')}. ` +
        'It is used as a URL path segment in the OAuth callback.',
    );
    return null;
  }

  return {
    ...creds,
    providerId,
    providerName: env('OIDC_PROVIDER_NAME') ?? defaultProviderLabel(providerId),
    // better-auth defaults pkce to false; we default it on, since both Keycloak
    // and Authentik support it and servers that don't simply ignore the params.
    pkce: flag('OIDC_PKCE'),
  };
}

function defaultProviderLabel(providerId: string): string {
  return providerId === DEFAULT_PROVIDER_ID ? DEFAULT_PROVIDER_LABEL : titleCase(providerId);
}

export function enabledAuthProviders(): AuthProvider[] {
  const providers: AuthProvider[] = [];

  if (microsoftConfig()) {
    providers.push({ kind: 'social', id: 'microsoft', label: 'Microsoft' });
  }

  const oidc = oidcConfig();
  if (oidc) {
    providers.push({ kind: 'oauth2', id: oidc.providerId, label: oidc.providerName });
  }

  return providers;
}

/** Called once at startup from auth/index.ts. */
export function warnDeprecatedAuthEnv(): void {
  const inUse = [...Object.values(DEPRECATED_FLAGS), ...DEPRECATED_CREDENTIALS].filter(
    (name) => env(name) !== undefined,
  );
  if (inUse.length === 0) return;

  console.warn(
    `[auth] Deprecated env vars in use: ${inUse.join(', ')}. ` +
      'Use OIDC_CLIENT_ID / OIDC_CLIENT_SECRET / OIDC_DISCOVERY_URL / OIDC_ENABLED, ' +
      'MICROSOFT_ENABLED and EMAIL_PASSWORD_ENABLED instead. ' +
      'Set OIDC_PROVIDER_ID=authentik to keep your existing callback URL and accounts.',
  );
}
