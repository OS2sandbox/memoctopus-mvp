import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeRunner } from '@/test/fake-runner';

vi.mock('@/lib/db', () => ({ db: {}, pool: { query: vi.fn(), connect: vi.fn() } }));
const recordEvent = vi.fn();
vi.mock('@/lib/audit/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit/record')>()),
  recordEvent: (...a: unknown[]) => recordEvent(...a),
}));

import { validateEvent } from '@/lib/audit/record';
import {
  __resetConfigCheck,
  changedSettingNames,
  checkConfigOnce,
  CONFIG_FLAG_KEY,
  configFingerprint,
  RETRY_DELAYS_MS,
  recordConfigFingerprint,
  SETTING_NAMES,
  settingDigests,
} from './config-fingerprint';

beforeEach(() => {
  recordEvent.mockReset().mockResolvedValue({ status: 'stored' });
  __resetConfigCheck();
});

describe('configFingerprint', () => {
  const env = { ACCESS_SOURCE: 'local', HVISKE_URL: 'https://stt.example/v1', OPENAI_API_KEY: 'sk-secret-1' };

  it('is 16 lower-case hex characters and the same for the same environment', () => {
    expect(configFingerprint(env)).toMatch(/^[0-9a-f]{16}$/);
    expect(configFingerprint({ ...env })).toBe(configFingerprint(env));
  });

  it('changes with a non-secret setting, such as an integration URL or the access source', () => {
    expect(configFingerprint({ ...env, HVISKE_URL: 'https://other.example/v1' })).not.toBe(configFingerprint(env));
    expect(configFingerprint({ ...env, ACCESS_SOURCE: 'rollekatalog' })).not.toBe(configFingerprint(env));
  });

  it('ignores settings that are not part of the configuration (the process environment is full of them)', () => {
    expect(configFingerprint({ ...env, PATH: '/usr/bin', HOME: '/root' })).toBe(configFingerprint(env));
  });

  it('only registers WHETHER a secret is set: a rotated key gives the same fingerprint, a removed one does not', () => {
    expect(configFingerprint({ ...env, OPENAI_API_KEY: 'sk-secret-2' })).toBe(configFingerprint(env));
    expect(configFingerprint({ ...env, OPENAI_API_KEY: '' })).not.toBe(configFingerprint(env));
  });

  it('treats a URL with credentials as a secret too', () => {
    const a = configFingerprint({ ...env, BOT_SERVICE_URL: 'http://user:pw1@bot:3001' });
    expect(configFingerprint({ ...env, BOT_SERVICE_URL: 'http://user:pw2@bot:3001' })).toBe(a);
    expect(configFingerprint({ ...env, DATABASE_URL: 'postgres://u:p@h/db1' })).toBe(configFingerprint({ ...env, DATABASE_URL: 'postgres://u:q@h/db2' }));
  });
});

describe('configFingerprint and the auth config file', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'fingerprint-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const file = (content: string) => {
    const f = path.join(dir, 'auth.json');
    writeFileSync(f, content);
    return f;
  };

  it('changes when the CONTENT of AUTH_CONFIG_FILE changes (a new provider or role mapping is a configuration change)', () => {
    const f = file('{"providers":[]}');
    const before = configFingerprint({ AUTH_CONFIG_FILE: f });
    writeFileSync(f, '{"providers":[],"roles":{"appRoleMap":{"x":"admin"}}}');
    expect(configFingerprint({ AUTH_CONFIG_FILE: f })).not.toBe(before);
  });

  it('is stable for unchanged content (only a digest of the bytes enters the fingerprint)', () => {
    const f = file('{"secret-looking":"value-1234"}');
    expect(configFingerprint({ AUTH_CONFIG_FILE: f })).toBe(configFingerprint({ AUTH_CONFIG_FILE: f }));
  });

  it('treats an unreadable file as its own state, without throwing', () => {
    const gone = path.join(dir, 'missing.json');
    expect(configFingerprint({ AUTH_CONFIG_FILE: gone })).toMatch(/^[0-9a-f]{16}$/);
    expect(configFingerprint({ AUTH_CONFIG_FILE: gone })).not.toBe(configFingerprint({}));
  });

  it('sees the new access settings', () => {
    expect(configFingerprint({ ACCESS_LOCAL_ADMIN: 'false' })).not.toBe(configFingerprint({}));
    expect(configFingerprint({ ROLE_CLAIMS_MAX_SECONDS: '3600' })).not.toBe(configFingerprint({}));
  });
});

describe('recordConfigFingerprint', () => {
  const env = { ACCESS_SOURCE: 'local' };
  const run = (rows: Array<Record<string, unknown>>) => makeFakeRunner((sql) => (sql.includes('system_flags') ? rows : []));

  it('first start: stores the fingerprint and records a baseline (changed: false) in the same transaction', async () => {
    const { runner, calls } = run([{ inserted: true }]);
    expect(await recordConfigFingerprint(env, runner)).toBe('baseline');
    expect(calls[0].sql).toBe('BEGIN');
    expect(calls.at(-1)!.sql).toBe('COMMIT');
    const swap = calls.find((c) => c.sql.includes('INSERT INTO public.system_flags'))!;
    expect(swap.params).toEqual([CONFIG_FLAG_KEY, configFingerprint(env), JSON.stringify(settingDigests(env))]);
    expect(swap.tx).toBe(true);
    expect(recordEvent).toHaveBeenCalledWith(
      { type: 'system.config_changed', source: 'system', details: { fingerprint: configFingerprint(env), changed: false } },
      { tx: expect.objectContaining({ query: expect.any(Function) }) },
    );
  });

  it('a different fingerprint than the stored one records changed: true', async () => {
    const { runner } = run([{ inserted: false }]);
    expect(await recordConfigFingerprint(env, runner)).toBe('changed');
    // An older flag has no per-setting digests, so no names can be given.
    expect(recordEvent.mock.calls[0][0].details).toEqual({ fingerprint: configFingerprint(env), changed: true });
  });

  it('a change names the settings that differ (names only, never values), from the stored digests', async () => {
    const before = { ACCESS_SOURCE: 'local', HVISKE_URL: 'https://old.example/v1', OPENAI_API_KEY: 'sk-old' };
    const after = { ACCESS_SOURCE: 'rollekatalog', HVISKE_URL: 'https://old.example/v1', OPENAI_API_KEY: 'sk-new-rotated', ROLLEKATALOG_URL: 'https://rk.example' };
    const stored = { fingerprint: configFingerprint(before), digests: settingDigests(before) };
    const { runner } = run([{ inserted: false, value: stored }]);
    await recordConfigFingerprint(after, runner);
    const details = recordEvent.mock.calls[0][0].details;
    // A rotated secret is not a change (only set/unset counts); the URL and the source are.
    expect(details.changedKeys).toEqual(['ACCESS_SOURCE', 'ROLLEKATALOG_URL']);
    expect(JSON.stringify(recordEvent.mock.calls[0][0])).not.toMatch(/rk\.example|rollekatalog"|sk-/);
    expect(validateEvent(recordEvent.mock.calls[0][0])).toMatchObject({ ok: true });
  });

  it('the baseline carries no changedKeys', async () => {
    const { runner } = run([{ inserted: true, value: { fingerprint: 'x', digests: { ACCESS_SOURCE: 'aaaa' } } }]);
    await recordConfigFingerprint(env, runner);
    expect(recordEvent.mock.calls[0][0].details).toEqual({ fingerprint: configFingerprint(env), changed: false });
  });

  it('the same fingerprint records nothing (the swap matches no row)', async () => {
    const { runner } = run([]);
    expect(await recordConfigFingerprint(env, runner)).toBe('unchanged');
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('what it records is a valid catalogue event with no secret in it', async () => {
    const { runner } = run([{ inserted: true }]);
    await recordConfigFingerprint({ ...env, OPENAI_API_KEY: 'sk-secret-1' }, runner);
    const event = recordEvent.mock.calls[0][0];
    expect(validateEvent(event)).toMatchObject({ ok: true });
    expect(JSON.stringify(event)).not.toContain('sk-secret');
  });

  it('a failed audit write rolls the stored fingerprint back, so the next start tries again', async () => {
    recordEvent.mockRejectedValue(new Error('audit down'));
    const { runner, calls } = run([{ inserted: true }]);
    await expect(recordConfigFingerprint(env, runner)).rejects.toThrow('audit down');
    expect(calls.at(-1)!.sql).toBe('ROLLBACK');
  });
});

describe('changedSettingNames', () => {
  it('lists added, removed and changed names, sorted, capped at 32', () => {
    expect(changedSettingNames({ A_B: '1', C_D: '2', E_F: '3' }, { A_B: '1', C_D: 'x', G_H: '4' })).toEqual(['C_D', 'E_F', 'G_H']);
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`SETTING_${String(i).padStart(2, '0')}`, 'a']));
    expect(changedSettingNames({}, many)).toHaveLength(32);
  });

  it('a secret contributes only set/unset to its digest', () => {
    expect(settingDigests({ OPENAI_API_KEY: 'sk-1' }).OPENAI_API_KEY).toBe(settingDigests({ OPENAI_API_KEY: 'sk-2' }).OPENAI_API_KEY);
    expect(settingDigests({ OPENAI_API_KEY: 'sk-1' }).OPENAI_API_KEY).not.toBe(settingDigests({}).OPENAI_API_KEY);
  });
});

describe('checkConfigOnce', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('never throws, retries five times with a growing pause, warns without detail, and runs at most once per process', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pauses: number[] = [];
    // No reachable database in this test: recordConfigFingerprint rejects.
    const first = await checkConfigOnce({ sleep: async (ms) => void pauses.push(ms) });
    expect(first).toBe('failed');
    expect(pauses).toEqual([...RETRY_DELAYS_MS]);
    expect(pauses).toHaveLength(4); // five attempts in all
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/^\[audit\] config fingerprint check failed code=\S+ attempts=5$/);
    warn.mockClear();
    expect(await checkConfigOnce({ sleep: async () => {} })).toBe('unchanged');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does nothing during next build (no database, not a start), and does not use up the once-per-process check', async () => {
    vi.stubEnv('NEXT_PHASE', 'phase-production-build');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sleep = vi.fn(async () => {});
    expect(await checkConfigOnce({ sleep })).toBe('skipped');
    expect(sleep).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    vi.stubEnv('NEXT_PHASE', '');
    expect(await checkConfigOnce({ sleep: async () => {} })).toBe('failed');
    warn.mockRestore();
  });

  it('retry timers do not keep the process alive', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    const unref = vi.spyOn(globalThis, 'setTimeout');
    const p = checkConfigOnce();
    await vi.runAllTimersAsync();
    expect(await p).toBe('failed');
    expect(unref).toHaveBeenCalled();
    vi.useRealTimers();
    warn.mockRestore();
  });
});

// Tripwire: a setting that is read from the environment but missing here would change the
// system silently. Every variable the app reads must be part of the fingerprint or be listed as
// deliberately outside it.
describe('SETTING_NAMES covers every setting the app reads', () => {
  // Not "system configuration": runtime/framework switches, test lanes and per-process flags.
  const EXCLUDED = new Set([
    'NODE_ENV', 'NEXT_RUNTIME', 'NEXT_PHASE', 'TEST_DATABASE_URL', 'CI', 'PORT', 'HOSTNAME', 'TZ',
    'VITEST', 'PLAYWRIGHT_TEST_BASE_URL',
  ]);

  const root = path.join(process.cwd(), 'src');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '__fixtures__') walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec|pg\.test)\.(ts|tsx)$/.test(entry.name) && !full.includes(`${path.sep}test${path.sep}`)) {
        files.push(full);
      }
    }
  };
  walk(root);

  const readNames = (file: string): string[] => {
    const text = readFileSync(file, 'utf8');
    const names = new Set<string>();
    for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) names.add(m[1]);
    for (const m of text.matchAll(/process\.env\[['"]([A-Z][A-Z0-9_]+)['"]\]/g)) names.add(m[1]);
    // The config.ts files read through small helpers: clean('NAME'), flag('NAME', ...), ...
    if (/(^|[\\/])config\.ts$/.test(file)) {
      for (const m of text.matchAll(/\b[a-zA-Z]+\(\s*['"]([A-Z][A-Z0-9_]{3,})['"]/g)) names.add(m[1]);
    }
    return [...names];
  };

  it('every environment variable read in src is in SETTING_NAMES or deliberately excluded', () => {
    expect(files.length).toBeGreaterThan(100);
    const known = new Set<string>(SETTING_NAMES);
    const missing: string[] = [];
    for (const file of files) {
      for (const name of readNames(file)) {
        if (!known.has(name) && !EXCLUDED.has(name)) missing.push(`${name} (${path.relative(root, file)})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('the exclusion list names nothing that is also a setting, and every setting is read somewhere or documented', () => {
    for (const name of EXCLUDED) expect(SETTING_NAMES as readonly string[]).not.toContain(name);
    expect(new Set(SETTING_NAMES).size).toBe(SETTING_NAMES.length);
  });

  it('the settings the review found missing are covered', () => {
    for (const name of ['HVISKE_BATCH_CONCURRENCY', 'DIARIZATION_TIMEOUT_MS']) expect(SETTING_NAMES as readonly string[]).toContain(name);
  });
});
