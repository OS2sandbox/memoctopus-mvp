// "Change of system configuration / integration settings" for the audit log. Every
// setting of this app comes from the environment (no admin UI writes it), so the
// only observable change is a different effective configuration at the next start.
// At start the process computes a short fingerprint over the setting NAMES and their
// non-secret values, compares it with the one kept in public.system_flags and, when
// it differs (or is the first ever), records system.config_changed in the same
// transaction as the update. The event says THAT something changed, never what.
//
// Secrets (keys, passwords, tokens, hashes, anything with credentials in a URL)
// contribute only whether they are set, so a fingerprint cannot be used to recover
// one and a rotated secret is NOT detected (it cannot be, without hashing it).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { recordEvent } from '@/lib/audit/record';
import { defaultRunner, type SqlRunner } from '@/lib/authz/pg-runner';

export const CONFIG_FLAG_KEY = 'config_fingerprint';

// The settings that make up "the system configuration and the integrations": auth,
// access, Rollekatalog, the AI/STT/diarization/bot integrations, storage and audit.
const SETTING_NAMES = [
  'BETTER_AUTH_URL', 'BETTER_AUTH_TRUSTED_ORIGINS', 'BETTER_AUTH_SECRET',
  'NEXT_PUBLIC_APP_URL', 'NEXT_APP_URL', 'DATABASE_URL', 'AUDIO_STORAGE_PATH',
  'EMAIL_PASSWORD_ENABLED', 'MICROSOFT_ENABLED', 'OIDC_ENABLED',
  'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_TENANT_ID',
  'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_DISCOVERY_URL', 'OIDC_PKCE', 'OIDC_PROVIDER_ID', 'OIDC_PROVIDER_NAME',
  'AUTHENTIK_CLIENT_ID', 'AUTHENTIK_CLIENT_SECRET', 'AUTHENTIK_DISCOVERY_URL',
  'ACCESS_SOURCE', 'REQUIRE_ROLE_TO_LOGIN', 'BOOTSTRAP_ADMIN_EMAILS',
  'DIRECTORY_MATCH', 'DIRECTORY_USERID_CLAIM', 'DIRECTORY_USERID_TRANSFORM', 'DIRECTORY_USERID_DOMAIN',
  'AUTH_IP_HEADERS', 'ROLE_STALE_MAX_SECONDS', 'ROLE_CLAIMS_MAX_SECONDS', 'ACCESS_LOCAL_ADMIN', 'AUTH_CONFIG_FILE',
  'ROLLEKATALOG_URL', 'ROLLEKATALOG_READ_API_KEY', 'ROLLEKATALOG_ORG_API_KEY', 'ROLLEKATALOG_ITSYSTEM_ID',
  'ROLLEKATALOG_DOMAIN', 'ROLLEKATALOG_TIMEOUT_MS', 'ROLLEKATALOG_MAX_RESPONSE_BYTES', 'ROLLEKATALOG_ALLOW_HTTP',
  'ROLLEKATALOG_SCOPE_DESCENDANTS', 'ROLLEKATALOG_GLOBAL_ROLES', 'ROLLEKATALOG_SYNC_MAX_REMOVAL_PERCENT',
  'ROLLEKATALOG_ROLES_PATH', 'ROLLEKATALOG_ROLEGROUPS_PATH',
  'SKABELON_SHARE_CODE', 'SKABELON_SHARE_LINK',
  'OPENAI_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL',
  'HVISKE_URL', 'HVISKE_MODEL', 'HVISKE_API_KEY', 'ASR_LANGUAGE', 'HVISKE_DIARIZE',
  'DIARIZATION_URL', 'DIARIZATION_API_KEY',
  'BOT_SERVICE_URL', 'BOT_INTERNAL_SECRET',
  'AUDIT_STDOUT', 'AUDIT_STORE_IP', 'AUDIT_RETENTION_DAYS', 'AUDIT_CLIENT_EVENTS_DAILY_CAP',
  'AUDIT_FEED_API_KEY_HASH', 'AUDIT_FEED_DELAY_SECONDS', 'INTERNAL_CRON_SECRET',
] as const;

const SECRET_NAME = /SECRET|KEY|PASSWORD|TOKEN|HASH|DATABASE_URL/;
// scheme://user:pass@host: credentials inside a URL make the whole value a secret.
const URL_CREDENTIALS = /:\/\/[^/\s]*@/;

function isSecret(name: string, value: string): boolean {
  return SECRET_NAME.test(name) || URL_CREDENTIALS.test(value);
}

function fileDigest(path: string): string {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
  } catch {
    return '<unreadable>';
  }
}

/**
 * First 16 hex characters of a sha256 over the sorted `NAME=value` lines, with a
 * secret's value replaced by `<set>` (or `<unset>`). Pure; the same environment always
 * gives the same fingerprint.
 */
export function configFingerprint(env: Record<string, string | undefined> = process.env): string {
  const lines = [...SETTING_NAMES].sort().map((name) => {
    const value = (env[name] ?? '').trim();
    if (isSecret(name, value)) return `${name}=${value ? '<set>' : '<unset>'}`;
    return `${name}=${value}`;
  });
  // The auth config file holds the identity providers and the role mapping: a change to its
  // CONTENT is a configuration change too. Only a digest of the raw bytes enters the
  // fingerprint (the file carries secrets by ${ENV} reference, never in clear, but it is not
  // ours to echo), and an unreadable file is its own state.
  const authFile = (env.AUTH_CONFIG_FILE ?? '').trim();
  if (authFile) lines.push(`AUTH_CONFIG_FILE_CONTENT=${fileDigest(authFile)}`);
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
}

// Compare-and-swap in ONE statement, so instances starting together record one event:
// a first insert returns inserted = true, a changed fingerprint returns inserted = false,
// an unchanged one matches the WHERE and returns no row.
const SWAP_SQL = `
  INSERT INTO public.system_flags (key, value) VALUES ($1, jsonb_build_object('fingerprint', $2::text))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, set_at = now()
    WHERE public.system_flags.value ->> 'fingerprint' IS DISTINCT FROM $2::text
  RETURNING (xmax = 0) AS inserted`;

export type ConfigCheck = 'unchanged' | 'baseline' | 'changed';

/**
 * Stores the current fingerprint and records system.config_changed when it is new or
 * different, in one transaction (a failed audit write rolls the update back, so the
 * next start tries again). THROWS on a database failure; callers go through
 * checkConfigOnce, which never does.
 */
export async function recordConfigFingerprint(
  env: Record<string, string | undefined> = process.env,
  runner: SqlRunner = defaultRunner(),
): Promise<ConfigCheck> {
  const fingerprint = configFingerprint(env);
  return runner.transaction(async (tx) => {
    const res = await tx.query<{ inserted: boolean }>(SWAP_SQL, [CONFIG_FLAG_KEY, fingerprint]);
    const row = res.rows[0];
    if (!row) return 'unchanged' as const;
    const changed = row.inserted === false;
    await recordEvent({ type: 'system.config_changed', source: 'system', details: { fingerprint, changed } }, { tx });
    return changed ? ('changed' as const) : ('baseline' as const);
  });
}

let checked = false;

/**
 * Once per process, never throws and never blocks startup: any failure is a
 * content-free warning (the check simply runs again at the next start).
 */
export async function checkConfigOnce(): Promise<ConfigCheck | 'failed'> {
  if (checked) return 'unchanged';
  checked = true;
  try {
    return await recordConfigFingerprint();
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    console.warn(`[audit] config fingerprint check failed code=${typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'unknown'}`);
    return 'failed';
  }
}

/** Test only. */
export function __resetConfigCheck(): void {
  checked = false;
}
