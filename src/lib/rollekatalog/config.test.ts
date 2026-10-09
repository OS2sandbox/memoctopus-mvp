import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  catalogueConfigIssue,
  directoryConfigIssue,
  directoryUserIdDomain,
  directoryUserIdTransform,
  globalRoles,
  itSystemId,
  maxResponseBytes,
  orgKey,
  readKey,
  rollekatalogConfigIssue,
  rollekatalogDomain,
  rollekatalogUrl,
  roleGroupsPath,
  roleStaleMaxSeconds,
  rolesPath,
  scopeDescendants,
  syncMaxRemovalPercent,
  timeoutMs,
  transformUserId,
} from './config';

afterEach(() => vi.unstubAllEnvs());

describe('rollekatalogUrl', () => {
  it('is not_configured when unset, blank or unparseable', () => {
    for (const v of ['', '   ', 'not a url', 'ftp://rk.example.dk', 'rk.example.dk']) {
      vi.stubEnv('ROLLEKATALOG_URL', v);
      expect(rollekatalogUrl()).toEqual({ url: null, issue: 'not_configured' });
    }
  });
  it('accepts https and strips trailing slashes, query and hash', () => {
    vi.stubEnv('ROLLEKATALOG_URL', ' https://rk.example.dk/base/?x=1#h ');
    expect(rollekatalogUrl()).toEqual({ url: 'https://rk.example.dk/base', issue: null });
    vi.stubEnv('ROLLEKATALOG_URL', 'https://rk.example.dk/');
    expect(rollekatalogUrl().url).toBe('https://rk.example.dk');
  });
  it('refuses plain http for a remote host (insecure_url)', () => {
    vi.stubEnv('ROLLEKATALOG_URL', 'http://rk.example.dk');
    expect(rollekatalogUrl()).toEqual({ url: null, issue: 'insecure_url' });
  });
  it('allows plain http for loopback hosts', () => {
    for (const host of ['localhost:8080', '127.0.0.1:8080', '[::1]:8080']) {
      vi.stubEnv('ROLLEKATALOG_URL', `http://${host}`);
      expect(rollekatalogUrl().issue, host).toBeNull();
    }
  });
  it('allows plain http for a remote host only with ROLLEKATALOG_ALLOW_HTTP=true', () => {
    vi.stubEnv('ROLLEKATALOG_URL', 'http://rk.internal');
    vi.stubEnv('ROLLEKATALOG_ALLOW_HTTP', 'true');
    expect(rollekatalogUrl()).toEqual({ url: 'http://rk.internal', issue: null });
    vi.stubEnv('ROLLEKATALOG_ALLOW_HTTP', '1');
    expect(rollekatalogUrl().issue).toBe('insecure_url');
  });
  it('refuses credentials in the URL', () => {
    vi.stubEnv('ROLLEKATALOG_URL', 'https://user:pw@rk.example.dk');
    expect(rollekatalogUrl()).toEqual({ url: null, issue: 'not_configured' });
  });
});

describe('keys and config issue', () => {
  it('readKey/orgKey are null when unset or blank and trimmed otherwise', () => {
    vi.stubEnv('ROLLEKATALOG_READ_API_KEY', '  ');
    expect(readKey()).toBeNull();
    expect(orgKey()).toBeNull();
    vi.stubEnv('ROLLEKATALOG_READ_API_KEY', ' k1 ');
    vi.stubEnv('ROLLEKATALOG_ORG_API_KEY', 'k2');
    expect(readKey()).toBe('k1');
    expect(orgKey()).toBe('k2');
  });
  it('is configured only with a usable URL and both keys', () => {
    vi.stubEnv('ROLLEKATALOG_URL', 'https://rk.example.dk');
    vi.stubEnv('ROLLEKATALOG_READ_API_KEY', 'a');
    expect(rollekatalogConfigIssue()).toBe('not_configured');
    vi.stubEnv('ROLLEKATALOG_ORG_API_KEY', 'b');
    expect(rollekatalogConfigIssue()).toBeNull();
    vi.stubEnv('ROLLEKATALOG_URL', 'http://rk.example.dk');
    expect(rollekatalogConfigIssue()).toBe('insecure_url');
  });
});

describe('simple settings', () => {
  it('itSystemId defaults and rejects characters that do not belong in a path segment', () => {
    expect(itSystemId()).toBe('os2taletiltekst');
    vi.stubEnv('ROLLEKATALOG_ITSYSTEM_ID', 'my-system_1');
    expect(itSystemId()).toBe('my-system_1');
    vi.stubEnv('ROLLEKATALOG_ITSYSTEM_ID', '../etc/passwd');
    expect(itSystemId()).toBe('os2taletiltekst');
  });
  it('domain is optional', () => {
    expect(rollekatalogDomain()).toBeNull();
    vi.stubEnv('ROLLEKATALOG_DOMAIN', ' Administrativt ');
    expect(rollekatalogDomain()).toBe('Administrativt');
  });
  it('timeout: default 120000 (2 min), valid values pass through', () => {
    expect(timeoutMs()).toBe(120_000);
    for (const ok of ['1000', '1500', '30000', '300000']) {
      vi.stubEnv('ROLLEKATALOG_TIMEOUT_MS', ok);
      expect(timeoutMs(), ok).toBe(Number(ok));
    }
  });
  it('timeout: out-of-range, non-numeric and blank values fall back to the default', () => {
    for (const bad of ['999', '300001', '600000', '600001', '100', '0', '-5', '1.5', 'abc', '10s', '', '   ', '999999999']) {
      vi.stubEnv('ROLLEKATALOG_TIMEOUT_MS', bad);
      expect(timeoutMs(), JSON.stringify(bad)).toBe(120_000);
    }
  });
  it('max response bytes defaults to 64 MiB', () => {
    expect(maxResponseBytes()).toBe(64 * 1024 * 1024);
    vi.stubEnv('ROLLEKATALOG_MAX_RESPONSE_BYTES', '2048');
    expect(maxResponseBytes()).toBe(2048);
    vi.stubEnv('ROLLEKATALOG_MAX_RESPONSE_BYTES', '12');
    expect(maxResponseBytes()).toBe(64 * 1024 * 1024);
  });
  it('scope descendants defaults to true', () => {
    expect(scopeDescendants()).toBe(true);
    vi.stubEnv('ROLLEKATALOG_SCOPE_DESCENDANTS', 'false');
    expect(scopeDescendants()).toBe(false);
    vi.stubEnv('ROLLEKATALOG_SCOPE_DESCENDANTS', 'maybe');
    expect(scopeDescendants()).toBe(true);
  });
  it('global roles: default administrator only; none; unknown tokens dropped', () => {
    expect(globalRoles()).toEqual(['admin']);
    vi.stubEnv('ROLLEKATALOG_GLOBAL_ROLES', 'admin, bygger,bygger');
    expect(globalRoles()).toEqual(['admin', 'bygger']);
    vi.stubEnv('ROLLEKATALOG_GLOBAL_ROLES', 'none');
    expect(globalRoles()).toEqual([]);
    vi.stubEnv('ROLLEKATALOG_GLOBAL_ROLES', 'root,superuser');
    expect(globalRoles()).toEqual(['admin']);
  });
  it('removal percent and stale seconds validate and fall back', () => {
    expect(syncMaxRemovalPercent()).toBe(30);
    vi.stubEnv('ROLLEKATALOG_SYNC_MAX_REMOVAL_PERCENT', '0');
    expect(syncMaxRemovalPercent()).toBe(0);
    vi.stubEnv('ROLLEKATALOG_SYNC_MAX_REMOVAL_PERCENT', '101');
    expect(syncMaxRemovalPercent()).toBe(30);
    expect(roleStaleMaxSeconds()).toBe(86_400);
    vi.stubEnv('ROLE_STALE_MAX_SECONDS', '3600');
    expect(roleStaleMaxSeconds()).toBe(3600);
    vi.stubEnv('ROLE_STALE_MAX_SECONDS', '-1');
    expect(roleStaleMaxSeconds()).toBe(86_400);
  });
});

describe('DIRECTORY_USERID_TRANSFORM', () => {
  it('is none by default and leaves the value alone', () => {
    expect(directoryUserIdTransform()).toBe('none');
    expect(transformUserId('anne.p@example.dk')).toBe('anne.p@example.dk');
  });
  it('strip-upn-domain needs the configured domain: name@domain only, case-insensitive', () => {
    vi.stubEnv('DIRECTORY_USERID_TRANSFORM', 'Strip-UPN-Domain');
    vi.stubEnv('DIRECTORY_USERID_DOMAIN', 'Example.DK');
    expect(transformUserId('anne.p@example.dk')).toBe('anne.p');
    expect(transformUserId('Anne.P@EXAMPLE.dk')).toBe('Anne.P');
    expect(transformUserId('  anne.p@example.dk ')).toBe('anne.p');
  });
  it('strip-upn-domain tolerates a leading @ in the domain setting', () => {
    vi.stubEnv('DIRECTORY_USERID_TRANSFORM', 'strip-upn-domain');
    vi.stubEnv('DIRECTORY_USERID_DOMAIN', '@example.dk');
    expect(directoryUserIdDomain()).toBe('example.dk');
    expect(transformUserId('anne.p@example.dk')).toBe('anne.p');
  });
  it('strip-upn-domain gives no match for a foreign domain, #EXT#, two @, no @ or an empty name', () => {
    vi.stubEnv('DIRECTORY_USERID_TRANSFORM', 'strip-upn-domain');
    vi.stubEnv('DIRECTORY_USERID_DOMAIN', 'example.dk');
    expect(transformUserId('abc123@evil.com')).toBeNull();
    expect(transformUserId('abc123@example.dk.evil.com')).toBeNull();
    expect(transformUserId('abc123@sub.example.dk')).toBeNull();
    expect(transformUserId('abc123_example.dk#EXT#@example.dk')).toBeNull();
    expect(transformUserId('a@b@example.dk')).toBeNull();
    expect(transformUserId('anne.p')).toBeNull();
    expect(transformUserId('@example.dk')).toBeNull();
    expect(transformUserId('')).toBeNull();
  });
  it('strip-upn-domain without a usable domain matches nothing and is reported as a config issue', () => {
    vi.stubEnv('DIRECTORY_USERID_TRANSFORM', 'strip-upn-domain');
    for (const blank of ['', '   ', '@', 'a@b', 'ex ample.dk']) {
      vi.stubEnv('DIRECTORY_USERID_DOMAIN', blank);
      expect(transformUserId('anne.p@example.dk')).toBeNull();
      expect(directoryConfigIssue()).toBe('userid_domain_missing');
    }
    vi.stubEnv('DIRECTORY_USERID_DOMAIN', 'example.dk');
    expect(directoryConfigIssue()).toBeNull();
  });
  it('reports no directory issue when the transform is none, whatever the domain', () => {
    expect(directoryConfigIssue()).toBeNull();
    vi.stubEnv('DIRECTORY_USERID_DOMAIN', '');
    expect(directoryConfigIssue()).toBeNull();
  });
  it('falls back to none on junk', () => {
    vi.stubEnv('DIRECTORY_USERID_TRANSFORM', 'lowercase');
    expect(directoryUserIdTransform()).toBe('none');
  });
});

describe('read at call time', () => {
  it('never throws at import and reflects later env changes', () => {
    vi.stubEnv('ROLLEKATALOG_TIMEOUT_MS', '2000');
    expect(timeoutMs()).toBe(2000);
    vi.stubEnv('ROLLEKATALOG_TIMEOUT_MS', '3000');
    expect(timeoutMs()).toBe(3000);
  });
});

describe('role catalogue settings', () => {
  it('needs a usable URL and the READ key only (not the ORG key)', () => {
    vi.stubEnv('ROLLEKATALOG_URL', 'https://rk.example.dk');
    vi.stubEnv('ROLLEKATALOG_READ_API_KEY', 'read');
    vi.stubEnv('ROLLEKATALOG_ORG_API_KEY', '');
    expect(catalogueConfigIssue()).toBeNull();
    // The full sync needs both keys; the catalogue does not.
    expect(rollekatalogConfigIssue()).toBe('not_configured');
    vi.stubEnv('ROLLEKATALOG_READ_API_KEY', '');
    expect(catalogueConfigIssue()).toBe('not_configured');
    vi.stubEnv('ROLLEKATALOG_READ_API_KEY', 'read');
    vi.stubEnv('ROLLEKATALOG_URL', 'http://rk.example.dk');
    expect(catalogueConfigIssue()).toBe('insecure_url');
    vi.stubEnv('ROLLEKATALOG_URL', '');
    expect(catalogueConfigIssue()).toBe('not_configured');
  });

  it('defaults to the paths of the OS2rollekatalog read API (unverified against a live instance)', () => {
    expect(rolesPath()).toBe('/api/read/userroles/itsystems');
    expect(roleGroupsPath()).toBe('/api/read/rolegroups');
  });

  it('takes an override only under /api/read/, and none switches a list off', () => {
    vi.stubEnv('ROLLEKATALOG_ROLES_PATH', '/api/read/userroles');
    expect(rolesPath()).toBe('/api/read/userroles');
    vi.stubEnv('ROLLEKATALOG_ROLEGROUPS_PATH', 'NONE');
    expect(roleGroupsPath()).toBeNull();
    vi.stubEnv('ROLLEKATALOG_ROLES_PATH', ' ');
    expect(rolesPath()).toBe('/api/read/userroles/itsystems');
  });

  it.each([
    '/api/organisation/v3',
    '/api/read/',
    '/api/read/../organisation/v3',
    '/api/read/userroles?x=1',
    '/api/read//userroles',
    'https://evil.example/api/read/userroles',
    '//evil.example/api/read/x',
    '/api/read/a/b/c/d/e',
    '/api/read/userroles#frag',
    '/api/read/user roles',
  ])('falls back to the default for the path %j (nothing outside the read API, no query, no other host)', (bad) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('ROLLEKATALOG_ROLES_PATH', bad);
    vi.stubEnv('ROLLEKATALOG_ROLEGROUPS_PATH', bad);
    expect(rolesPath()).toBe('/api/read/userroles/itsystems');
    expect(roleGroupsPath()).toBe('/api/read/rolegroups');
    // One content-free line per fallback: the variable's name, never its value.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toContain('ROLLEKATALOG_ROLES_PATH');
    expect(warn.mock.calls.flat().join(' ')).not.toContain(bad);
    warn.mockRestore();
  });

  it('does not warn for the default, an override or none', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('ROLLEKATALOG_ROLEGROUPS_PATH', 'none');
    rolesPath();
    roleGroupsPath();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
