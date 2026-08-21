// ─── Auth provider configuration ─────────────────────────────────────────────
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

/**
 * A login provider as the browser sees it. Deliberately carries no secrets —
 * this crosses the server→client boundary as a prop.
 */
export type AuthProvider =
  | { kind: 'social'; id: 'microsoft'; label: string }
  | { kind: 'oauth2'; id: string; label: string };

export interface OidcConfig {
  providerId: string;
  providerName: string;
  clientId: string;
  clientSecret: string;
  discoveryUrl: string;
  pkce: boolean;
  /** Sourced from the deprecated AUTHENTIK_* variables. */
  legacy: boolean;
}

export interface MicrosoftConfig {
  clientId: string;
  clientSecret: string;
  tenantId: string;
}

const DEFAULT_PROVIDER_ID = 'oidc';
const DEFAULT_PROVIDER_LABEL = 'SSO';
const LEGACY_PROVIDER_ID = 'authentik';
const LEGACY_PROVIDER_LABEL = 'Authentik';

// providerId ends up in the callback path (<baseURL>/api/auth/oauth2/callback/
// <providerId>) and in the accounts.provider_id column, so it must be a safe URL
// path segment. Rejecting a bad value at boot beats a callback that 404s only
// once a user tries to log in.
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Read an env var, treating blank as unset.
 *
 * docker-compose passes unset variables through as `${VAR:-}`, which arrives as
 * an empty string rather than undefined — hence `||` and not `??` (same hazard
 * documented in src/lib/ai/diarization.ts).
 */
function env(key: string): string | undefined {
  return process.env[key]?.trim() || undefined;
}

/**
 * Resolve a boolean toggle from the first *defined* name, so a canonical name
 * always wins over its deprecated alias. Anything but the literal "false"
 * counts as on.
 */
function flag(...names: string[]): boolean {
  for (const name of names) {
    const value = env(name);
    if (value !== undefined) return value.toLowerCase() !== 'false';
  }
  return true;
}

function titleCase(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

export function emailPasswordEnabled(): boolean {
  return flag('EMAIL_PASSWORD_ENABLED', 'NEXT_PUBLIC_EMAIL_PASSWORD_ENABLED');
}

/**
 * Microsoft Entra ID, enabled whenever credentials are present. MICROSOFT_ENABLED
 * (or the deprecated NEXT_PUBLIC_MICROSOFT_ENABLED) is a kill switch, not an
 * opt-in — requiring both credentials and a flag is what let the two disagree.
 */
export function microsoftConfig(): MicrosoftConfig | null {
  const clientId = env('MICROSOFT_CLIENT_ID');
  const clientSecret = env('MICROSOFT_CLIENT_SECRET');
  if (!clientId || !clientSecret) return null;
  if (!flag('MICROSOFT_ENABLED', 'NEXT_PUBLIC_MICROSOFT_ENABLED')) return null;

  return { clientId, clientSecret, tenantId: env('MICROSOFT_TENANT_ID') || 'common' };
}

/**
 * The generic OIDC provider — Keycloak, Authentik, or any compliant IdP.
 *
 * Credential sets are all-or-nothing and never mixed: the OIDC_* triple wins,
 * and the deprecated AUTHENTIK_* triple is used only when OIDC_* is incomplete.
 * On that legacy path the provider id stays "authentik" so the redirect URI
 * already registered in the IdP, and the existing accounts rows, keep working.
 */
export function oidcConfig(): OidcConfig | null {
  let legacy = false;
  let clientId = env('OIDC_CLIENT_ID');
  let clientSecret = env('OIDC_CLIENT_SECRET');
  let discoveryUrl = env('OIDC_DISCOVERY_URL');

  if (!clientId || !clientSecret || !discoveryUrl) {
    clientId = env('AUTHENTIK_CLIENT_ID');
    clientSecret = env('AUTHENTIK_CLIENT_SECRET');
    discoveryUrl = env('AUTHENTIK_DISCOVERY_URL');
    legacy = true;
  }
  if (!clientId || !clientSecret || !discoveryUrl) return null;

  // NEXT_PUBLIC_AUTHENTIK_ENABLED only applies when the legacy credentials are
  // actually in use, so a stale "false" left in a migrated .env cannot silently
  // disable a freshly configured Keycloak.
  const killSwitches = legacy
    ? ['OIDC_ENABLED', 'NEXT_PUBLIC_AUTHENTIK_ENABLED']
    : ['OIDC_ENABLED'];
  if (!flag(...killSwitches)) return null;

  const providerId = env('OIDC_PROVIDER_ID') ?? (legacy ? LEGACY_PROVIDER_ID : DEFAULT_PROVIDER_ID);
  if (!PROVIDER_ID_RE.test(providerId)) {
    throw new Error(
      `Invalid OIDC_PROVIDER_ID "${providerId}": must match ${PROVIDER_ID_RE} ` +
        '(it is used as a URL path segment in the OAuth callback).',
    );
  }

  return {
    providerId,
    providerName: env('OIDC_PROVIDER_NAME') ?? defaultProviderLabel(providerId, legacy),
    clientId,
    clientSecret,
    discoveryUrl,
    // better-auth defaults pkce to false; we default it on, since both Keycloak
    // and Authentik support it and servers that don't simply ignore the params.
    pkce: flag('OIDC_PKCE'),
    legacy,
  };
}

function defaultProviderLabel(providerId: string, legacy: boolean): string {
  if (legacy && providerId === LEGACY_PROVIDER_ID) return LEGACY_PROVIDER_LABEL;
  if (providerId === DEFAULT_PROVIDER_ID) return DEFAULT_PROVIDER_LABEL;
  return titleCase(providerId);
}

/**
 * The providers to render on the sign-in page, stripped of every secret.
 */
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

let warned = false;

/**
 * Log a single deprecation line for the pre-generic-OIDC variable names. Kept
 * out of the resolvers above so those stay pure; called once at startup.
 */
export function warnDeprecatedAuthEnv(): void {
  if (warned) return;

  const deprecated = [
    'AUTHENTIK_CLIENT_ID',
    'AUTHENTIK_CLIENT_SECRET',
    'AUTHENTIK_DISCOVERY_URL',
    'NEXT_PUBLIC_AUTHENTIK_ENABLED',
    'NEXT_PUBLIC_MICROSOFT_ENABLED',
    'NEXT_PUBLIC_EMAIL_PASSWORD_ENABLED',
  ].filter((name) => env(name) !== undefined);

  if (deprecated.length === 0) return;

  warned = true;
  console.warn(
    `[auth] Deprecated env vars in use: ${deprecated.join(', ')}. ` +
      'Use OIDC_CLIENT_ID / OIDC_CLIENT_SECRET / OIDC_DISCOVERY_URL / OIDC_ENABLED, ' +
      'MICROSOFT_ENABLED and EMAIL_PASSWORD_ENABLED instead. ' +
      'Set OIDC_PROVIDER_ID=authentik to keep your existing callback URL and accounts.',
  );
}

/** Test seam: allow the once-only deprecation warning to fire again. */
export function resetDeprecationWarning(): void {
  warned = false;
}
