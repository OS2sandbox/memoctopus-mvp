// "Change of system configuration / integration settings" for the audit log. Every
// setting of this app comes from the environment (no admin UI writes it), so the
// only observable change is a different effective configuration at the next start.
// At start the process computes a short fingerprint over the setting NAMES and their
// non-secret values, compares it with the one kept in public.system_flags and, when
// it differs (or is the first ever), records system.config_changed in the same
// transaction as the update. The event says THAT something changed, never what.
//
// Secrets (keys, passwords, tokens, hashes, anything with credentials in a URL) enter the
// readable `NAME=<set>` line only as set/unset. A ROTATED secret is detected through a KEYED
// digest: HMAC-SHA-256 over `NAME + value`, keyed with a value derived from BETTER_AUTH_SECRET
// (which never leaves the app host). The keyed digest goes into the fingerprint and, shortened,
// into the stored flag (`secretDigests`); it is never put in an audit event (the event only names
// the setting in `changedKeys`) and without the key it reveals nothing about the secret, so it
// is acceptable in public.system_flags (a plain, unsalted hash of a secret would not be). When no
// BETTER_AUTH_SECRET is available there is no key and secrets stay set/unset only: a rotation is
// then not detected (the app cannot run without that secret in production, so this is the test
// and misconfiguration case). Rotating BETTER_AUTH_SECRET itself changes the key: the stored
// `keyId` then differs, the old and new secret digests are not comparable, so only
// BETTER_AUTH_SECRET is named and the other secrets are not reported as changed.
//
// Next to the fingerprint the flag keeps a short digest PER setting name, so the event
// can name WHICH settings changed (`changedKeys`: names only, never a value, at most 32).
// A secret's entry in `digests` is a digest of `<set>`/`<unset>`, so it carries nothing but that state.
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CODE_RE } from '@/lib/audit/events/types';
import { recordEvent } from '@/lib/audit/record';
import { defaultRunner, type SqlRunner } from '@/lib/authz/pg-runner';

export const CONFIG_FLAG_KEY = 'config_fingerprint';

// The settings that make up "the system configuration and the integrations": auth,
// access, Rollekatalog, the AI/STT/diarization/Teams integrations, storage and audit.
export const SETTING_NAMES = [
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
  'HVISKE_URL', 'HVISKE_MODEL', 'HVISKE_API_KEY', 'ASR_LANGUAGE', 'HVISKE_DIARIZE', 'HVISKE_BATCH_CONCURRENCY',
  'DIARIZATION_URL', 'DIARIZATION_API_KEY', 'DIARIZATION_TIMEOUT_MS', 'NEXT_PUBLIC_DIARIZATION_TIMEOUT_MS',
  'LLM_CONTEXT_TOKENS', 'VLLM_CHAT_MAX_MODEL_LEN', 'LLM_MAX_OUTPUT_TOKENS',
  'TEAMS_GRAPH_ENABLED', 'TEAMS_ARTIFACT_MODE', 'TEAMS_DELETE_RECORDING', 'GRAPH_BASE_URL',
  'TEAMS_SPOKEN_LANGUAGE', 'TEAMS_POLL_INTERVAL_MS', 'TEAMS_POLLER_DISABLED',
  'AUDIT_STDOUT', 'AUDIT_STORE_IP', 'AUDIT_RETENTION_DAYS', 'AUDIT_CLIENT_EVENTS_DAILY_CAP',
  'INTERNAL_CRON_SECRET',
] as const;

const SECRET_NAME = /SECRET|KEY|PASSWORD|TOKEN|HASH|DATABASE_URL/;
// scheme://user:pass@host: credentials inside a URL make the whole value a secret.
const URL_CREDENTIALS = /:\/\/[^/\s]*@/;

function isSecret(name: string, value: string): boolean {
  return SECRET_NAME.test(name) || URL_CREDENTIALS.test(value);
}

const KEY_CONTEXT = 'referat.config-fingerprint.v1';

/** The HMAC key, derived (never BETTER_AUTH_SECRET itself) so the secret is not used raw; null when there is no secret. */
function deriveKey(env: Record<string, string | undefined>): Buffer | null {
  const base = (env.BETTER_AUTH_SECRET ?? '').trim();
  return base ? createHmac('sha256', base).update(KEY_CONTEXT).digest() : null;
}

const keyedDigest = (key: Buffer, name: string, value: string): string =>
  createHmac('sha256', key).update(`${name}\u0000${value}`).digest('hex');

/** Identifies the key (not the secret): when it differs, keyed digests of two runs cannot be compared. */
const keyIdOf = (key: Buffer | null): string | null => (key ? createHmac('sha256', key).update('key-id').digest('hex').slice(0, 8) : null);

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function fileDigest(path: string): string {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
  } catch {
    return '<unreadable>';
  }
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** The pseudo-setting that covers secrets a config file pulls in by ${ENV} reference (names in the file are arbitrary). */
const AUTH_FILE_REFERENCES = 'AUTH_CONFIG_FILE_REFERENCES';

interface SettingLine {
  name: string;
  /** The readable line: `NAME=value`, a secret's value replaced by `<set>` / `<unset>`. */
  line: string;
  /** Keyed digest (full hex) of a SET secret's value; absent without a key, for non-secrets and unset secrets. */
  keyed?: string;
}

interface Settings {
  lines: SettingLine[];
  keyId: string | null;
}

/** The values behind the `${NAME}` references of the auth config file, as one string; null when there is none or it cannot be read. */
function referencedValues(path: string, env: Record<string, string | undefined>): string | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const names = [...new Set([...text.matchAll(ENV_REF)].map((m) => m[1]))].sort();
  return names.length === 0 ? null : names.map((n) => `${n}=${(env[n] ?? '').trim()}`).join('\n');
}

/**
 * One line per setting, `NAME=value`, with a secret's value replaced by `<set>` / `<unset>` (plus a keyed
 * digest of its value when a key exists, see the header).
 * The auth config file contributes a digest of its bytes as the pseudo-setting AUTH_CONFIG_FILE_CONTENT:
 * it holds the identity providers and the role mapping, so a change to its CONTENT is a configuration
 * change too. Only a digest enters (the file carries secrets by ${ENV} reference, never in clear, but it
 * is not ours to echo), and an unreadable file is its own state. The values its ${ENV} references
 * resolve to are covered by AUTH_CONFIG_FILE_REFERENCES (keyed digest, only with a key).
 */
function settingLines(env: Record<string, string | undefined>): Settings {
  const key = deriveKey(env);
  const lines: SettingLine[] = [...SETTING_NAMES].sort().map((name) => {
    const value = (env[name] ?? '').trim();
    if (!isSecret(name, value)) return { name, line: `${name}=${value}` };
    return { name, line: `${name}=${value ? '<set>' : '<unset>'}`, ...(key && value ? { keyed: keyedDigest(key, name, value) } : {}) };
  });
  const authFile = (env.AUTH_CONFIG_FILE ?? '').trim();
  if (authFile) {
    lines.push({ name: 'AUTH_CONFIG_FILE_CONTENT', line: `AUTH_CONFIG_FILE_CONTENT=${fileDigest(authFile)}` });
    const referenced = key ? referencedValues(authFile, env) : null;
    if (key && referenced !== null) {
      lines.push({ name: AUTH_FILE_REFERENCES, line: `${AUTH_FILE_REFERENCES}=<set>`, keyed: keyedDigest(key, AUTH_FILE_REFERENCES, referenced) });
    }
  }
  return { lines, keyId: keyIdOf(key) };
}

const fingerprintOf = ({ lines }: Settings): string =>
  sha(lines.map((l) => (l.keyed ? `${l.line}:${l.keyed}` : l.line)).join('\n')).slice(0, 16);

function digestsOf({ lines }: Settings): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of lines) out[l.name] = sha(l.line).slice(0, 12);
  return out;
}

/** name -> first 12 hex characters of the keyed digest of each SET secret; empty without a key. */
function secretDigestsOf({ lines }: Settings): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of lines) if (l.keyed) out[l.name] = l.keyed.slice(0, 12);
  return out;
}

/**
 * First 16 hex characters of a sha256 over the sorted `NAME=value` lines, with a
 * secret's value replaced by `<set>` (or `<unset>`) and, when BETTER_AUTH_SECRET gives a key,
 * followed by the keyed digest of its value (so a rotation changes the fingerprint). Pure; the
 * same environment always gives the same fingerprint.
 */
export function configFingerprint(env: Record<string, string | undefined> = process.env): string {
  return fingerprintOf(settingLines(env));
}

/** name -> first 12 hex characters of a sha256 of that setting's line (a secret: of its set/unset state only; rotations are in secretDigests). */
export function settingDigests(env: Record<string, string | undefined> = process.env): Record<string, string> {
  return digestsOf(settingLines(env));
}

const MAX_CHANGED_KEYS = 32;

/** Names (never values) whose digest differs, appeared or disappeared; sorted, at most 32, code-shaped. */
export function changedSettingNames(before: Record<string, string>, after: Record<string, string>): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names]
    .filter((n) => before[n] !== after[n] && CODE_RE.test(n))
    .sort()
    .slice(0, MAX_CHANGED_KEYS);
}

function stringMap(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') out[k] = v;
  return out;
}

interface StoredFlag {
  digests: Record<string, string>;
  secretDigests: Record<string, string> | null;
  keyId: string | null;
}

function storedFlag(value: unknown): StoredFlag | null {
  const v = value as { digests?: unknown; secretDigests?: unknown; keyId?: unknown } | null;
  const digests = stringMap(v?.digests);
  if (!digests) return null;
  return { digests, secretDigests: stringMap(v?.secretDigests), keyId: typeof v?.keyId === 'string' ? v.keyId : null };
}

/**
 * The names that differ between the stored flag and the current settings. Secrets are compared by their
 * keyed digests only when the stored flag has some AND was made with the same key; a different key means
 * BETTER_AUTH_SECRET itself changed (it is named, the other secrets are not guessed at). A flag from
 * before keyed digests has none, so no secret is reported on the first start after the upgrade.
 */
function changedNames(previous: StoredFlag, current: Settings): string[] {
  const names = changedSettingNames(previous.digests, digestsOf(current));
  const extra = new Set<string>();
  const nowKeyId = current.keyId;
  if (previous.keyId !== null && nowKeyId !== null && previous.keyId !== nowKeyId) extra.add('BETTER_AUTH_SECRET');
  if (previous.secretDigests && previous.keyId !== null && previous.keyId === nowKeyId) {
    const now = secretDigestsOf(current);
    for (const n of new Set([...Object.keys(previous.secretDigests), ...Object.keys(now)])) {
      if (previous.secretDigests[n] !== now[n] && CODE_RE.test(n)) extra.add(n);
    }
  }
  return [...new Set([...names, ...extra])].sort().slice(0, MAX_CHANGED_KEYS);
}

// Compare-and-swap in ONE statement, so instances starting together record one event:
// a first insert returns inserted = true, a changed fingerprint returns inserted = false,
// an unchanged one matches the WHERE and returns no row.
const SWAP_SQL = `
  INSERT INTO public.system_flags (key, value)
  VALUES ($1, jsonb_build_object('fingerprint', $2::text, 'digests', $3::jsonb, 'secretDigests', $4::jsonb, 'keyId', $5::text))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, set_at = now()
    WHERE public.system_flags.value ->> 'fingerprint' IS DISTINCT FROM $2::text
  RETURNING (xmax = 0) AS inserted`;

export type ConfigCheck = 'unchanged' | 'baseline' | 'changed';

/**
 * Stores the current fingerprint and records system.config_changed when it is new or
 * different, in one transaction (a failed audit write rolls the update back, so the
 * next start tries again). A change names the settings that differ (`changedKeys`) when
 * the stored flag carries per-setting digests (older flags do not). THROWS on a database
 * failure; callers go through checkConfigOnce, which never does.
 */
export async function recordConfigFingerprint(
  env: Record<string, string | undefined> = process.env,
  runner: SqlRunner = defaultRunner(),
): Promise<ConfigCheck> {
  const settings = settingLines(env);
  const fingerprint = fingerprintOf(settings);
  const digests = digestsOf(settings);
  return runner.transaction(async (tx) => {
    const before = await tx.query<{ value: unknown }>('SELECT value FROM public.system_flags WHERE key = $1 FOR UPDATE', [CONFIG_FLAG_KEY]);
    const previous = storedFlag(before.rows[0]?.value);
    const res = await tx.query<{ inserted: boolean }>(SWAP_SQL, [
      CONFIG_FLAG_KEY,
      fingerprint,
      JSON.stringify(digests),
      JSON.stringify(secretDigestsOf(settings)),
      settings.keyId,
    ]);
    const row = res.rows[0];
    if (!row) return 'unchanged' as const;
    const changed = row.inserted === false;
    const changedKeys = changed && previous ? changedNames(previous, settings) : [];
    await recordEvent(
      {
        type: 'system.config_changed',
        source: 'system',
        details: { fingerprint, changed, ...(changedKeys.length > 0 ? { changedKeys } : {}) },
      },
      { tx },
    );
    return changed ? ('changed' as const) : ('baseline' as const);
  });
}

let checked = false;

/** Waits before attempt 2, 3, 4 and 5. The database may simply not be up yet when the app starts. */
export const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Never keeps the process (or a test run) alive by itself.
    timer.unref?.();
  });

/**
 * Once per process, never throws and never blocks startup: up to five attempts with a
 * growing pause (the database often comes up after the app), then a content-free warning
 * (the check simply runs again at the next start). Skipped during `next build`, which has
 * no database and must not be mistaken for a start.
 */
export async function checkConfigOnce(opts: { sleep?: (ms: number) => Promise<void> } = {}): Promise<ConfigCheck | 'failed' | 'skipped'> {
  if (process.env.NEXT_PHASE === 'phase-production-build') return 'skipped';
  if (checked) return 'unchanged';
  checked = true;
  const sleep = opts.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await recordConfigFingerprint();
    } catch (err) {
      lastError = err;
      if (attempt < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
  const code = (lastError as { code?: unknown } | null)?.code;
  console.warn(
    `[audit] config fingerprint check failed code=${typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'unknown'} attempts=${RETRY_DELAYS_MS.length + 1}`,
  );
  return 'failed';
}

/** Test only. */
export function __resetConfigCheck(): void {
  checked = false;
}
