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
//    stored for anybody (privacy-minimising).
// Warnings name the section, the provider id or index and the field path, never a value.
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ROLE_KEYS, type RoleKey } from '@/lib/authz/types';

// providerId ends up in the callback path and in accounts.provider_id, so it must be a
// safe URL segment. 'microsoft' is the id of the built-in Entra provider and may not be
// reused by another identity source (two sources writing one provider_id would cross-match).
export const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const ENTRA_PROVIDER_ID = 'microsoft';

const nonEmpty = (max: number) => z.string().trim().min(1).max(max);
const urlString = z.string().trim().url().max(2048);

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
  .refine((id) => id !== ENTRA_PROVIDER_ID, { message: 'reserved' });

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
    discoveryUrl: urlString.optional(),
    issuer: urlString.optional(),
    authorizationUrl: urlString.optional(),
    tokenUrl: urlString.optional(),
    userInfoUrl: urlString.optional(),
    scopes: scopes.default(['openid', 'profile', 'email']),
    pkce: z.boolean().default(true),
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
    /** One tenant id; "common" / "organizations" / "consumers" accept any tenant. */
    tenantId: nonEmpty(200).default('common'),
    scopes: scopes.optional(),
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
    entryPoint: urlString.optional(),
    idpEntityId: nonEmpty(1024).optional(),
    cert: z.string().trim().min(1).max(20_000).optional(),
    /** Our entity id (SP); default: the metadata URL of this installation for this provider. */
    spEntityId: nonEmpty(1024).optional(),
    audience: nonEmpty(1024).optional(),
    /** Require the IdP to sign the assertion. Default true; turning it off is a conscious, logged choice. */
    wantAssertionsSigned: z.boolean().default(true),
    authnRequestsSigned: z.boolean().default(false),
    /** Accept a response that answers no AuthnRequest of ours (login started at the IdP's portal). Default true. */
    allowIdpInitiated: z.boolean().default(true),
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

const rolesSchema = z
  .object({
    /** Values of the provider's `rolesClaim` -> app role. */
    appRoleMap: roleMap.default({}),
    /** Values of the provider's `groupsClaim` -> app role. */
    groupRoleMap: roleMap.default({}),
  })
  .strict();

const catalogueEntry = z
  .object({
    kind: z.enum(['role', 'group']),
    identifier: nonEmpty(200),
    name: nonEmpty(200),
  })
  .strict();
const catalogueSchema = z.array(catalogueEntry).max(5000);

export interface RoleMapping {
  role: RoleKey;
  /** Claims carry no org unit, so a claim role can only ever be global. `global: false` disables the entry. */
  global: boolean;
}

export type RolesConfig =
  | { state: 'unset' }
  | { state: 'invalid' }
  | { state: 'ok'; appRoleMap: ReadonlyMap<string, RoleMapping>; groupRoleMap: ReadonlyMap<string, RoleMapping> };

export interface CatalogueEntry {
  kind: 'role' | 'group';
  identifier: string;
  name: string;
}

export interface LoadedAuthConfig {
  /** AUTH_CONFIG_FILE is set (even if it turned out to be unusable): legacy env providers then stay off. */
  configured: boolean;
  providers: FileProvider[];
  roles: RolesConfig;
  catalogue: CatalogueEntry[];
}

const NOT_CONFIGURED: LoadedAuthConfig = { configured: false, providers: [], roles: { state: 'unset' }, catalogue: [] };

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
    if (!provider.wantAssertionsSigned) {
      warn(`${where}: wantAssertionsSigned is false; unsigned SAML assertions will be accepted. Do not use this in production.`);
    }
  }
  seen.add(provider.id);
  return provider;
}

function parseRoles(raw: unknown): RolesConfig {
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
  return { state: 'ok', appRoleMap: toMap(parsed.data.appRoleMap), groupRoleMap: toMap(parsed.data.groupRoleMap) };
}

function parseCatalogue(raw: unknown): CatalogueEntry[] {
  if (raw === undefined) return [];
  const missing = new Set<string>();
  const parsed = catalogueSchema.safeParse(expandEnv(raw, missing));
  if (missing.size > 0 || !parsed.success) {
    warn(`catalogue section is invalid${parsed.success ? '' : ` (${issueSummary(parsed.error)})`}; it is ignored.`);
    return [];
  }
  // Duplicate (kind, identifier): the first entry wins.
  const seen = new Set<string>();
  return parsed.data.filter((e) => {
    const key = `${e.kind}\u0000${e.identifier}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function loadFile(path: string): LoadedAuthConfig {
  const json = readJsonFile(path);
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    warn('AUTH_CONFIG_FILE could not be read or is not a JSON object; no providers from it and no roles from claims.');
    return { configured: true, providers: [], roles: { state: 'invalid' }, catalogue: [] };
  }
  const top = json as Record<string, unknown>;

  const known = new Set(['providers', 'roles', 'catalogue']);
  const unknownKeys = Object.keys(top).filter((k) => !known.has(k));
  // A misspelt "roles" would otherwise silently mean "no role mapping": fail closed instead.
  const roles: RolesConfig = unknownKeys.length > 0 ? { state: 'invalid' } : parseRoles(top.roles);
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
  return { configured: true, providers, roles, catalogue: parseCatalogue(top.catalogue) };
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
    value = { configured: true, providers: [], roles: { state: 'invalid' }, catalogue: [] };
  }
  cache = { path, value };
  return value;
}

/** Test seam: forget the per-process cache. */
export function resetAuthConfigCache(): void {
  cache = null;
}
