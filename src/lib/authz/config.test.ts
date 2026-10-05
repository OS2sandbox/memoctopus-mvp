import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  accessSource,
  bootstrapAdminEmails,
  directoryMatchMode,
  directoryUserIdClaim,
  directoryUserIdTransform,
  requireRoleToLogin,
  transformUserId,
} from './config';

afterEach(() => vi.unstubAllEnvs());

describe('accessSource', () => {
  it('defaults to local', () => {
    vi.stubEnv('ACCESS_SOURCE', '');
    expect(accessSource()).toBe('local');
  });
  it('accepts rollekatalog case-insensitively and trimmed', () => {
    vi.stubEnv('ACCESS_SOURCE', '  Rollekatalog ');
    expect(accessSource()).toBe('rollekatalog');
  });
  it('falls back to local for invalid values without throwing', () => {
    vi.stubEnv('ACCESS_SOURCE', 'ldap');
    expect(accessSource()).toBe('local');
  });
  it('is read at call time', () => {
    vi.stubEnv('ACCESS_SOURCE', 'local');
    expect(accessSource()).toBe('local');
    vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
    expect(accessSource()).toBe('rollekatalog');
  });
});

describe('requireRoleToLogin', () => {
  it('is false by default and for anything but "true"', () => {
    vi.stubEnv('REQUIRE_ROLE_TO_LOGIN', '');
    expect(requireRoleToLogin()).toBe(false);
    vi.stubEnv('REQUIRE_ROLE_TO_LOGIN', '1');
    expect(requireRoleToLogin()).toBe(false);
    vi.stubEnv('REQUIRE_ROLE_TO_LOGIN', 'false');
    expect(requireRoleToLogin()).toBe(false);
  });
  it('is true for "true" in any case', () => {
    vi.stubEnv('REQUIRE_ROLE_TO_LOGIN', ' TRUE ');
    expect(requireRoleToLogin()).toBe(true);
  });
});

describe('bootstrapAdminEmails', () => {
  it('is empty when unset', () => {
    vi.stubEnv('BOOTSTRAP_ADMIN_EMAILS', '');
    expect(bootstrapAdminEmails()).toEqual([]);
  });
  it('trims, lower-cases, drops blanks and duplicates', () => {
    vi.stubEnv('BOOTSTRAP_ADMIN_EMAILS', ' Admin@Example.DK, ,b@example.dk,admin@example.dk,');
    expect(bootstrapAdminEmails()).toEqual(['admin@example.dk', 'b@example.dk']);
  });
});

describe('directoryMatchMode', () => {
  it('defaults to userid-claim', () => {
    vi.stubEnv('DIRECTORY_MATCH', '');
    expect(directoryMatchMode()).toBe('userid-claim');
  });
  it('accepts the three modes case-insensitively', () => {
    vi.stubEnv('DIRECTORY_MATCH', 'EMAIL');
    expect(directoryMatchMode()).toBe('email');
    vi.stubEnv('DIRECTORY_MATCH', 'extuuid-claim');
    expect(directoryMatchMode()).toBe('extuuid-claim');
    vi.stubEnv('DIRECTORY_MATCH', 'userid-claim');
    expect(directoryMatchMode()).toBe('userid-claim');
  });
  it('falls back to userid-claim for invalid values', () => {
    vi.stubEnv('DIRECTORY_MATCH', 'upn');
    expect(directoryMatchMode()).toBe('userid-claim');
  });
});

describe('directoryUserIdClaim', () => {
  it('defaults to preferred_username', () => {
    vi.stubEnv('DIRECTORY_USERID_CLAIM', '  ');
    expect(directoryUserIdClaim()).toBe('preferred_username');
  });
  it('uses a trimmed override and keeps its case (claim names are case-sensitive)', () => {
    vi.stubEnv('DIRECTORY_USERID_CLAIM', ' sAMAccountName ');
    expect(directoryUserIdClaim()).toBe('sAMAccountName');
  });
});

describe('DIRECTORY_USERID_TRANSFORM', () => {
  it('defaults to none and ignores unknown values without throwing', () => {
    vi.stubEnv('DIRECTORY_USERID_TRANSFORM', '');
    expect(directoryUserIdTransform()).toBe('none');
    vi.stubEnv('DIRECTORY_USERID_TRANSFORM', 'lowercase');
    expect(directoryUserIdTransform()).toBe('none');
  });
  it('accepts strip-upn-domain case-insensitively and trimmed, at call time', () => {
    vi.stubEnv('DIRECTORY_USERID_TRANSFORM', ' Strip-UPN-Domain ');
    expect(directoryUserIdTransform()).toBe('strip-upn-domain');
    vi.stubEnv('DIRECTORY_USERID_TRANSFORM', 'none');
    expect(directoryUserIdTransform()).toBe('none');
  });
  it.each([
    ['none', 'ABC123@kommune.dk', 'ABC123@kommune.dk'],
    ['strip-upn-domain', 'ABC123@kommune.dk', 'ABC123'],
    ['strip-upn-domain', 'ABC123', 'ABC123'],
    ['strip-upn-domain', 'a@b@c.dk', 'a'],
    ['strip-upn-domain', '@kommune.dk', '@kommune.dk'],
  ])('transformUserId with %s: %s -> %s', (mode, input, expected) => {
    vi.stubEnv('DIRECTORY_USERID_TRANSFORM', mode);
    expect(transformUserId(input)).toBe(expected);
  });
});
