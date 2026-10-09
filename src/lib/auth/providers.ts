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
// Where the providers come from: the JSON file named by AUTH_CONFIG_FILE (any number
// of OIDC providers, Entra and SAML, see ./config-file.ts), or — when no file is
// configured — the legacy OIDC_* / MICROSOFT_* / AUTHENTIK_* variables, which are
// synthesised into the same shapes. A configured file replaces the variables entirely.
//
// Server-only: must not import @/lib/db (it opens a pg.Pool at module scope).
import {
  PROVIDER_ID_RE,
  RESERVED_PROVIDER_IDS,
  authConfigFilePath,
  claimsModeConfigured,
  isGuid,
  loadAuthConfig,
  type CatalogueEntry,
  type CatalogueState,
  type ClaimListSpec,
  type ClaimMapping,
  type IdpPrompt,
  type RolesConfig,
  type SamlFileProvider,
} from './config-file';
import type { EntraProviderConfig } from './oidc-config';
import { authBaseUrl } from './saml';

export type { CatalogueEntry, CatalogueState, ClaimListSpec, ClaimMapping, RolesConfig, SamlFileProvider };

/** Crosses the server→client boundary as a prop — must carry no secrets. */
export type AuthProvider =
  | { kind: 'social'; id: 'microsoft'; label: string }
  | { kind: 'oauth2'; id: string; label: string }
  // SAML (and any other better-auth sso provider): signed in with signIn.sso({ providerId }).
  | { kind: 'sso'; id: string; label: string };

/** A fully resolved generic OIDC provider (from the config file or the legacy variables). */
export interface OidcProviderConfig {
  providerId: string;
  providerName: string;
  clientId: string;
  clientSecret: string;
  discoveryUrl?: string;
  issuer?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  userInfoUrl?: string;
  scopes: string[];
  pkce: boolean;
  /** `prompt` / `max_age` sent to the IdP (session hygiene on shared workstations). */
  prompt?: IdpPrompt;
  maxAge?: number;
  claims: ClaimMapping;
  rolesClaim?: ClaimListSpec;
  groupsClaim?: ClaimListSpec;
}

/** Which claims carry roles/groups for a login method; absent entries mean "not configured". */
export interface ProviderClaimSpecs {
  claims: ClaimMapping;
  rolesClaim?: ClaimListSpec;
  groupsClaim?: ClaimListSpec;
}

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
// path segment. Reusing a built-in provider's id ('microsoft', 'credential') or an
// audit placeholder ('password', 'unknown') would make two identity sources
// cross-match or look alike: see RESERVED_PROVIDER_IDS in ./config-file.

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

/**
 * E-mail/password sign-in. In claims mode the roles come from the IdP and a password account
 * holds none, so an open sign-up form would let anybody create a (role-less) account and
 * reach whatever the baseline allows: it is OFF there unless EMAIL_PASSWORD_ENABLED is
 * EXPLICITLY "true" (and even then sign-up stays disabled, see emailPasswordSignUpDisabled).
 */
export function emailPasswordEnabled(): boolean {
  if (claimsModeConfigured()) {
    const explicit = env('EMAIL_PASSWORD_ENABLED') ?? env(DEPRECATED_FLAGS.EMAIL_PASSWORD_ENABLED);
    return explicit?.toLowerCase() === 'true';
  }
  return flag('EMAIL_PASSWORD_ENABLED', DEPRECATED_FLAGS.EMAIL_PASSWORD_ENABLED);
}

/** Claims mode never lets people register a password account (existing ones, if any, can still sign in). */
export function emailPasswordSignUpDisabled(): boolean {
  return claimsModeConfigured();
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
export function microsoftConfig(): EntraProviderConfig | null {
  const file = loadAuthConfig();
  if (file.configured) {
    const entra = file.providers.find((p) => p.type === 'entra');
    return entra?.type === 'entra'
      ? {
          clientId: entra.clientId,
          clientSecret: entra.clientSecret,
          tenantId: entra.tenantId,
          ...(entra.scopes ? { scopes: entra.scopes } : {}),
          ...(entra.prompt ? { prompt: entra.prompt } : {}),
        }
      : null;
  }

  const clientId = env('MICROSOFT_CLIENT_ID');
  const clientSecret = env('MICROSOFT_CLIENT_SECRET');
  if (!clientId || !clientSecret) return null;
  if (!flag('MICROSOFT_ENABLED')) return null;

  // ACCESS_SOURCE=claims: a multi-tenant authority would let any tenant's people (and their
  // self-assigned roles) in. The legacy variables carry no role mapping, but keep the rule uniform.
  const tenantId = env('MICROSOFT_TENANT_ID') || 'common';
  if (claimsModeConfigured() && !isGuid(tenantId)) {
    console.warn('[auth] Ignoring Microsoft login: ACCESS_SOURCE=claims needs MICROSOFT_TENANT_ID to be one tenant id (a GUID), not common / organizations / consumers.');
    return null;
  }
  return { clientId, clientSecret, tenantId };
}

/** The Entra tenant id as configured (file or MICROSOFT_TENANT_ID), enabled or not; undefined when none. */
export function microsoftTenantId(): string | undefined {
  const file = loadAuthConfig();
  if (file.configured) {
    const entra = file.providers.find((p) => p.type === 'entra');
    return entra?.type === 'entra' ? entra.tenantId : undefined;
  }
  return env('MICROSOFT_TENANT_ID');
}

/**
 * The generic OIDC provider of the LEGACY variables — Keycloak, Authentik, or any
 * compliant IdP. oidcProviders() is what the rest of the app uses; it falls back to this
 * when no AUTH_CONFIG_FILE is configured.
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

/** Every enabled OIDC provider: the config file's, or the one the legacy variables describe. */
export function oidcProviders(): OidcProviderConfig[] {
  const file = loadAuthConfig();
  if (file.configured) {
    return file.providers.flatMap((p): OidcProviderConfig[] =>
      p.type === 'oidc'
        ? [
            {
              providerId: p.id,
              providerName: p.label ?? defaultProviderLabel(p.id),
              clientId: p.clientId,
              clientSecret: p.clientSecret,
              discoveryUrl: p.discoveryUrl,
              issuer: p.issuer,
              authorizationUrl: p.authorizationUrl,
              tokenUrl: p.tokenUrl,
              userInfoUrl: p.userInfoUrl,
              scopes: p.scopes,
              pkce: p.pkce,
              ...(p.prompt ? { prompt: p.prompt } : {}),
              ...(p.maxAge !== undefined ? { maxAge: p.maxAge } : {}),
              claims: p.claims ?? {},
              rolesClaim: p.rolesClaim,
              groupsClaim: p.groupsClaim,
            },
          ]
        : [],
    );
  }
  const legacy = oidcConfig();
  return legacy
    ? [{ ...legacy, scopes: ['openid', 'profile', 'email'], claims: {} }]
    : [];
}

/** Every enabled SAML provider from the config file (there is no legacy variable form). */
export function samlProviders(): SamlFileProvider[] {
  return loadAuthConfig().providers.flatMap((p) => (p.type === 'saml' ? [p] : []));
}

/** Claim mapping and role/group claim names for one login method; null for an unknown id or legacy variables. */
export function providerClaimSpecs(providerId: string): ProviderClaimSpecs | null {
  const p = loadAuthConfig().providers.find((x) => x.id === providerId);
  if (!p) return null;
  return {
    claims: p.type === 'entra' ? {} : (p.claims ?? {}),
    rolesClaim: p.rolesClaim,
    groupsClaim: p.groupsClaim,
  };
}

/** The `roles` section (claim value -> app role). 'invalid' means grant nothing; 'unset' means no mapping. */
export function authRolesConfig(): RolesConfig {
  return loadAuthConfig().roles;
}

/** The `catalogue` section: role/group values that may be stored for a user (and targeted by prompts). */
export function authConfigCatalogue(): CatalogueEntry[] {
  return loadAuthConfig().catalogue;
}

/** 'absent' (no section / no file), 'invalid' (there is one but it is unusable: never act on it) or 'ok'. */
export function authConfigCatalogueState(): CatalogueState {
  return loadAuthConfig().catalogueState;
}

export function enabledAuthProviders(): AuthProvider[] {
  const providers: AuthProvider[] = [];

  const microsoft = microsoftConfig();
  if (microsoft) {
    const label = loadAuthConfig().providers.find((p) => p.type === 'entra')?.label;
    providers.push({ kind: 'social', id: 'microsoft', label: label ?? 'Microsoft' });
  }

  for (const oidc of oidcProviders()) {
    providers.push({ kind: 'oauth2', id: oidc.providerId, label: oidc.providerName });
  }

  // The SAML plugin skips every provider while BETTER_AUTH_URL is unset (it has no ACS URL to give
  // the IdP); a button for one would lead to a 404, so the sign-in page must not offer it.
  for (const saml of authBaseUrl() ? samlProviders() : []) {
    providers.push({ kind: 'sso', id: saml.id, label: saml.label ?? defaultProviderLabel(saml.id) });
  }

  return providers;
}

/** Called once at startup from auth/index.ts. */
export function warnDeprecatedAuthEnv(): void {
  if (authConfigFilePath()) {
    // The file replaces the variables; say so, or an operator keeps editing .env in vain.
    const ignored = [
      'OIDC_CLIENT_ID',
      'OIDC_CLIENT_SECRET',
      'OIDC_DISCOVERY_URL',
      'MICROSOFT_CLIENT_ID',
      'MICROSOFT_CLIENT_SECRET',
      ...DEPRECATED_CREDENTIALS,
    ].filter((name) => env(name) !== undefined);
    if (ignored.length > 0) {
      console.warn(`[auth] AUTH_CONFIG_FILE is set, so these variables are ignored: ${ignored.join(', ')}.`);
    }
    return;
  }
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
