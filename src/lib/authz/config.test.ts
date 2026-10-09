import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigError,
  accessSource,
  bootstrapAdminEmails,
  directoryMatchMode,
  directoryUserIdClaim,
  localAdminEnabled,
  requireRoleToLogin,
  roleClaimsMaxSeconds,
  singleTenantId,
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
  it('accepts claims case-insensitively and trimmed', () => {
    vi.stubEnv('ACCESS_SOURCE', ' Claims ');
    expect(accessSource()).toBe('claims');
  });
  it('accepts local case-insensitively and trimmed', () => {
    vi.stubEnv('ACCESS_SOURCE', ' LOCAL ');
    expect(accessSource()).toBe('local');
  });
  it.each(['ldap', 'rolekatalog', 'local;', 'rollekatalog,local', 'true', 'claim', 'claims,local', 'oidc'])(
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
    expect((err as Error).message).toBe('ACCESS_SOURCE must be "local", "rollekatalog" or "claims"');
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

  it('in claims mode it defaults to TRUE (no mapped role, no access); only an explicit "false" opens it', () => {
    vi.stubEnv('ACCESS_SOURCE', 'claims');
    for (const v of ['', '   ', '1', 'yes', 'true', 'nonsense']) {
      vi.stubEnv('REQUIRE_ROLE_TO_LOGIN', v);
      expect(requireRoleToLogin(), v).toBe(true);
    }
    vi.stubEnv('REQUIRE_ROLE_TO_LOGIN', ' False ');
    expect(requireRoleToLogin()).toBe(false);
  });

  it('an invalid ACCESS_SOURCE does not throw here (the access guards answer 503 themselves)', () => {
    vi.stubEnv('ACCESS_SOURCE', 'claim');
    vi.stubEnv('REQUIRE_ROLE_TO_LOGIN', '');
    expect(requireRoleToLogin()).toBe(false);
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

describe('localAdminEnabled (kill switch ACCESS_LOCAL_ADMIN)', () => {
  it('defaults to on in local mode only', () => {
    vi.stubEnv('ACCESS_SOURCE', 'local');
    vi.stubEnv('ACCESS_LOCAL_ADMIN', '');
    expect(localAdminEnabled()).toBe(true);
    for (const mode of ['rollekatalog', 'claims']) {
      vi.stubEnv('ACCESS_SOURCE', mode);
      expect(localAdminEnabled()).toBe(false);
    }
  });
  it('is switched off by "false" (any case, trimmed) in local mode', () => {
    vi.stubEnv('ACCESS_SOURCE', 'local');
    vi.stubEnv('ACCESS_LOCAL_ADMIN', ' False ');
    expect(localAdminEnabled()).toBe(false);
  });
  it('anything else keeps it on in local mode (it is a kill switch, not an opt-in)', () => {
    vi.stubEnv('ACCESS_SOURCE', 'local');
    for (const v of ['true', '0', 'no', 'off']) {
      vi.stubEnv('ACCESS_LOCAL_ADMIN', v);
      expect(localAdminEnabled()).toBe(true);
    }
  });
  it('can never be forced on outside local mode: local grants are inert there', () => {
    vi.stubEnv('ACCESS_LOCAL_ADMIN', 'true');
    vi.stubEnv('ACCESS_SOURCE', 'claims');
    expect(localAdminEnabled()).toBe(false);
    vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
    expect(localAdminEnabled()).toBe(false);
  });
  it('an invalid ACCESS_SOURCE throws instead of answering', () => {
    vi.stubEnv('ACCESS_SOURCE', 'rolekatalog');
    expect(() => localAdminEnabled()).toThrow(ConfigError);
  });
});

describe('roleClaimsMaxSeconds (ROLE_CLAIMS_MAX_SECONDS)', () => {
  it('defaults to 8 hours', () => {
    vi.stubEnv('ROLE_CLAIMS_MAX_SECONDS', '');
    expect(roleClaimsMaxSeconds()).toBe(28_800);
  });
  it('takes an integer within 1 minute .. 30 days', () => {
    vi.stubEnv('ROLE_CLAIMS_MAX_SECONDS', '3600');
    expect(roleClaimsMaxSeconds()).toBe(3600);
    vi.stubEnv('ROLE_CLAIMS_MAX_SECONDS', '60');
    expect(roleClaimsMaxSeconds()).toBe(60);
    vi.stubEnv('ROLE_CLAIMS_MAX_SECONDS', String(30 * 86_400));
    expect(roleClaimsMaxSeconds()).toBe(30 * 86_400);
  });
  it.each(['0', '-5', '59', '1.5', 'soon', '99999999999', String(30 * 86_400 + 1), '1e3'])('falls back to the default for "%s", never to "unlimited"', (v) => {
    vi.stubEnv('ROLE_CLAIMS_MAX_SECONDS', v);
    expect(roleClaimsMaxSeconds()).toBe(28_800);
  });
});

describe('singleTenantId', () => {
  it('is the tenant only when it names exactly one tenant', () => {
    vi.stubEnv('MICROSOFT_TENANT_ID', ' Tenant-1 ');
    expect(singleTenantId()).toBe('tenant-1');
    for (const alias of ['common', 'organizations', 'consumers', '']) {
      vi.stubEnv('MICROSOFT_TENANT_ID', alias);
      expect(singleTenantId()).toBeNull();
    }
  });
});
