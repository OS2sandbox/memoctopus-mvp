import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeRunner } from '@/test/fake-runner';

vi.mock('@/lib/db', () => ({ db: {}, pool: { query: vi.fn(), connect: vi.fn() } }));
const recordEvent = vi.fn();
vi.mock('@/lib/audit/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit/record')>()),
  recordEvent: (...a: unknown[]) => recordEvent(...a),
}));

import { validateEvent } from '@/lib/audit/record';
import { __resetConfigCheck, checkConfigOnce, CONFIG_FLAG_KEY, configFingerprint, recordConfigFingerprint } from './config-fingerprint';

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

describe('recordConfigFingerprint', () => {
  const env = { ACCESS_SOURCE: 'local' };
  const run = (rows: Array<Record<string, unknown>>) => makeFakeRunner((sql) => (sql.includes('system_flags') ? rows : []));

  it('first start: stores the fingerprint and records a baseline (changed: false) in the same transaction', async () => {
    const { runner, calls } = run([{ inserted: true }]);
    expect(await recordConfigFingerprint(env, runner)).toBe('baseline');
    expect(calls[0].sql).toBe('BEGIN');
    expect(calls.at(-1)!.sql).toBe('COMMIT');
    const swap = calls.find((c) => c.sql.includes('system_flags'))!;
    expect(swap.params).toEqual([CONFIG_FLAG_KEY, configFingerprint(env)]);
    expect(swap.tx).toBe(true);
    expect(recordEvent).toHaveBeenCalledWith(
      { type: 'system.config_changed', source: 'system', details: { fingerprint: configFingerprint(env), changed: false } },
      { tx: expect.objectContaining({ query: expect.any(Function) }) },
    );
  });

  it('a different fingerprint than the stored one records changed: true', async () => {
    const { runner } = run([{ inserted: false }]);
    expect(await recordConfigFingerprint(env, runner)).toBe('changed');
    expect(recordEvent.mock.calls[0][0].details).toEqual({ fingerprint: configFingerprint(env), changed: true });
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

describe('checkConfigOnce', () => {
  it('never throws, warns without detail, and runs at most once per process', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // No reachable database in this test: recordConfigFingerprint rejects.
    const first = await checkConfigOnce();
    expect(first).toBe('failed');
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/^\[audit\] config fingerprint check failed code=/);
    warn.mockClear();
    expect(await checkConfigOnce()).toBe('unchanged');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
