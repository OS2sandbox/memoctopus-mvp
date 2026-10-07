// The optional JSON file that configures identity providers and role claims per
// installation (AUTH_CONFIG_FILE), so a municipality can wire its own IdP without a
// code change or a rebuild. Reading and validating it is all this module does; which
// providers are actually enabled is decided in ./providers.ts.
//
//   {
//     "providers": [ { "type": "oidc" | "entra" | "saml", "id": "...", ... } ],
//     "roles":     { "appRoleMap": { "<claim value>": "tt-administrator" }, "groupRoleMap": { ... } },
//     "catalogue": [ { "kind": "role" | "group", "identifier": "...", "name": "..." } ]
//   }
//
// `${ENV_VAR}` in any string is replaced from process.env (so secrets stay out of the
// file). The file is read ONCE per process (a restart picks up an edit), so the server
// and the sign-in page can never disagree about it. Server-only, no @/lib/db.
//
// Failure policy, by section:
//  - a provider that is invalid (or references an unset ${VAR}, or an unreadable
//    metadata file) is skipped with a content-free warning: the other logins still work,
//    like a bad OIDC_PROVIDER_ID always did;
//  - `roles` that is invalid FAILS CLOSED: nobody gets a role from claims (a typo in a
//    security mapping must never widen or silently narrow access in an unknown way);
//  - `catalogue` that is invalid is dropped: no catalogue means no role/group values are
//    stored for anybody (privacy-minimising). Its state ('absent' | 'invalid' | 'ok') is
//    reported, so that authz/external-roles.ts never deactivates the stored catalogue because
//    of an unreadable file.
//
// Security rules enforced here (a provider that breaks one is skipped with a warning):
//  - every IdP URL is https (http only for a loopback host outside production);
//  - in production an oidc/saml provider needs BETTER_AUTH_URL to be a valid https URL;
//  - Entra needs ONE tenant (a GUID): "common" / "organizations" / "consumers" accept any
//    tenant of the world, and group GUIDs / app role names are only unique inside one;
//  - ACCESS_SOURCE=claims: an OIDC provider may not use a multi-tenant authority and must
//    give a discoveryUrl or issuer (the id token's `iss` is checked against it);
//  - `claims.userId` may not be a mutable, re-assignable attribute (e-mail, upn, name ...).
// Warnings name the section, the provider id or index and the field path, never a value.
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ROLE_KEYS, type RoleKey } from '@/lib/authz/types';
import { isHttpsOrLoopbackHttp } from '@/lib/net/url-policy';

// providerId ends up in the callback path and in accounts.provider_id, so it must be a
// safe URL segment. 'microsoft' is the id of the built-in Entra provider and may not be
// reused by another identity source (two sources writing one provider_id would cross-match).
export const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const ENTRA_PROVIDER_ID = 'microsoft';
/**
 * Ids no provider may take: 'microsoft' is the built-in Entra provider; 'credential' is
 * better-auth's e-mail/password account provider; 'password' and 'unknown' are the audit
 * log's method / provider placeholders. Two identity sources writing one accounts.provider_id
 * would cross-match, and a look-alike would be indistinguishable in the log.
 */
export const RESERVED_PROVIDER_IDS: readonly string[] = [ENTRA_PROVIDER_ID, 'credential', 'password', 'unknown'];

/** https, or http for a loopback host outside production (dev simulation, a local Keycloak). */
export function isAllowedIdpUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return isHttpsOrLoopbackHttp(u, process.env.NODE_ENV !== 'production');
}

/** ACCESS_SOURCE=claims, read straight from the environment (config.ts imports this module, not the other way round). */
export function claimsModeConfigured(): boolean {
  return (process.env.ACCESS_SOURCE ?? '').trim().toLowerCase() === 'claims';
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isGuid = (v: string): boolean => GUID_RE.test(v.trim());

/** Authorities of Microsoft's multi-tenant endpoints: any tenant can sign in through them. */
const MULTI_TENANT_PATH_RE = /\/(common|organizations|consumers)(\/|$)/i;
export function isMultiTenantAuthority(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    return MULTI_TENANT_PATH_RE.test(new URL(raw).pathname);
  } catch {
    return MULTI_TENANT_PATH_RE.test(raw);
  }
}

/** In production BETTER_AUTH_URL must be a valid https URL, or the redirect / ACS URLs are not safe to hand to an IdP. */
function baseUrlProblem(): string | null {
  if (process.env.NODE_ENV !== 'production') return null;
  const raw = process.env.BETTER_AUTH_URL?.trim();
  if (!raw) return 'BETTER_AUTH_URL is not set';
  try {
    const u = new URL(raw);
    return isHttpsOrLoopbackHttp(u, false) && u.hostname !== '' && !u.search && !u.hash ? null : 'BETTER_AUTH_URL is not a plain https URL';
  } catch {
    return 'BETTER_AUTH_URL is not a valid URL';
  }
}

/** Claim names that identify a person only by something an administrator can change or re-assign. */
const MUTABLE_USERID_CLAIMS = new Set(['email', 'mail', 'upn', 'preferred_username', 'name', 'email_verified']);

const nonEmpty = (max: number) => z.string().trim().min(1).max(max);
const urlString = z.string().trim().url().max(2048);
/** The `prompt` parameter an OIDC / Entra provider may send to the IdP. */
export const IDP_PROMPTS = ['login', 'select_account', 'consent'] as const;
export type IdpPrompt = (typeof IDP_PROMPTS)[number];

/** An IdP endpoint: https only (http for a loopback host outside production). */
const idpUrl = urlString.refine(isAllowedIdpUrl, { message: 'insecure_url' });

// ─── Claims ──────────────────────────────────────────────────────────────────

export interface ClaimListSpec {
  /** Claim (OIDC) or attribute (SAML) name; a dotted path is tried when the exact key is absent. */
  name: string;
  /** 'array': a JSON array (a lone string counts as one value). 'delimited': one string split on `separator`. */
  format: 'array' | 'delimited';
  separator: string;
}

const claimList = z
  .union([
    nonEmpty(512).transform((name): ClaimListSpec => ({ name, format: 'array', separator: ',' })),
    z
      .object({
        name: nonEmpty(512),
        format: z.enum(['array', 'delimited']).default('array'),
        separator: z.string().min(1).max(8).default(','),
      })
      .strict(),
  ])
  .optional();

/** Which claim names carry the identity fields. Defaults are the OIDC standard names. */
const claimMapping = z
  .object({
    email: nonEmpty(512).optional(),
    name: nonEmpty(512).optional(),
    /** The claim that identifies the person at this IdP (becomes the account id); default `sub`. */
    userId: nonEmpty(512).optional(),
    emailVerified: nonEmpty(512).optional(),
    firstName: nonEmpty(512).optional(),
    lastName: nonEmpty(512).optional(),
    /** SAML only: attributes copied into the whitelisted identity snapshot (OIDC tokens already carry them). */
    upn: nonEmpty(512).optional(),
    preferredUsername: nonEmpty(512).optional(),
  })
  .strict()
  .optional();

export type ClaimMapping = NonNullable<z.infer<typeof claimMapping>>;

// ─── Providers ───────────────────────────────────────────────────────────────

const providerId = z
  .string()
  .trim()
  .toLowerCase()
  .regex(PROVIDER_ID_RE)
  .refine((id) => !RESERVED_PROVIDER_IDS.includes(id), { message: 'reserved' });

const label = nonEmpty(60).optional();
const scopes = z.array(z.string().trim().regex(/^[^\s]{1,200}$/)).min(1).max(30);

const oidcSchema = z
  .object({
    type: z.literal('oidc'),
    id: providerId,
    label,
    enabled: z.boolean().default(true),
    clientId: nonEmpty(512),
    clientSecret: nonEmpty(4096),
    discoveryUrl: idpUrl.optional(),
    issuer: idpUrl.optional(),
    authorizationUrl: idpUrl.optional(),
    tokenUrl: idpUrl.optional(),
    userInfoUrl: idpUrl.optional(),
    scopes: scopes.default(['openid', 'profile', 'email']),
    pkce: z.boolean().default(true),
    /**
     * Sent as the `prompt` parameter. "login" forces a fresh sign-in at the IdP every time, which is what a shared
     * workstation needs (signing out of the app does not sign the person out of the IdP, see idp.md section 5).
     */
    prompt: z.enum(IDP_PROMPTS).optional(),
    /** Sent as `max_age` (seconds): the IdP must re-authenticate a person whose own session is older. 0 = always. */
    maxAge: z.number().int().min(0).max(86_400).optional(),
    claims: claimMapping,
    rolesClaim: claimList,
    groupsClaim: claimList,
  })
  .strict()
  .refine((p) => !!p.discoveryUrl || (!!p.authorizationUrl && !!p.tokenUrl), {
    message: 'needs discoveryUrl, or authorizationUrl and tokenUrl',
    path: ['discoveryUrl'],
  });

const entraSchema = z
  .object({
    type: z.literal('entra'),
    id: z.literal(ENTRA_PROVIDER_ID).default(ENTRA_PROVIDER_ID),
    label,
    enabled: z.boolean().default(true),
    clientId: nonEmpty(512),
    clientSecret: nonEmpty(4096),
    /**
     * The ONE tenant (a GUID) whose people may sign in. Required: "common" / "organizations" /
     * "consumers" let any tenant of the world in, and the group GUIDs and app role names that
     * carry the roles are only unique inside a tenant.
     */
    tenantId: z
      .string()
      .trim()
      .refine(isGuid, { message: 'tenant_guid_required' })
      .transform((v) => v.toLowerCase()),
    /** Extra scopes. openid, profile and email are always requested; offline_access is never (no refresh token is kept). */
    scopes: scopes.optional(),
    prompt: z.enum(IDP_PROMPTS).optional(),
    rolesClaim: claimList,
    groupsClaim: claimList,
  })
  .strict();

const samlSchema = z
  .object({
    type: z.literal('saml'),
    id: providerId,
    label,
    enabled: z.boolean().default(true),
    /** IdP metadata XML read from this file (preferred: carries endpoints, entity id and certificate). */
    idpMetadataFile: nonEmpty(1024).optional(),
    idpMetadataXml: z.string().trim().min(1).max(500_000).optional(),
    /** Without metadata: the IdP's single-sign-on URL, entity id and PEM signing certificate. */
    entryPoint: idpUrl.optional(),
    idpEntityId: nonEmpty(1024).optional(),
    /** PEM signing certificate; a list during a certificate rollover (any of them verifies). */
    cert: z.union([z.string().trim().min(1).max(20_000), z.array(z.string().trim().min(1).max(20_000)).min(1).max(5)]).optional(),
    /** Our entity id (SP); default: the metadata URL of this installation for this provider. */
    spEntityId: nonEmpty(1024).optional(),
    audience: nonEmpty(1024).optional(),
    /**
     * Cosmetic: passed to the SAML library, but an UNSIGNED response is refused whatever this says
     * (saml.flow.test.ts proves it). `false` is only logged as a warning. Leave it out.
     */
    wantAssertionsSigned: z.boolean().default(true),
    authnRequestsSigned: z.boolean().default(false),
    /**
     * Accept a response that answers no AuthnRequest of ours (login started at the IdP's portal). Default FALSE:
     * an IdP-initiated response cannot be tied to a browser that started a login here, so it is login-CSRF
     * material. With false, every response must carry a SIGNED InResponseTo that answers a request this app issued.
     */
    allowIdpInitiated: z.boolean().default(false),
    /**
     * Accept responses signed with SHA-1 (and RSA1_5 / 3DES). Default false: they are rejected. The escape is
     * installation-wide (the plugin has one switch): if any SAML provider sets it, all of them warn instead of reject.
     */
    allowDeprecatedAlgorithms: z.boolean().default(false),
    /** PEM private key used to sign AuthnRequests (only with authnRequestsSigned). */
    signingPrivateKey: z.string().trim().min(1).max(20_000).optional(),
    signatureAlgorithm: nonEmpty(200).optional(),
    digestAlgorithm: nonEmpty(200).optional(),
    identifierFormat: nonEmpty(200).optional(),
    claims: claimMapping,
    rolesClaim: claimList,
    groupsClaim: claimList,
  })
  .strict()
  .refine((p) => !!p.idpMetadataFile || !!p.idpMetadataXml || (!!p.entryPoint && !!p.idpEntityId && !!p.cert), {
    message: 'needs idpMetadataFile, idpMetadataXml, or entryPoint + idpEntityId + cert',
    path: ['idpMetadataFile'],
  })
  .refine((p) => !p.authnRequestsSigned || !!p.signingPrivateKey, {
    message: 'authnRequestsSigned needs signingPrivateKey',
    path: ['signingPrivateKey'],
  });

export type OidcFileProvider = z.infer<typeof oidcSchema>;
export type EntraFileProvider = z.infer<typeof entraSchema>;
export type SamlFileProvider = z.infer<typeof samlSchema> & { idpMetadata?: string };
export type FileProvider = OidcFileProvider | EntraFileProvider | SamlFileProvider;

// Picked by hand rather than z.discriminatedUnion: two of the three carry refinements, and a
// per-type schema also gives a precise warning ("unknown type") instead of a union error.
const PROVIDER_SCHEMAS = { oidc: oidcSchema, entra: entraSchema, saml: samlSchema } as const;

// ─── Roles and catalogue ─────────────────────────────────────────────────────

const roleKey = z.enum(ROLE_KEYS);
const roleMapEntry = z.union([
  roleKey.transform((role) => ({ role, global: true })),
  z.object({ role: roleKey, global: z.boolean().default(true) }).strict(),
]);
const roleMap = z.record(nonEmpty(512), roleMapEntry).refine((m) => Object.keys(m).length <= 500, 'too many entries');

const providerRoleMaps = z
  .object({
    /** Values of the provider's `rolesClaim` -> app role. */
    appRoleMap: roleMap.default({}),
    /** Values of the provider's `groupsClaim` -> app role. */
    groupRoleMap: roleMap.default({}),
  })
  .strict();

const rolesSchema = z
  .object({
    /** Fallback maps, used only when the file has exactly ONE provider (see RolesConfig). */
    appRoleMap: roleMap.default({}),
    groupRoleMap: roleMap.default({}),
    /** Maps per provider id; a provider listed here uses ONLY its own maps. */
    byProvider: z
      .record(z.string().trim().toLowerCase().regex(PROVIDER_ID_RE), providerRoleMaps)
      .default({}),
  })
  .strict();

const catalogueEntry = z
  .object({
    kind: z.enum(['role', 'group']),
    identifier: nonEmpty(200),
    name: nonEmpty(200),
    /**
     * Provider ids whose claim values this entry belongs to. Absent = every provider. With it, a login through
     * another provider that happens to carry the same value stores nothing, so provider B's values never match
     * a prompt target meant for provider A.
     */
    providers: z.array(z.string().trim().toLowerCase().regex(PROVIDER_ID_RE)).min(1).max(20).optional(),
  })
  .strict();
const catalogueSchema = z.array(catalogueEntry).max(5000);

export interface RoleMapping {
  role: RoleKey;
  /** Claims carry no org unit, so a claim role can only ever be global. `global: false` disables the entry. */
  global: boolean;
}

export interface ProviderRoleMaps {
  appRoleMap: ReadonlyMap<string, RoleMapping>;
  groupRoleMap: ReadonlyMap<string, RoleMapping>;
}

export type RolesConfig =
  | { state: 'unset' }
  | { state: 'invalid' }
  | ({
      state: 'ok';
      /**
       * The global maps. They apply to a provider without its own `byProvider` entry ONLY when the file has exactly one
       * provider (`providerCount`, absent = 1): with several providers, one provider's role names must not grant
       * roles through another.
       */
      byProvider?: ReadonlyMap<string, ProviderRoleMaps>;
      providerCount?: number;
    } & ProviderRoleMaps);

export interface CatalogueEntry {
  kind: 'role' | 'group';
  identifier: string;
  name: string;
  /** Provider ids this entry is for; absent = all. */
  providers?: string[];
}

/** 'absent': no catalogue section (or no config file). 'invalid': there is one, but it could not be used. */
export type CatalogueState = 'absent' | 'invalid' | 'ok';

export interface LoadedAuthConfig {
  /** AUTH_CONFIG_FILE is set (even if it turned out to be unusable): legacy env providers then stay off. */
  configured: boolean;
  providers: FileProvider[];
  roles: RolesConfig;
  catalogue: CatalogueEntry[];
  catalogueState: CatalogueState;
}

const NOT_CONFIGURED: LoadedAuthConfig = {
  configured: false,
  providers: [],
  roles: { state: 'unset' },
  catalogue: [],
  catalogueState: 'absent',
};
const UNUSABLE: LoadedAuthConfig = {
  configured: true,
  providers: [],
  roles: { state: 'invalid' },
  catalogue: [],
  catalogueState: 'invalid',
};

// ─── ${ENV} expansion ────────────────────────────────────────────────────────

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Expands ${NAME} in every string of a JSON value. Names that are unset (or blank) are collected, not echoed as values. */
function expandEnv(value: unknown, missing: Set<string>): unknown {
  if (typeof value === 'string') {
    return value.replace(ENV_REF, (_m, name: string) => {
      const v = process.env[name];
      if (v === undefined || v.trim() === '') {
        missing.add(name);
        return '';
      }
      return v;
    });
  }
  if (Array.isArray(value)) return value.map((v) => expandEnv(v, missing));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandEnv(v, missing)]));
  }
  return value;
}

/** Zod issues as `path:code` pairs: never the offending value (it may be a secret). */
function issueSummary(err: z.ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}:${i.code}`)
    .join(', ');
}

function warn(message: string): void {
  console.warn(`[auth] ${message}`);
}

// ─── Loading ─────────────────────────────────────────────────────────────────

function readJsonFile(path: string): unknown | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function parseProvider(raw: unknown, index: number, seen: Set<string>): FileProvider | null {
  const where = `providers[${index}]`;
  const missing = new Set<string>();
  const expanded = expandEnv(raw, missing);
  if (missing.size > 0) {
    warn(`Ignoring ${where}: environment variable(s) not set: ${[...missing].join(', ')}.`);
    return null;
  }
  const type = (expanded as { type?: unknown } | null)?.type;
  if (typeof type !== 'string' || !Object.hasOwn(PROVIDER_SCHEMAS, type)) {
    warn(`Ignoring ${where}: "type" must be one of ${Object.keys(PROVIDER_SCHEMAS).join(', ')}.`);
    return null;
  }
  const parsed = PROVIDER_SCHEMAS[type as keyof typeof PROVIDER_SCHEMAS].safeParse(expanded);
  if (!parsed.success) {
    warn(`Ignoring ${where}: invalid (${issueSummary(parsed.error)}).`);
    return null;
  }
  const provider = parsed.data as FileProvider;
  if (provider.enabled === false) return null;
  if (seen.has(provider.id)) {
    warn(`Ignoring ${where}: the id is already used by another provider.`);
    return null;
  }

  if (provider.type !== 'entra') {
    const problem = baseUrlProblem();
    if (problem) {
      warn(`Ignoring ${where}: ${problem}; an OIDC or SAML provider needs the public https URL of this installation in production.`);
      return null;
    }
  }

  if (provider.type === 'oidc') {
    // The userId claim is the account key: it must never be something that can be edited or re-assigned.
    if (provider.claims?.userId && MUTABLE_USERID_CLAIMS.has(provider.claims.userId.trim().toLowerCase())) {
      warn(`Ignoring ${where}: claims.userId must be a stable identifier (sub, oid, ...), not an address or a name.`);
      return null;
    }
    if (claimsModeConfigured()) {
      const urls = [provider.discoveryUrl, provider.issuer, provider.authorizationUrl, provider.tokenUrl, provider.userInfoUrl];
      if (urls.some(isMultiTenantAuthority)) {
        warn(`Ignoring ${where}: a multi-tenant authority (common / organizations / consumers) cannot be used with ACCESS_SOURCE=claims; use the tenant-specific URL.`);
        return null;
      }
      if (!provider.discoveryUrl && !provider.issuer) {
        warn(`Ignoring ${where}: with ACCESS_SOURCE=claims the provider needs discoveryUrl or issuer (the id token issuer is checked against it).`);
        return null;
      }
    }
  }

  if (provider.type === 'saml') {
    // The metadata file is read here, once, so a missing file disables just this provider.
    if (provider.idpMetadataFile) {
      try {
        provider.idpMetadata = readFileSync(provider.idpMetadataFile, 'utf8');
      } catch {
        warn(`Ignoring ${where}: idpMetadataFile could not be read.`);
        return null;
      }
    } else if (provider.idpMetadataXml) {
      provider.idpMetadata = provider.idpMetadataXml;
    }
    // The endpoints inside the metadata are IdP URLs too.
    if (provider.idpMetadata) {
      const locations = [...provider.idpMetadata.matchAll(/\bLocation\s*=\s*["']([^"']*)["']/g)].map((m) => m[1].replaceAll('&amp;', '&'));
      if (locations.some((l) => !isAllowedIdpUrl(l))) {
        warn(`Ignoring ${where}: the IdP metadata has an endpoint that is not https.`);
        return null;
      }
    }
    if (provider.claims?.userId && provider.claims.email && provider.claims.userId.trim().toLowerCase() === provider.claims.email.trim().toLowerCase()) {
      warn(`${where}: claims.userId is the same attribute as claims.email; an address can be re-assigned to another person at the IdP. Use a stable identifier.`);
    }
    if (!provider.wantAssertionsSigned) {
      warn(`${where}: wantAssertionsSigned is false; it has no effect, unsigned SAML responses are always refused.`);
    }
    if (provider.allowDeprecatedAlgorithms) {
      warn(`${where}: allowDeprecatedAlgorithms is on; responses signed with SHA-1 are accepted for ALL SAML providers. Ask the IdP for SHA-256.`);
    }
    if (provider.allowIdpInitiated) {
      warn(`${where}: allowIdpInitiated is on; a response that answers no request of this app is accepted (login CSRF). Prefer false.`);
    }
  }
  seen.add(provider.id);
  return provider;
}

function parseRoles(raw: unknown, providerIds: readonly string[]): RolesConfig {
  if (raw === undefined) return { state: 'unset' };
  const missing = new Set<string>();
  const expanded = expandEnv(raw, missing);
  if (missing.size > 0) {
    warn(`roles section is unusable (environment variable(s) not set: ${[...missing].join(', ')}); no roles will be granted from claims.`);
    return { state: 'invalid' };
  }
  const parsed = rolesSchema.safeParse(expanded);
  if (!parsed.success) {
    warn(`roles section is invalid (${issueSummary(parsed.error)}); no roles will be granted from claims.`);
    return { state: 'invalid' };
  }
  const toMap = (m: Record<string, RoleMapping>) =>
    new Map(Object.entries(m).filter(([, v]) => v.global));
  const byProvider = new Map<string, ProviderRoleMaps>();
  for (const [id, maps] of Object.entries(parsed.data.byProvider)) {
    if (!providerIds.includes(id)) {
      // Not fatal (the provider may just be disabled), and it grants nothing: only the named provider reads this entry.
      warn('roles.byProvider names a provider id that is not configured; that entry is unused.');
    }
    byProvider.set(id, { appRoleMap: toMap(maps.appRoleMap), groupRoleMap: toMap(maps.groupRoleMap) });
  }
  const globalMaps = { appRoleMap: toMap(parsed.data.appRoleMap), groupRoleMap: toMap(parsed.data.groupRoleMap) };
  if (providerIds.length > 1 && (globalMaps.appRoleMap.size > 0 || globalMaps.groupRoleMap.size > 0)) {
    warn('roles.appRoleMap / groupRoleMap apply to a single provider only; with several providers use roles.byProvider.<id>. A provider without its own map grants no roles.');
  }
  return { state: 'ok', ...globalMaps, byProvider, providerCount: providerIds.length };
}

function parseCatalogue(raw: unknown): { entries: CatalogueEntry[]; state: CatalogueState } {
  if (raw === undefined) return { entries: [], state: 'absent' };
  const missing = new Set<string>();
  const parsed = catalogueSchema.safeParse(expandEnv(raw, missing));
  if (missing.size > 0 || !parsed.success) {
    warn(`catalogue section is invalid${parsed.success ? '' : ` (${issueSummary(parsed.error)})`}; it is ignored.`);
    return { entries: [], state: 'invalid' };
  }
  // Duplicate (kind, identifier): the first entry wins.
  const seen = new Set<string>();
  const entries = parsed.data.filter((e) => {
    const key = `${e.kind}\u0000${e.identifier}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { entries, state: 'ok' };
}

function loadFile(path: string): LoadedAuthConfig {
  const json = readJsonFile(path);
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    warn('AUTH_CONFIG_FILE could not be read or is not a JSON object; no providers from it and no roles from claims.');
    return UNUSABLE;
  }
  const top = json as Record<string, unknown>;

  const known = new Set(['providers', 'roles', 'catalogue']);
  const unknownKeys = Object.keys(top).filter((k) => !known.has(k));
  if (unknownKeys.length > 0) {
    warn(`AUTH_CONFIG_FILE has unknown top-level key(s): ${unknownKeys.map((k) => (/^[A-Za-z0-9_-]{1,40}$/.test(k) ? k : '?')).join(', ')}; no roles will be granted from claims.`);
  }

  const providers: FileProvider[] = [];
  if (top.providers !== undefined) {
    if (!Array.isArray(top.providers)) {
      warn('AUTH_CONFIG_FILE "providers" must be an array; no providers from it.');
    } else {
      const seen = new Set<string>();
      top.providers.forEach((raw, i) => {
        const p = parseProvider(raw, i, seen);
        if (p) providers.push(p);
      });
    }
  }
  // A misspelt "roles" would otherwise silently mean "no role mapping": fail closed instead.
  const roles: RolesConfig =
    unknownKeys.length > 0
      ? { state: 'invalid' }
      : parseRoles(top.roles, providers.map((p) => p.id));
  const catalogue = parseCatalogue(top.catalogue);
  return { configured: true, providers, roles, catalogue: catalogue.entries, catalogueState: catalogue.state };
}

let cache: { path: string; value: LoadedAuthConfig } | null = null;

/** The path in AUTH_CONFIG_FILE, or undefined (blank counts as unset). */
export function authConfigFilePath(): string | undefined {
  return process.env.AUTH_CONFIG_FILE?.trim() || undefined;
}

/** Loads (once per process and path) and validates AUTH_CONFIG_FILE. Never throws. */
export function loadAuthConfig(): LoadedAuthConfig {
  const path = authConfigFilePath();
  if (!path) return NOT_CONFIGURED;
  if (cache?.path === path) return cache.value;
  let value: LoadedAuthConfig;
  try {
    value = loadFile(path);
  } catch {
    warn('AUTH_CONFIG_FILE could not be processed; no providers from it and no roles from claims.');
    value = UNUSABLE;
  }
  cache = { path, value };
  return value;
}

/** Test seam: forget the per-process cache. */
export function resetAuthConfigCache(): void {
  cache = null;
}
