import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearLoginClaimsStash, stashLoginClaims, takeLoginClaims } from './claims-stash';

beforeEach(() => {
  vi.useFakeTimers();
  clearLoginClaimsStash();
});
afterEach(() => vi.useRealTimers());

describe('login claims hand-over', () => {
  it('hands claims over once, keyed by provider and account', () => {
    stashLoginClaims('oidc', 'a1', { roles: ['x'] });
    expect(takeLoginClaims('oidc', 'a2')).toBeNull();
    expect(takeLoginClaims('other', 'a1')).toBeNull();
    expect(takeLoginClaims('oidc', 'a1')).toEqual({ roles: ['x'] });
    expect(takeLoginClaims('oidc', 'a1')).toBeNull();
  });

  it('forgets after a minute', () => {
    stashLoginClaims('oidc', 'a1', { roles: ['x'] });
    vi.advanceTimersByTime(60_001);
    expect(takeLoginClaims('oidc', 'a1')).toBeNull();
  });

  it('cannot be confused by a separator in the ids', () => {
    stashLoginClaims('a', 'b:c', { r: 1 });
    expect(takeLoginClaims('a:b', 'c')).toBeNull();
  });

  it('stays bounded: an attacker starting many logins cannot grow it without limit', () => {
    for (let i = 0; i < 5000; i++) stashLoginClaims('oidc', `acct-${i}`, { i });
    let alive = 0;
    for (let i = 0; i < 5000; i++) if (takeLoginClaims('oidc', `acct-${i}`)) alive++;
    expect(alive).toBeLessThanOrEqual(1000);
    expect(alive).toBeGreaterThan(0);
  });
});
