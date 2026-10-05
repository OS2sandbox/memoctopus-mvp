import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  auditFeedDelaySeconds,
  auditFeedKeyHash,
  auditRetentionDays,
  auditStdout,
  auditStoreIp,
  internalCronSecret,
} from './config';

afterEach(() => vi.unstubAllEnvs());

describe('auditStdout', () => {
  it('defaults to false and only "true" enables it', () => {
    vi.stubEnv('AUDIT_STDOUT', '');
    expect(auditStdout()).toBe(false);
    vi.stubEnv('AUDIT_STDOUT', '1');
    expect(auditStdout()).toBe(false);
    vi.stubEnv('AUDIT_STDOUT', ' TRUE ');
    expect(auditStdout()).toBe(true);
  });
  it('is read at call time', () => {
    vi.stubEnv('AUDIT_STDOUT', 'false');
    expect(auditStdout()).toBe(false);
    vi.stubEnv('AUDIT_STDOUT', 'true');
    expect(auditStdout()).toBe(true);
  });
});

describe('auditStoreIp', () => {
  it('defaults to true, also for garbage', () => {
    vi.stubEnv('AUDIT_STORE_IP', '');
    expect(auditStoreIp()).toBe(true);
    vi.stubEnv('AUDIT_STORE_IP', 'nej');
    expect(auditStoreIp()).toBe(true);
  });
  it('is false only for an explicit "false"', () => {
    vi.stubEnv('AUDIT_STORE_IP', ' False ');
    expect(auditStoreIp()).toBe(false);
  });
});

describe('auditRetentionDays', () => {
  it('is null (keep forever) when unset or invalid', () => {
    for (const v of ['', 'abc', '-5', '0', '1.5', '10d', '99999999999999999999']) {
      vi.stubEnv('AUDIT_RETENTION_DAYS', v);
      expect(auditRetentionDays()).toBeNull();
    }
  });
  it('parses a positive integer', () => {
    vi.stubEnv('AUDIT_RETENTION_DAYS', ' 365 ');
    expect(auditRetentionDays()).toBe(365);
  });
});

describe('auditFeedKeyHash', () => {
  const hash = 'a'.repeat(64);
  it('is null when unset or not a sha256 hex digest', () => {
    for (const v of ['', 'abc', 'g'.repeat(64), 'a'.repeat(63)]) {
      vi.stubEnv('AUDIT_FEED_API_KEY_HASH', v);
      expect(auditFeedKeyHash()).toBeNull();
    }
  });
  it('is normalised to lower case', () => {
    vi.stubEnv('AUDIT_FEED_API_KEY_HASH', ` ${hash.toUpperCase()} `);
    expect(auditFeedKeyHash()).toBe(hash);
  });
});

describe('auditFeedDelaySeconds', () => {
  it('defaults to 10', () => {
    vi.stubEnv('AUDIT_FEED_DELAY_SECONDS', '');
    expect(auditFeedDelaySeconds()).toBe(10);
    vi.stubEnv('AUDIT_FEED_DELAY_SECONDS', 'x');
    expect(auditFeedDelaySeconds()).toBe(10);
    vi.stubEnv('AUDIT_FEED_DELAY_SECONDS', '-3');
    expect(auditFeedDelaySeconds()).toBe(10);
  });
  it('accepts 0 and positive integers', () => {
    vi.stubEnv('AUDIT_FEED_DELAY_SECONDS', '0');
    expect(auditFeedDelaySeconds()).toBe(0);
    vi.stubEnv('AUDIT_FEED_DELAY_SECONDS', '30');
    expect(auditFeedDelaySeconds()).toBe(30);
  });
});

describe('internalCronSecret', () => {
  it('is null when unset or blank', () => {
    vi.stubEnv('INTERNAL_CRON_SECRET', '  ');
    expect(internalCronSecret()).toBeNull();
  });
  it('returns the trimmed secret', () => {
    vi.stubEnv('INTERNAL_CRON_SECRET', ' s3cret ');
    expect(internalCronSecret()).toBe('s3cret');
  });
});
