// Rollekatalog integration settings. Read from process.env at CALL time (same
// idiom as src/lib/auth/providers.ts) so an operator can change .env and restart
// without a rebuild. Never NEXT_PUBLIC_*. Nothing here throws: an invalid value
// falls back to the safe default so a typo cannot take the app down. The one
// exception to "typos fall back" is ACCESS_SOURCE (src/lib/authz/config.ts), which
// is the mode switch itself and throws ConfigError when invalid; every Rollekatalog
// entry point (sync routes, directory match, principal) checks it first.
import { ROLE_KEYS, type RoleKey } from '@/lib/authz/types';

export type UserIdTransform = 'none' | 'strip-upn-domain';

const DEFAULT_ITSYSTEM_ID = 'os2taletiltekst';
/**
 * Per attempt, body included. Every client call is a bulk call (organisation v3 can
 * be tens of MB and is synchronized on the Rollekatalog side), so the default is 2 minutes.
 */
const DEFAULT_TIMEOUT_MS = 120_000;
/**
 * Upper bound. undici's default headersTimeout is 300 s: a longer ROLLEKATALOG_TIMEOUT_MS
 * could never be reached, the wait would end in a (retried) `network` error instead.
 */
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_SYNC_MAX_REMOVAL_PERCENT = 30;
const DEFAULT_ROLE_STALE_MAX_SECONDS = 86_400;
/**
 * Default response size cap for the bulk endpoints (organisation v3 carries every
 * user with positions and KLE lists). 64 MiB covers a very large municipality;
 * ROLLEKATALOG_MAX_RESPONSE_BYTES overrides it.
 */
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export type RollekatalogConfigIssue = 'not_configured' | 'insecure_url';

function clean(name: string): string {
  return (process.env[name] ?? '').trim();
}

function boolFlag(name: string, fallback: boolean): boolean {
  const v = clean(name).toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return fallback;
}

function intInRange(name: string, fallback: number, min: number, max: number): number {
  const raw = clean(name);
  if (!/^\d+$/.test(raw)) return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export type RollekatalogUrl = { url: string; issue: null } | { url: null; issue: RollekatalogConfigIssue };

/**
 * Validates a base URL: https, or http only for a loopback host or when
 * ROLLEKATALOG_ALLOW_HTTP=true, so an API key cannot travel in cleartext by accident.
 * Returns the URL without a trailing slash, or the reason it is unusable.
 */
export function validateRollekatalogUrl(raw: string): RollekatalogUrl {
  const value = raw.trim();
  if (!value) return { url: null, issue: 'not_configured' };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { url: null, issue: 'not_configured' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { url: null, issue: 'not_configured' };
  // Credentials in the URL would end up in logs and error text.
  if (parsed.username || parsed.password) return { url: null, issue: 'not_configured' };
  if (parsed.protocol === 'http:' && !LOOPBACK_HOSTS.has(parsed.hostname) && !boolFlag('ROLLEKATALOG_ALLOW_HTTP', false)) {
    return { url: null, issue: 'insecure_url' };
  }
  return { url: `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, ''), issue: null };
}

/** The validated ROLLEKATALOG_URL, or the reason there is none. */
export function rollekatalogUrl(): RollekatalogUrl {
  return validateRollekatalogUrl(clean('ROLLEKATALOG_URL'));
}

/** API key with client role READ_ACCESS (read/*). null when unset. */
export function readKey(): string | null {
  return clean('ROLLEKATALOG_READ_API_KEY') || null;
}

/** API key with client role ORGANISATION (organisation v3). null when unset. */
export function orgKey(): string | null {
  return clean('ROLLEKATALOG_ORG_API_KEY') || null;
}

/** Why the full sync cannot run (needs a usable URL and BOTH keys), or null when it can. */
export function rollekatalogConfigIssue(): RollekatalogConfigIssue | null {
  const u = rollekatalogUrl();
  if (u.issue) return u.issue;
  return readKey() && orgKey() ? null : 'not_configured';
}

/** Why the role catalogue refresh cannot run (it needs a usable URL and the READ key only), or null when it can. */
export function catalogueConfigIssue(): RollekatalogConfigIssue | null {
  const u = rollekatalogUrl();
  if (u.issue) return u.issue;
  return readKey() ? null : 'not_configured';
}

// The role/group catalogue endpoints (READ_ACCESS, GET only). Defaults are from the
// OS2rollekatalog source (ReadOnlyApi.java: `/api/read/userroles/itsystems` lists every user
// role with its identifier, `/api/read/rolegroups` every role group); NOT verified against a
// live instance, so an operator can point them elsewhere. Only a path under /api/read/ is
// accepted (nothing that could reach a write endpoint or another host); anything else, and an
// unset variable, gives the default. `none` switches that list off.
const DEFAULT_ROLES_PATH = '/api/read/userroles/itsystems';
const DEFAULT_ROLEGROUPS_PATH = '/api/read/rolegroups';
const READ_PATH_RE = /^\/api\/read\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+){0,3}$/;

function cataloguePath(name: string, fallback: string): string | null {
  const v = clean(name);
  if (v === '') return fallback;
  if (v.toLowerCase() === 'none') return null;
  return READ_PATH_RE.test(v) ? v : fallback;
}

/** ROLLEKATALOG_ROLES_PATH: where the user roles (jobfunktionsroller) are listed; null = not read. */
export function rolesPath(): string | null {
  return cataloguePath('ROLLEKATALOG_ROLES_PATH', DEFAULT_ROLES_PATH);
}

/** ROLLEKATALOG_ROLEGROUPS_PATH: where the role groups (rollebuketter) are listed; null = not read. */
export function roleGroupsPath(): string | null {
  return cataloguePath('ROLLEKATALOG_ROLEGROUPS_PATH', DEFAULT_ROLEGROUPS_PATH);
}

export function itSystemId(): string {
  const v = clean('ROLLEKATALOG_ITSYSTEM_ID');
  return /^[A-Za-z0-9_-]{1,100}$/.test(v) ? v : DEFAULT_ITSYSTEM_ID;
}

/** Optional Rollekatalog domain; null = Rollekatalog's primary domain. */
export function rollekatalogDomain(): string | null {
  const v = clean('ROLLEKATALOG_DOMAIN');
  return v && v.length <= 200 ? v : null;
}

export function timeoutMs(): number {
  return intInRange('ROLLEKATALOG_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS);
}

export function maxResponseBytes(): number {
  return intInRange('ROLLEKATALOG_MAX_RESPONSE_BYTES', DEFAULT_MAX_RESPONSE_BYTES, 1024, 512 * 1024 * 1024);
}

/** A constraint-derived scope root covers its whole subtree (the plan's "OrgUnit subtree"). */
export function scopeDescendants(): boolean {
  return boolFlag('ROLLEKATALOG_SCOPE_DESCENDANTS', true);
}

/**
 * Roles that may become GLOBAL from an assignment that carries no usable org-unit
 * scope. Default tt-administrator only. 'none' means no role. Unknown tokens are
 * dropped; an unset or empty variable gives the default.
 */
export function globalRoles(): RoleKey[] {
  const raw = clean('ROLLEKATALOG_GLOBAL_ROLES').toLowerCase();
  if (!raw) return ['tt-administrator'];
  if (raw === 'none') return [];
  const out = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is RoleKey => (ROLE_KEYS as readonly string[]).includes(s));
  return out.length > 0 ? [...new Set(out)] : ['tt-administrator'];
}

export function syncMaxRemovalPercent(): number {
  return intInRange('ROLLEKATALOG_SYNC_MAX_REMOVAL_PERCENT', DEFAULT_SYNC_MAX_REMOVAL_PERCENT, 0, 100);
}

/** After this many seconds without a refresh, rollekatalog-sourced elevated roles are ignored. */
export function roleStaleMaxSeconds(): number {
  return intInRange('ROLE_STALE_MAX_SECONDS', DEFAULT_ROLE_STALE_MAX_SECONDS, 1, 10 * 365 * 86_400);
}

export function directoryUserIdTransform(): UserIdTransform {
  return clean('DIRECTORY_USERID_TRANSFORM').toLowerCase() === 'strip-upn-domain' ? 'strip-upn-domain' : 'none';
}

/**
 * DIRECTORY_USERID_DOMAIN: the one UPN domain whose users may be matched when the
 * transform is strip-upn-domain. Lower-cased; a leading "@" is tolerated. A value
 * that is blank, contains whitespace or another "@" counts as not set.
 */
export function directoryUserIdDomain(): string {
  const v = clean('DIRECTORY_USERID_DOMAIN').toLowerCase().replace(/^@/, '');
  return v && !/[\s@]/.test(v) ? v : '';
}

/**
 * strip-upn-domain without a usable DIRECTORY_USERID_DOMAIN can never match, so the
 * mismatch must be visible. Not part of rollekatalogConfigIssue(): that one stops the
 * sync, and this setting only concerns login matching.
 */
export function directoryConfigIssue(): 'userid_domain_missing' | null {
  return directoryUserIdTransform() === 'strip-upn-domain' && directoryUserIdDomain() === '' ? 'userid_domain_missing' : null;
}

/**
 * Applies DIRECTORY_USERID_TRANSFORM to a login identifier (e.g. a UPN) before it is
 * matched against ext_user_id. With strip-upn-domain the claim must be exactly
 * `<name>@<DIRECTORY_USERID_DOMAIN>` (domain compared case-insensitively, one "@", no
 * guest "#EXT#" marker); anything else, and any claim while the domain is not
 * configured, returns null = no match. Stripping unchecked would let a guest or a
 * self-edited "abc123@evil.example" take over the identity "abc123".
 */
export function transformUserId(value: string): string | null {
  if (directoryUserIdTransform() !== 'strip-upn-domain') return value;
  const domain = directoryUserIdDomain();
  if (!domain) return null;
  const v = value.trim();
  if (v.toUpperCase().includes('#EXT#')) return null;
  const parts = v.split('@');
  if (parts.length !== 2 || parts[0] === '' || parts[1].toLowerCase() !== domain) return null;
  return parts[0];
}
