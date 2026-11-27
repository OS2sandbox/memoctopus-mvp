import { afterEach, describe, expect, it, vi } from 'vitest';
import { CRON_SECRET_HEADER, cronGuard, secretEquals } from './internal-auth';

const reqWith = (headers: Record<string, string>) => ({ headers: new Headers(headers) });

afterEach(() => vi.unstubAllEnvs());

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
