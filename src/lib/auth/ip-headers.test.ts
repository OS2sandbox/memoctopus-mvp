import { afterEach, describe, expect, it, vi } from 'vitest';
import { authIpHeaders } from './ip-headers';

afterEach(() => vi.unstubAllEnvs());

describe('authIpHeaders', () => {
  it('is undefined when unset or blank (better-auth default)', () => {
    vi.stubEnv('AUTH_IP_HEADERS', '');
    expect(authIpHeaders()).toBeUndefined();
    vi.stubEnv('AUTH_IP_HEADERS', ' , ');
    expect(authIpHeaders()).toBeUndefined();
  });
  it('parses a trimmed, lower-cased comma list', () => {
    vi.stubEnv('AUTH_IP_HEADERS', ' X-Real-IP, x-forwarded-for ');
    expect(authIpHeaders()).toEqual(['x-real-ip', 'x-forwarded-for']);
  });
});
