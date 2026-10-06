import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigError,
  accessSource,
  bootstrapAdminEmails,
  directoryMatchMode,
  directoryUserIdClaim,
  requireRoleToLogin,
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
  it('defaults to local when unset or blank', () => {
    vi.stubEnv('ACCESS_SOURCE', '   ');
    expect(accessSource()).toBe('local');
    vi.unstubAllEnvs();
    delete process.env.ACCESS_SOURCE;
    expect(accessSource()).toBe('local');
  });
  it('accepts local case-insensitively and trimmed', () => {
    vi.stubEnv('ACCESS_SOURCE', ' LOCAL ');
    expect(accessSource()).toBe('local');
  });
  it.each(['ldap', 'rolekatalog', 'local;', 'rollekatalog,local', 'true'])(
    'fails closed on the invalid value "%s": throws ConfigError, never falls back to local',
    (v) => {
      vi.stubEnv('ACCESS_SOURCE', v);
      expect(() => accessSource()).toThrow(ConfigError);
    },
  );
  it('throws the fixed message without echoing the value', () => {
    vi.stubEnv('ACCESS_SOURCE', 'sekret-typo');
    let err: unknown;
    try {
      accessSource();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).name).toBe('ConfigError');
    expect((err as Error).message).toBe('ACCESS_SOURCE must be "local" or "rollekatalog"');
    expect((err as Error).message).not.toContain('sekret');
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
