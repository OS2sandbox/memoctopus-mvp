// Audit settings. Read from process.env at CALL time (same idiom as
// src/lib/authz/config.ts) so an operator can change .env and restart without an
// image rebuild. Never NEXT_PUBLIC_*. Bad values fall back to the safe default
// instead of throwing: a typo must not take the app (or the audit trail) down.

function clean(name: string): string {
  return (process.env[name] ?? '').trim();
}

function flag(name: string, defaultValue: boolean): boolean {
  const v = clean(name).toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return defaultValue;
}

/** Mirror every event to stdout as one JSON line (for the customer's log shipper). Default off. */
export function auditStdout(): boolean {
  return flag('AUDIT_STDOUT', false);
}

/** `false` stores no IP address at all. Default on. */
export function auditStoreIp(): boolean {
  return flag('AUDIT_STORE_IP', true);
}

export const DEFAULT_AUDIT_RETENTION_DAYS = 365;
const RETENTION_OPT_OUT = new Set(['0', 'off', 'false', 'never', 'forever']);

/**
 * Retention in whole days. Unset or empty => 365 (the audit log holds IP, user agent and a
 * name snapshot, so it is not kept forever by default). A positive integer => that many days.
 * `0`, `off`, `false`, `never` or `forever` (any case) is the explicit opt-out => null (keep
 * forever). Any other value is treated as a typo and falls back to the default: an invalid
 * value must fail toward minimal retention, never toward keeping everything.
 */
export function auditRetentionDays(): number | null {
  const v = clean('AUDIT_RETENTION_DAYS').toLowerCase();
  if (v === '') return DEFAULT_AUDIT_RETENTION_DAYS;
  if (RETENTION_OPT_OUT.has(v)) return null;
  if (!/^\d+$/.test(v)) return DEFAULT_AUDIT_RETENTION_DAYS;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_AUDIT_RETENTION_DAYS;
}

export const DEFAULT_CLIENT_EVENTS_DAILY_CAP = 2000;

/**
 * Most client-reported (source = 'client') events stored per user per rolling 24 h. Default 2000;
 * unset, 0 or invalid => default (the cap cannot be switched off by a typo).
 */
export function auditClientEventsDailyCap(): number {
  const v = clean('AUDIT_CLIENT_EVENTS_DAILY_CAP');
  if (!/^\d+$/.test(v)) return DEFAULT_CLIENT_EVENTS_DAILY_CAP;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_CLIENT_EVENTS_DAILY_CAP;
}

/** Lower-case hex sha256 of the feed's service key; null disables the feed. */
export function auditFeedKeyHash(): string | null {
  const v = clean('AUDIT_FEED_API_KEY_HASH').toLowerCase();
  return /^[0-9a-f]{64}$/.test(v) ? v : null;
}

/** The feed only returns rows older than this, so a bigserial id that commits late is never skipped. Default 10. */
export function auditFeedDelaySeconds(): number {
  const v = clean('AUDIT_FEED_DELAY_SECONDS');
  if (!/^\d+$/.test(v)) return 10;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : 10;
}

/** Secret for the retention prune route; null makes the route answer 404. */
export function internalCronSecret(): string | null {
  return clean('INTERNAL_CRON_SECRET') || null;
}
