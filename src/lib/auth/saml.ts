// SAML 2.0 login through the better-auth sso plugin, driven entirely by the config file
// (AUTH_CONFIG_FILE): the providers are `defaultSSO` entries, so there is no provider table
// and nothing a user can register at runtime (the plugin's provider endpoints are disabled
// in auth/index.ts).
//
// URLs of this installation, for the IdP's side of the setup (BASE = BETTER_AUTH_URL):
//   SP metadata   GET  BASE/api/auth/sso/saml2/sp/metadata?providerId=<id>
//   ACS (POST)    BASE/api/auth/sso/saml2/sp/acs/<id>
//   SP entity id  the metadata URL above, unless `spEntityId` is set
import type { SSOOptions } from '@better-auth/sso';
import type { SamlFileProvider } from './providers';

type DefaultSso = NonNullable<SSOOptions['defaultSSO']>[number];

const REDIRECT_BINDING = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';

/** `<BETTER_AUTH_URL>/api/auth`, the base every better-auth route hangs under; undefined without one. */
export function authBaseUrl(raw = process.env.BETTER_AUTH_URL): string | undefined {
  const base = raw?.trim().replace(/\/+$/, '');
  if (!base) return undefined;
  return base.endsWith('/api/auth') ? base : `${base}/api/auth`;
}

/** Entity id of this app as a service provider, for one provider entry. */
export function spEntityIdFor(p: SamlFileProvider, base = authBaseUrl()): string | undefined {
  if (p.spEntityId) return p.spEntityId;
  return base ? `${base}/sso/saml2/sp/metadata?providerId=${encodeURIComponent(p.id)}` : undefined;
}

/**
 * Attribute names whose values the login code needs besides the standard identity ones: the
 * role/group attributes (named by the config) and the optional identity extras. They are
 * delivered in `userInfo` under their own attribute name (roles/groups) or the whitelisted
 * claim name (upn, preferred_username), so authz/claims-roles.ts reads a SAML assertion
 * exactly like an OIDC claim set.
 */
function extraFields(p: SamlFileProvider): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const spec of [p.rolesClaim, p.groupsClaim]) if (spec) fields[spec.name] = spec.name;
  if (p.claims?.upn) fields.upn = p.claims.upn;
  if (p.claims?.preferredUsername) fields.preferred_username = p.claims.preferredUsername;
  return fields;
}

/** The sso plugin's `defaultSSO` entry for one SAML provider. */
export function defaultSsoFor(p: SamlFileProvider, base = authBaseUrl()): DefaultSso | null {
  const entityId = spEntityIdFor(p, base);
  // Without BETTER_AUTH_URL there is no stable SP entity id to give the IdP.
  if (!entityId) return null;
  const c = p.claims ?? {};
  const mapping = {
    ...(c.userId ? { id: c.userId } : {}),
    ...(c.email ? { email: c.email } : {}),
    ...(c.emailVerified ? { emailVerified: c.emailVerified } : {}),
    ...(c.name ? { name: c.name } : {}),
    ...(c.firstName ? { firstName: c.firstName } : {}),
    ...(c.lastName ? { lastName: c.lastName } : {}),
    extraFields: extraFields(p),
  };

  // One or several signing certificates (a rollover): samlify accepts a list, the plugin's type says string.
  const list = p.cert === undefined ? [] : [p.cert].flat();
  const certs = list.length > 1 ? list : list[0];
  return {
    // Only matched for e-mail-domain lookups, which this app never uses (sign-in always names the
    // provider); an unroutable name keeps it from ever matching a real address.
    domain: `${p.id}.saml.invalid`,
    providerId: p.id,
    samlConfig: {
      issuer: p.idpEntityId ?? entityId,
      entryPoint: p.entryPoint ?? '',
      cert: list[0] ?? '',
      // Empty: the plugin then uses its own ACS route for the metadata and the sign-in
      // return trip, and RelayState carries the page to land on.
      callbackUrl: '',
      ...(p.audience ? { audience: p.audience } : {}),
      idpMetadata: p.idpMetadata
        ? { metadata: p.idpMetadata }
        : {
            entityID: p.idpEntityId,
            cert: certs as string | undefined,
            singleSignOnService: [{ Binding: REDIRECT_BINDING, Location: p.entryPoint ?? '' }],
          },
      spMetadata: { entityID: entityId, ...(p.signingPrivateKey ? { privateKey: p.signingPrivateKey } : {}) },
      wantAssertionsSigned: p.wantAssertionsSigned,
      authnRequestsSigned: p.authnRequestsSigned,
      ...(p.signatureAlgorithm ? { signatureAlgorithm: p.signatureAlgorithm } : {}),
      ...(p.digestAlgorithm ? { digestAlgorithm: p.digestAlgorithm } : {}),
      ...(p.identifierFormat ? { identifierFormat: p.identifierFormat } : {}),
      mapping,
    },
  };
}

/** Called for every successful SAML login with the app user and the mapped assertion attributes. */
export type SamlLoginHook = (userId: string, providerId: string, userInfo: Record<string, unknown>) => Promise<void>;

/**
 * Options for the sso plugin. Hardened beyond its defaults: no runtime provider registration
 * (providersLimit 0), the e-mail-verified flag is never trusted, timestamps are required on
 * assertions (the library checks NotBefore / NotOnOrAfter with no tolerance: the host needs NTP),
 * deprecated signature algorithms are rejected, and the callback runs on EVERY login (not only the first) so that roles follow
 * the IdP. Returns null when no provider is usable.
 */
export function ssoPluginOptions(
  providers: SamlFileProvider[],
  onLogin: SamlLoginHook,
  base = authBaseUrl(),
): SSOOptions | null {
  const defaultSSO = providers.flatMap((p) => {
    // The ACS URL (and so the Recipient / Destination checks) is derived from BETTER_AUTH_URL, never from a request.
    const entry = base ? defaultSsoFor(p, base) : null;
    if (!entry) {
      console.warn('[auth] Ignoring a SAML provider: BETTER_AUTH_URL is not set, so there is no ACS URL / SP entity id.');
      return [];
    }
    return [entry];
  });
  if (defaultSSO.length === 0) return null;

  return {
    defaultSSO,
    providersLimit: 0,
    trustEmailVerified: false,
    provisionUserOnEveryLogin: true,
    provisionUser: async ({ user, userInfo, provider }) => {
      await onLogin(user.id, provider.providerId, userInfo);
    },
    saml: {
      requireTimestamps: true,
      // SHA-1 signatures (and RSA1_5 / 3DES) are rejected unless a provider opts out (installation-wide: one switch).
      algorithms: { onDeprecated: providers.some((p) => p.allowDeprecatedAlgorithms) ? 'warn' : 'reject' },
    },
  };
}

/**
 * Better-auth paths of the sso plugin that must stay closed because they manage providers in the
 * database. Passed to betterAuth({ disabledPaths }).
 */
export const SSO_DISABLED_PATHS = [
  '/sso/register',
  '/sso/providers',
  '/sso/get-provider',
  '/sso/update-provider',
  '/sso/delete-provider',
  '/sso/request-domain-verification',
  '/sso/verify-domain',
];

/** Route templates (as the hooks see them) that name a provider in `params.providerId` or `query.providerId`. */
const PROVIDER_PATHS = new Set([
  '/sign-in/sso',
  '/sso/saml2/callback/:providerId',
  '/sso/saml2/sp/acs/:providerId',
  '/sso/saml2/sp/slo/:providerId',
  '/sso/saml2/logout/:providerId',
  '/sso/saml2/sp/metadata',
]);

/**
 * True when a request on an sso route names a configured provider (or is not an sso route).
 * The plugin would otherwise look an unknown id up in a database table that does not exist
 * here; answering "not found" up front keeps that a clean 404 instead of an internal error.
 */
export function isKnownSsoRequest(
  ctx: { path?: string; params?: Record<string, unknown> | null; query?: Record<string, unknown> | null; body?: unknown },
  providerIds: readonly string[],
): boolean {
  if (!ctx.path || !PROVIDER_PATHS.has(ctx.path)) return true;
  const fromBody = (ctx.body as { providerId?: unknown } | null | undefined)?.providerId;
  const id = ctx.params?.providerId ?? ctx.query?.providerId ?? fromBody;
  return typeof id === 'string' && providerIds.includes(id);
}
