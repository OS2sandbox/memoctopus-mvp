import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authConfigFilePath, loadAuthConfig, resetAuthConfigCache } from './config-file';

let dir: string;
let warn: ReturnType<typeof vi.spyOn>;

function writeConfig(content: unknown, name = 'auth.json'): string {
  const file = path.join(dir, name);
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  vi.stubEnv('AUTH_CONFIG_FILE', file);
  resetAuthConfigCache();
  return file;
}
const warned = () => JSON.stringify(warn.mock.calls);

const OIDC = {
  type: 'oidc',
  id: 'fka',
  label: 'FKA',
  clientId: 'cid',
  clientSecret: 'csecret',
  discoveryUrl: 'https://idp.example/.well-known/openid-configuration',
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'auth-config-'));
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubEnv('AUTH_CONFIG_FILE', '');
  resetAuthConfigCache();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetAuthConfigCache();
});

describe('AUTH_CONFIG_FILE', () => {
  it('is not configured without the variable (blank counts as unset)', () => {
    vi.stubEnv('AUTH_CONFIG_FILE', '   ');
    expect(authConfigFilePath()).toBeUndefined();
    expect(loadAuthConfig()).toMatchObject({ configured: false, providers: [], roles: { state: 'unset' } });
  });

  it('loads providers, defaults included', () => {
    writeConfig({ providers: [OIDC] });
    const cfg = loadAuthConfig();
    expect(cfg.configured).toBe(true);
    expect(cfg.providers).toHaveLength(1);
    expect(cfg.providers[0]).toMatchObject({
      type: 'oidc',
      id: 'fka',
      scopes: ['openid', 'profile', 'email'],
      pkce: true,
      clientSecret: 'csecret',
    });
  });

  it('expands ${ENV} in secrets and keeps the secret out of the warnings', () => {
    vi.stubEnv('FKA_SECRET', 'from-the-environment');
    writeConfig({ providers: [{ ...OIDC, clientSecret: '${FKA_SECRET}' }] });
    expect(loadAuthConfig().providers[0]).toMatchObject({ clientSecret: 'from-the-environment' });
    expect(warned()).not.toContain('from-the-environment');
  });

  it('skips a provider that references an unset variable and names only the variable', () => {
    writeConfig({ providers: [{ ...OIDC, clientSecret: '${NOT_SET_ANYWHERE}' }, { ...OIDC, id: 'other' }] });
    expect(loadAuthConfig().providers.map((p) => p.id)).toEqual(['other']);
    expect(warned()).toContain('NOT_SET_ANYWHERE');
  });

  it('a blank variable counts as unset', () => {
    vi.stubEnv('BLANK_ONE', '  ');
    writeConfig({ providers: [{ ...OIDC, clientSecret: '${BLANK_ONE}' }] });
    expect(loadAuthConfig().providers).toEqual([]);
  });

  it('fail-soft per provider: an invalid one is skipped with a content-free warning, the others stay', () => {
    writeConfig({
      providers: [
        { ...OIDC, id: 'Bad Id!' },
        { ...OIDC, id: 'microsoft' },
        { ...OIDC, id: 'noendpoints', discoveryUrl: undefined },
        { type: 'oidc', id: 'typo', clientId: 'x', clientSecret: 'topsecret-value', discoveryUrl: 'https://x.example/d', rolesClam: 'roles' },
        { type: 'ldap', id: 'x' },
        { ...OIDC, id: 'good' },
      ],
    });
    expect(loadAuthConfig().providers.map((p) => p.id)).toEqual(['good']);
    const out = warned();
    expect(out).toContain('providers[0]');
    expect(out).toContain('providers[3]');
    expect(out).not.toContain('topsecret-value');
    expect(out).not.toContain('Bad Id!');
  });

  it('ignores a duplicate provider id and a provider with enabled: false', () => {
    writeConfig({ providers: [OIDC, { ...OIDC, label: 'again' }, { ...OIDC, id: 'off', enabled: false }] });
    expect(loadAuthConfig().providers.map((p) => p.id)).toEqual(['fka']);
  });

  it('lower-cases the provider id like the legacy OIDC_PROVIDER_ID', () => {
    writeConfig({ providers: [{ ...OIDC, id: 'Keycloak' }] });
    expect(loadAuthConfig().providers[0].id).toBe('keycloak');
  });

  it('accepts explicit endpoints instead of a discovery URL', () => {
    writeConfig({
      providers: [{ type: 'oidc', id: 'ep', clientId: 'a', clientSecret: 'b', authorizationUrl: 'https://i/auth', tokenUrl: 'https://i/token', userInfoUrl: 'https://i/ui' }],
    });
    expect(loadAuthConfig().providers[0]).toMatchObject({ authorizationUrl: 'https://i/auth', tokenUrl: 'https://i/token' });
  });

  it('entra is always the built-in "microsoft" provider, with the tenant defaulting to common', () => {
    writeConfig({ providers: [{ type: 'entra', clientId: 'a', clientSecret: 'b', tenantId: 'tenant-1' }, { type: 'entra', clientId: 'c', clientSecret: 'd' }] });
    const cfg = loadAuthConfig();
    expect(cfg.providers).toHaveLength(1); // the second one reuses the id "microsoft"
    expect(cfg.providers[0]).toMatchObject({ type: 'entra', id: 'microsoft', tenantId: 'tenant-1' });
  });

  describe('claim lists', () => {
    it('a string is an array claim; the object form can say delimited', () => {
      writeConfig({
        providers: [{ ...OIDC, rolesClaim: 'roles', groupsClaim: { name: 'memberOf', format: 'delimited', separator: ';' } }],
      });
      expect(loadAuthConfig().providers[0]).toMatchObject({
        rolesClaim: { name: 'roles', format: 'array', separator: ',' },
        groupsClaim: { name: 'memberOf', format: 'delimited', separator: ';' },
      });
    });

    it('rejects an unknown format', () => {
      writeConfig({ providers: [{ ...OIDC, rolesClaim: { name: 'r', format: 'csv' } }] });
      expect(loadAuthConfig().providers).toEqual([]);
    });
  });

  describe('saml providers', () => {
    const SAML = { type: 'saml', id: 'kommune', entryPoint: 'https://idp.example/sso', idpEntityId: 'https://idp.example', cert: 'MIIC' };

    it('needs metadata, or entryPoint + entity id + cert', () => {
      writeConfig({ providers: [SAML, { type: 'saml', id: 'half', entryPoint: 'https://idp.example/sso' }] });
      expect(loadAuthConfig().providers.map((p) => p.id)).toEqual(['kommune']);
    });

    it('requires signed assertions and allows IdP-initiated login by default', () => {
      writeConfig({ providers: [SAML] });
      expect(loadAuthConfig().providers[0]).toMatchObject({ wantAssertionsSigned: true, allowIdpInitiated: true, authnRequestsSigned: false });
    });

    it('warns when signing is switched off', () => {
      writeConfig({ providers: [{ ...SAML, wantAssertionsSigned: false }] });
      loadAuthConfig();
      expect(warned()).toContain('wantAssertionsSigned is false');
    });

    it('reads the IdP metadata file once, and skips the provider when it cannot be read', () => {
      const meta = path.join(dir, 'idp.xml');
      writeFileSync(meta, '<EntityDescriptor/>');
      writeConfig({ providers: [{ type: 'saml', id: 'm', idpMetadataFile: meta }, { type: 'saml', id: 'gone', idpMetadataFile: path.join(dir, 'missing.xml') }] });
      const cfg = loadAuthConfig();
      expect(cfg.providers.map((p) => p.id)).toEqual(['m']);
      expect(cfg.providers[0]).toMatchObject({ idpMetadata: '<EntityDescriptor/>' });
    });

    it('authnRequestsSigned needs a private key', () => {
      writeConfig({ providers: [{ ...SAML, authnRequestsSigned: true }] });
      expect(loadAuthConfig().providers).toEqual([]);
    });
  });

  describe('roles (fail CLOSED)', () => {
    it('maps claim values to roles; the object form takes global, and global:false disables the entry', () => {
      writeConfig({
        providers: [OIDC],
        roles: {
          appRoleMap: { admin: 'tt-administrator', su: { role: 'tt-skabelonansvarlig' }, off: { role: 'tt-logleser', global: false } },
          groupRoleMap: { 'g-1': 'tt-bruger' },
        },
      });
      const { roles } = loadAuthConfig();
      if (roles.state !== 'ok') throw new Error('expected ok');
      expect([...roles.appRoleMap]).toEqual([
        ['admin', { role: 'tt-administrator', global: true }],
        ['su', { role: 'tt-skabelonansvarlig', global: true }],
      ]);
      expect([...roles.groupRoleMap.keys()]).toEqual(['g-1']);
    });

    it('is "unset" when the section is absent', () => {
      writeConfig({ providers: [OIDC] });
      expect(loadAuthConfig().roles).toEqual({ state: 'unset' });
    });

    it.each([
      ['an unknown role key', { appRoleMap: { x: 'tt-god' } }],
      ['a misspelt section key', { appRolMap: { x: 'tt-administrator' } }],
      ['a map that is not an object', { appRoleMap: ['tt-administrator'] }],
      ['an entry with extra keys', { appRoleMap: { x: { role: 'tt-administrator', scope: 'u' } } }],
    ])('is invalid for %s: nobody gets a role', (_name, roles) => {
      writeConfig({ providers: [OIDC], roles });
      expect(loadAuthConfig().roles).toEqual({ state: 'invalid' });
      // ...but the providers still work: only the mapping is closed.
      expect(loadAuthConfig().providers).toHaveLength(1);
    });

    it('is invalid when a value references an unset variable (keys are never expanded)', () => {
      writeConfig({ roles: { appRoleMap: { admin: '${NOT_SET_ANYWHERE}' } } });
      expect(loadAuthConfig().roles).toEqual({ state: 'invalid' });
      writeConfig({ roles: { appRoleMap: { '${NOT_SET_ANYWHERE}': 'tt-administrator' } } });
      const { roles } = loadAuthConfig();
      expect(roles.state === 'ok' && [...roles.appRoleMap.keys()]).toEqual(['${NOT_SET_ANYWHERE}']);
    });

    it('an unknown top-level key closes the roles too (a misspelt "roles" must not mean "no mapping")', () => {
      writeConfig({ providers: [OIDC], rolez: { appRoleMap: {} }, roles: { appRoleMap: { a: 'tt-administrator' } } });
      expect(loadAuthConfig().roles).toEqual({ state: 'invalid' });
    });

    it('an unreadable or non-JSON file: no providers, roles invalid', () => {
      writeConfig('{ not json');
      expect(loadAuthConfig()).toMatchObject({ configured: true, providers: [], roles: { state: 'invalid' } });
      vi.stubEnv('AUTH_CONFIG_FILE', path.join(dir, 'nope.json'));
      resetAuthConfigCache();
      expect(loadAuthConfig()).toMatchObject({ configured: true, providers: [], roles: { state: 'invalid' } });
    });

    it('a top-level array is not a config', () => {
      writeConfig('[]');
      expect(loadAuthConfig().roles).toEqual({ state: 'invalid' });
    });
  });

  describe('catalogue', () => {
    it('keeps valid entries, first duplicate wins', () => {
      writeConfig({
        catalogue: [
          { kind: 'role', identifier: 'r1', name: 'Rolle 1' },
          { kind: 'role', identifier: 'r1', name: 'dup' },
          { kind: 'group', identifier: 'r1', name: 'Same id, other kind' },
        ],
      });
      expect(loadAuthConfig().catalogue).toEqual([
        { kind: 'role', identifier: 'r1', name: 'Rolle 1' },
        { kind: 'group', identifier: 'r1', name: 'Same id, other kind' },
      ]);
    });

    it('an invalid catalogue is dropped as a whole (nothing stored), without touching roles or providers', () => {
      writeConfig({ providers: [OIDC], roles: { appRoleMap: { a: 'tt-administrator' } }, catalogue: [{ kind: 'team', identifier: 'x', name: 'y' }] });
      const cfg = loadAuthConfig();
      expect(cfg.catalogue).toEqual([]);
      expect(cfg.roles.state).toBe('ok');
      expect(cfg.providers).toHaveLength(1);
    });
  });

  it('reads the file once per process: a later edit needs a restart', () => {
    const file = writeConfig({ providers: [OIDC] });
    expect(loadAuthConfig().providers).toHaveLength(1);
    writeFileSync(file, JSON.stringify({ providers: [] }));
    expect(loadAuthConfig().providers).toHaveLength(1);
    resetAuthConfigCache();
    expect(loadAuthConfig().providers).toHaveLength(0);
  });
});
