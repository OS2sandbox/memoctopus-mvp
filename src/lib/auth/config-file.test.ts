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

const TENANT = '11111111-2222-3333-4444-555555555555';

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

  it('entra is always the built-in "microsoft" provider and needs ONE tenant (a GUID): no "common" default', () => {
    writeConfig({
      providers: [
        { type: 'entra', clientId: 'a', clientSecret: 'b', tenantId: TENANT.toUpperCase() },
        { type: 'entra', clientId: 'c', clientSecret: 'd', tenantId: TENANT },
      ],
    });
    const cfg = loadAuthConfig();
    expect(cfg.providers).toHaveLength(1); // the second one reuses the id "microsoft"
    expect(cfg.providers[0]).toMatchObject({ type: 'entra', id: 'microsoft', tenantId: TENANT });
  });

  it.each([['missing', undefined], ['common', 'common'], ['organizations', 'organizations'], ['consumers', 'consumers'], ['a name', 'contoso.onmicrosoft.com']])(
    'skips an entra provider whose tenant is %s, with a content-free warning',
    (_n, tenantId) => {
      writeConfig({ providers: [{ type: 'entra', clientId: 'a', clientSecret: 'top-secret-b', ...(tenantId ? { tenantId } : {}) }, { ...OIDC, id: 'other' }] });
      expect(loadAuthConfig().providers.map((p) => p.id)).toEqual(['other']);
      expect(warned()).toContain('providers[0]');
      expect(warned()).not.toContain('top-secret-b');
    },
  );

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

    it('is strict by default: IdP-initiated login off, deprecated algorithms off', () => {
      writeConfig({ providers: [SAML] });
      expect(loadAuthConfig().providers[0]).toMatchObject({
        wantAssertionsSigned: true,
        allowIdpInitiated: false,
        allowDeprecatedAlgorithms: false,
        authnRequestsSigned: false,
      });
    });

    it('warns when the cosmetic wantAssertionsSigned is false, and when a weakening option is on', () => {
      writeConfig({ providers: [{ ...SAML, wantAssertionsSigned: false, allowIdpInitiated: true, allowDeprecatedAlgorithms: true }] });
      loadAuthConfig();
      expect(warned()).toContain('wantAssertionsSigned is false');
      expect(warned()).toContain('allowIdpInitiated is on');
      expect(warned()).toContain('allowDeprecatedAlgorithms is on');
    });

    it('accepts one certificate or a list (a rollover), nothing else', () => {
      writeConfig({ providers: [{ ...SAML, cert: ['MIIC1', 'MIIC2'] }, { ...SAML, id: 'two', cert: 7 }] });
      const cfg = loadAuthConfig();
      expect(cfg.providers.map((p) => p.id)).toEqual(['kommune']);
      expect(cfg.providers[0]).toMatchObject({ cert: ['MIIC1', 'MIIC2'] });
    });

    it('warns (does not skip) when the SAML userId attribute is the e-mail attribute', () => {
      writeConfig({ providers: [{ ...SAML, claims: { userId: 'Mail', email: 'mail' } }] });
      expect(loadAuthConfig().providers).toHaveLength(1);
      expect(warned()).toContain('claims.userId is the same attribute as claims.email');
    });

    it('skips a provider whose IdP metadata has an http endpoint (outside a loopback host)', () => {
      const bad = path.join(dir, 'bad.xml');
      const good = path.join(dir, 'good.xml');
      writeFileSync(bad, '<EntityDescriptor><IDPSSODescriptor><SingleSignOnService Binding="x" Location="http://idp.example/sso"/></IDPSSODescriptor></EntityDescriptor>');
      writeFileSync(good, '<EntityDescriptor><IDPSSODescriptor><SingleSignOnService Binding="x" Location="https://idp.example/sso?a=1&amp;b=2"/></IDPSSODescriptor></EntityDescriptor>');
      writeConfig({ providers: [{ type: 'saml', id: 'bad', idpMetadataFile: bad }, { type: 'saml', id: 'good', idpMetadataFile: good }] });
      expect(loadAuthConfig().providers.map((p) => p.id)).toEqual(['good']);
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

  describe('IdP URL hygiene', () => {
    it('refuses every non-https IdP URL, except http on a loopback host outside production', () => {
      writeConfig({
        providers: [
          { ...OIDC, id: 'plain', discoveryUrl: 'http://idp.example/d' },
          { ...OIDC, id: 'issuer', issuer: 'http://idp.example' },
          { ...OIDC, id: 'ftp', discoveryUrl: 'ftp://idp.example/d' },
          { ...OIDC, id: 'ep', discoveryUrl: undefined, authorizationUrl: 'https://i/a', tokenUrl: 'http://i/t' },
          { ...OIDC, id: 'ui', userInfoUrl: 'http://i/ui' },
          { type: 'saml', id: 'saml-http', entryPoint: 'http://idp.example/sso', idpEntityId: 'x', cert: 'MIIC' },
          { ...OIDC, id: 'local', discoveryUrl: 'http://localhost:8080/d' },
          { ...OIDC, id: 'loop', discoveryUrl: 'http://127.0.0.1:8080/d' },
        ],
      });
      expect(loadAuthConfig().providers.map((p) => p.id)).toEqual(['local', 'loop']);
    });

    it('in production loopback http is refused too, and an oidc/saml provider needs BETTER_AUTH_URL to be an https URL', () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('BETTER_AUTH_URL', 'https://referat.kommune.dk');
      writeConfig({ providers: [{ ...OIDC, id: 'local', discoveryUrl: 'http://localhost:8080/d' }, OIDC] });
      expect(loadAuthConfig().providers.map((p) => p.id)).toEqual(['fka']);

      for (const base of ['', 'http://referat.kommune.dk', 'not a url', 'https://referat.kommune.dk/?x=1']) {
        vi.stubEnv('BETTER_AUTH_URL', base);
        writeConfig({ providers: [OIDC, { type: 'saml', id: 's', entryPoint: 'https://idp.example/sso', idpEntityId: 'x', cert: 'M' }] });
        expect(loadAuthConfig().providers, base).toEqual([]);
      }
      expect(warned()).toContain('BETTER_AUTH_URL');
    });

    it('the https requirement on BETTER_AUTH_URL does not apply to entra, nor outside production', () => {
      vi.stubEnv('BETTER_AUTH_URL', 'http://localhost:3004');
      writeConfig({ providers: [OIDC] });
      expect(loadAuthConfig().providers).toHaveLength(1);
      vi.stubEnv('NODE_ENV', 'production');
      writeConfig({ providers: [{ type: 'entra', clientId: 'a', clientSecret: 'b', tenantId: TENANT }] });
      expect(loadAuthConfig().providers).toHaveLength(1);
    });
  });

  describe('ACCESS_SOURCE=claims', () => {
    beforeEach(() => vi.stubEnv('ACCESS_SOURCE', 'claims'));

    it.each([
      'https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration',
      'https://login.microsoftonline.com/organizations/v2.0/.well-known/openid-configuration',
      'https://login.microsoftonline.com/consumers/v2.0/.well-known/openid-configuration',
      'https://login.microsoftonline.com/Common/',
    ])('refuses an oidc provider on a multi-tenant authority: %s', (discoveryUrl) => {
      writeConfig({ providers: [{ ...OIDC, discoveryUrl }, { ...OIDC, id: 'issuer', discoveryUrl: undefined, issuer: 'https://login.microsoftonline.com/organizations/v2.0', authorizationUrl: 'https://a/a', tokenUrl: 'https://a/t' }] });
      expect(loadAuthConfig().providers).toEqual([]);
      expect(warned()).toContain('multi-tenant authority');
    });

    it('accepts the tenant-specific authority, and refuses explicit endpoints without a discoveryUrl or issuer', () => {
      writeConfig({
        providers: [
          { ...OIDC, discoveryUrl: `https://login.microsoftonline.com/${TENANT}/v2.0/.well-known/openid-configuration` },
          { type: 'oidc', id: 'ep', clientId: 'a', clientSecret: 'b', authorizationUrl: 'https://i/auth', tokenUrl: 'https://i/token' },
          { type: 'oidc', id: 'ep2', clientId: 'a', clientSecret: 'b', authorizationUrl: 'https://i/auth', tokenUrl: 'https://i/token', issuer: 'https://i' },
        ],
      });
      expect(loadAuthConfig().providers.map((p) => p.id)).toEqual(['fka', 'ep2']);
    });

    it('outside claims mode a multi-tenant authority is not refused (no roles come from it)', () => {
      vi.stubEnv('ACCESS_SOURCE', 'local');
      writeConfig({ providers: [{ ...OIDC, discoveryUrl: 'https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration' }] });
      expect(loadAuthConfig().providers).toHaveLength(1);
    });
  });

  describe('identity key and reserved ids', () => {
    it.each(['email', 'mail', 'upn', 'preferred_username', 'name', 'email_verified', 'Email', ' UPN '])(
      'refuses an oidc provider whose claims.userId is the mutable attribute %j',
      (userId) => {
        writeConfig({ providers: [{ ...OIDC, claims: { userId } }, { ...OIDC, id: 'ok', claims: { userId: 'oid' } }] });
        expect(loadAuthConfig().providers.map((p) => p.id)).toEqual(['ok']);
      },
    );

    it.each(['credential', 'password', 'unknown', 'microsoft'])('refuses the reserved provider id %s', (id) => {
      writeConfig({ providers: [{ ...OIDC, id }, { type: 'saml', id, entryPoint: 'https://i/sso', idpEntityId: 'x', cert: 'M' }] });
      expect(loadAuthConfig().providers).toEqual([]);
    });
  });

  describe('session hygiene options', () => {
    it('passes prompt and maxAge through, and refuses nonsense', () => {
      writeConfig({ providers: [{ ...OIDC, prompt: 'login', maxAge: 0 }, { ...OIDC, id: 'bad1', prompt: 'none' }, { ...OIDC, id: 'bad2', maxAge: -1 }] });
      const cfg = loadAuthConfig();
      expect(cfg.providers.map((p) => p.id)).toEqual(['fka']);
      expect(cfg.providers[0]).toMatchObject({ prompt: 'login', maxAge: 0 });
    });
  });

  describe('roles (fail CLOSED)', () => {
    it('maps claim values to roles; the object form takes global, and global:false disables the entry', () => {
      writeConfig({
        providers: [OIDC],
        roles: {
          appRoleMap: { admin: 'admin', su: { role: 'bygger' }, off: { role: 'admin', global: false } },
          groupRoleMap: { 'g-1': 'bruger' },
        },
      });
      const { roles } = loadAuthConfig();
      if (roles.state !== 'ok') throw new Error('expected ok');
      expect([...roles.appRoleMap]).toEqual([
        ['admin', { role: 'admin', global: true }],
        ['su', { role: 'bygger', global: true }],
      ]);
      expect([...roles.groupRoleMap.keys()]).toEqual(['g-1']);
    });

    it('is "unset" when the section is absent', () => {
      writeConfig({ providers: [OIDC] });
      expect(loadAuthConfig().roles).toEqual({ state: 'unset' });
    });

    it.each([
      ['an unknown role key', { appRoleMap: { x: 'tt-god' } }],
      ['a misspelt section key', { appRolMap: { x: 'admin' } }],
      ['a map that is not an object', { appRoleMap: ['admin'] }],
      ['an entry with extra keys', { appRoleMap: { x: { role: 'admin', scope: 'u' } } }],
    ])('is invalid for %s: nobody gets a role', (_name, roles) => {
      writeConfig({ providers: [OIDC], roles });
      expect(loadAuthConfig().roles).toEqual({ state: 'invalid' });
      // ...but the providers still work: only the mapping is closed.
      expect(loadAuthConfig().providers).toHaveLength(1);
    });

    it('is invalid when a value references an unset variable (keys are never expanded)', () => {
      writeConfig({ roles: { appRoleMap: { admin: '${NOT_SET_ANYWHERE}' } } });
      expect(loadAuthConfig().roles).toEqual({ state: 'invalid' });
      writeConfig({ roles: { appRoleMap: { '${NOT_SET_ANYWHERE}': 'admin' } } });
      const { roles } = loadAuthConfig();
      expect(roles.state === 'ok' && [...roles.appRoleMap.keys()]).toEqual(['${NOT_SET_ANYWHERE}']);
    });

    it('an unknown top-level key closes the roles too (a misspelt "roles" must not mean "no mapping")', () => {
      writeConfig({ providers: [OIDC], rolez: { appRoleMap: {} }, roles: { appRoleMap: { a: 'admin' } } });
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

    it('byProvider carries the maps per provider; the global maps are a fallback for a single provider only', () => {
      writeConfig({
        providers: [OIDC, { ...OIDC, id: 'b' }],
        roles: {
          appRoleMap: { g: 'bruger' },
          byProvider: { fka: { appRoleMap: { admin: 'admin' }, groupRoleMap: { x: 'admin' } } },
        },
      });
      const { roles } = loadAuthConfig();
      if (roles.state !== 'ok') throw new Error('expected ok');
      expect(roles.providerCount).toBe(2);
      expect([...(roles.byProvider?.get('fka')?.appRoleMap.keys() ?? [])]).toEqual(['admin']);
      expect([...(roles.byProvider?.get('fka')?.groupRoleMap.keys() ?? [])]).toEqual(['x']);
      expect(roles.byProvider?.has('b')).toBe(false);
      expect(warned()).toContain('roles.byProvider');
    });

    it('a byProvider entry for an unknown provider id is kept but unused (warned); a bad id or entry fails closed', () => {
      writeConfig({ providers: [OIDC], roles: { byProvider: { nobody: { appRoleMap: { a: 'bruger' } } } } });
      expect(loadAuthConfig().roles.state).toBe('ok');
      expect(warned()).toContain('not configured');
      writeConfig({ providers: [OIDC], roles: { byProvider: { 'Bad Id!': { appRoleMap: {} } } } });
      expect(loadAuthConfig().roles).toEqual({ state: 'invalid' });
      writeConfig({ providers: [OIDC], roles: { byProvider: { fka: { appRoleMap: { a: 'tt-god' } } } } });
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
      writeConfig({ providers: [OIDC], roles: { appRoleMap: { a: 'admin' } }, catalogue: [{ kind: 'team', identifier: 'x', name: 'y' }] });
      const cfg = loadAuthConfig();
      expect(cfg.catalogue).toEqual([]);
      expect(cfg.catalogueState).toBe('invalid');
      expect(cfg.roles.state).toBe('ok');
      expect(cfg.providers).toHaveLength(1);
    });

    it('reports its state: absent without a section or a file, ok with one (even an empty list), invalid when unusable', () => {
      expect(loadAuthConfig().catalogueState).toBe('absent'); // no AUTH_CONFIG_FILE
      writeConfig({ providers: [OIDC] });
      expect(loadAuthConfig().catalogueState).toBe('absent');
      writeConfig({ catalogue: [] });
      expect(loadAuthConfig().catalogueState).toBe('ok');
      writeConfig({ catalogue: [{ kind: 'role', identifier: 'r', name: 'R' }] });
      expect(loadAuthConfig().catalogueState).toBe('ok');
      writeConfig({ catalogue: [{ kind: 'role', identifier: '${NOT_SET_ANYWHERE}', name: 'R' }] });
      expect(loadAuthConfig().catalogueState).toBe('invalid');
      writeConfig('{ not json');
      expect(loadAuthConfig().catalogueState).toBe('invalid');
      vi.stubEnv('AUTH_CONFIG_FILE', path.join(dir, 'nope.json'));
      resetAuthConfigCache();
      expect(loadAuthConfig().catalogueState).toBe('invalid');
    });

    it('keeps the optional providers list of an entry', () => {
      writeConfig({ catalogue: [{ kind: 'role', identifier: 'r', name: 'R', providers: ['a', 'B'] }] });
      expect(loadAuthConfig().catalogue[0]).toMatchObject({ providers: ['a', 'b'] });
      writeConfig({ catalogue: [{ kind: 'role', identifier: 'r', name: 'R', providers: [] }] });
      expect(loadAuthConfig().catalogueState).toBe('invalid');
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
