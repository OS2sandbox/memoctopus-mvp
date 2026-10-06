import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  directoryUserIdTransform,
  globalRoles,
  itSystemId,
  maxResponseBytes,
  orgKey,
  readKey,
  rollekatalogConfigIssue,
  rollekatalogDomain,
  rollekatalogUrl,
  roleStaleMaxSeconds,
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
  it('timeout: default 10s, invalid values fall back', () => {
    expect(timeoutMs()).toBe(10_000);
    vi.stubEnv('ROLLEKATALOG_TIMEOUT_MS', '1500');
    expect(timeoutMs()).toBe(1500);
    for (const bad of ['abc', '-5', '0', '5', '1.5', '999999999']) {
      vi.stubEnv('ROLLEKATALOG_TIMEOUT_MS', bad);
      expect(timeoutMs(), bad).toBe(10_000);
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
    expect(globalRoles()).toEqual(['tt-administrator']);
    vi.stubEnv('ROLLEKATALOG_GLOBAL_ROLES', 'tt-administrator, tt-logleser,tt-logleser');
    expect(globalRoles()).toEqual(['tt-administrator', 'tt-logleser']);
    vi.stubEnv('ROLLEKATALOG_GLOBAL_ROLES', 'none');
    expect(globalRoles()).toEqual([]);
    vi.stubEnv('ROLLEKATALOG_GLOBAL_ROLES', 'root,superuser');
    expect(globalRoles()).toEqual(['tt-administrator']);
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
  it('strip-upn-domain removes everything from the first @', () => {
    vi.stubEnv('DIRECTORY_USERID_TRANSFORM', 'Strip-UPN-Domain');
    expect(transformUserId('anne.p@example.dk')).toBe('anne.p');
    expect(transformUserId('anne.p')).toBe('anne.p');
    expect(transformUserId('@x')).toBe('@x');
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
