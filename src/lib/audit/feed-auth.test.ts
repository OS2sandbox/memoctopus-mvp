import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CRON_SECRET_HEADER, FEED_KEY_HEADER, checkFeedKey, cronGuard, feedGuard, secretEquals } from './feed-auth';

const hashOf = (k: string) => createHash('sha256').update(k).digest('hex');
const KEY = 'a-long-random-service-key';
const reqWith = (headers: Record<string, string>) => ({ headers: new Headers(headers) });

afterEach(() => vi.unstubAllEnvs());

describe('checkFeedKey', () => {
  it('is disabled without a configured hash, whatever the caller sends', () => {
    expect(checkFeedKey(KEY, null)).toBe('disabled');
    expect(checkFeedKey(null, null)).toBe('disabled');
  });

  it('accepts the key whose sha256 matches', () => {
    expect(checkFeedKey(KEY, hashOf(KEY))).toBe('ok');
  });

  it.each([
    ['a missing key', null],
    ['an empty key', ''],
    ['a wrong key', 'nope'],
    ['the hash itself instead of the key', hashOf(KEY)],
    ['the key with a trailing space', `${KEY} `],
    ['an oversized value', 'x'.repeat(10_000)],
  ])('rejects %s', (_l, provided) => {
    expect(checkFeedKey(provided, hashOf(KEY))).toBe('unauthorized');
  });

  it('rejects when the stored hash is not 32 bytes of hex', () => {
    expect(checkFeedKey(KEY, 'abcd')).toBe('unauthorized');
  });
});

describe('feedGuard', () => {
  it('404 when AUDIT_FEED_API_KEY_HASH is unset (the feed does not exist)', async () => {
    vi.stubEnv('AUDIT_FEED_API_KEY_HASH', '');
    const res = feedGuard(reqWith({ [FEED_KEY_HEADER]: KEY }))!;
    expect(res.status).toBe(404);
  });

  it('404 when the configured value is not a sha256 hex (treated as unset)', () => {
    vi.stubEnv('AUDIT_FEED_API_KEY_HASH', 'not-a-hash');
    expect(feedGuard(reqWith({ [FEED_KEY_HEADER]: KEY }))!.status).toBe(404);
  });

  it('401 on a missing or wrong key, and never echoes it', async () => {
    vi.stubEnv('AUDIT_FEED_API_KEY_HASH', hashOf(KEY));
    expect(feedGuard(reqWith({}))!.status).toBe(401);
    const res = feedGuard(reqWith({ [FEED_KEY_HEADER]: 'wrong-key-value' }))!;
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('wrong-key-value');
  });

  it('does not accept the key as a bearer token', () => {
    vi.stubEnv('AUDIT_FEED_API_KEY_HASH', hashOf(KEY));
    expect(feedGuard(reqWith({ authorization: `Bearer ${KEY}` }))!.status).toBe(401);
  });

  it('lets the right key through (null)', () => {
    vi.stubEnv('AUDIT_FEED_API_KEY_HASH', hashOf(KEY).toUpperCase());
    expect(feedGuard(reqWith({ [FEED_KEY_HEADER]: KEY }))).toBeNull();
  });
});

describe('cronGuard', () => {
  it('404 when INTERNAL_CRON_SECRET is unset', () => {
    vi.stubEnv('INTERNAL_CRON_SECRET', '');
    expect(cronGuard(reqWith({ [CRON_SECRET_HEADER]: 'x' }))!.status).toBe(404);
  });

  it('401 on a missing or wrong secret', () => {
    vi.stubEnv('INTERNAL_CRON_SECRET', 's3cret-value');
    expect(cronGuard(reqWith({}))!.status).toBe(401);
    expect(cronGuard(reqWith({ [CRON_SECRET_HEADER]: 's3cret-valuf' }))!.status).toBe(401);
    expect(cronGuard(reqWith({ [CRON_SECRET_HEADER]: 's3cret' }))!.status).toBe(401);
    expect(cronGuard(reqWith({ [CRON_SECRET_HEADER]: 'x'.repeat(5000) }))!.status).toBe(401);
  });

  it('null for the right secret', () => {
    vi.stubEnv('INTERNAL_CRON_SECRET', 's3cret-value');
    expect(cronGuard(reqWith({ [CRON_SECRET_HEADER]: 's3cret-value' }))).toBeNull();
  });
});

describe('secretEquals', () => {
  it('compares values of different lengths without throwing', () => {
    expect(secretEquals('a', 'abcdef')).toBe(false);
    expect(secretEquals('abc', 'abc')).toBe(true);
  });
});
