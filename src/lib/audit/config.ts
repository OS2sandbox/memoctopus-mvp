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

/** Retention in whole days; unset, non-numeric or <= 0 means keep forever (null). */
export function auditRetentionDays(): number | null {
  const v = clean('AUDIT_RETENTION_DAYS');
  if (!/^\d+$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
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
