import { describe, expect, it, vi } from 'vitest';
import { SSO_DISABLED_PATHS, authBaseUrl, defaultSsoFor, isKnownSsoRequest, spEntityIdFor, ssoPluginOptions } from './saml';
import type { SamlFileProvider } from './providers';

const BASE = 'https://referat.kommune.dk/api/auth';

function provider(over: Partial<SamlFileProvider> = {}): SamlFileProvider {
  return {
    type: 'saml',
    id: 'kommune',
    enabled: true,
    entryPoint: 'https://idp.example/sso',
    idpEntityId: 'https://idp.example/metadata',
    cert: 'MIICcert',
    wantAssertionsSigned: true,
    authnRequestsSigned: false,
    allowIdpInitiated: true,
    ...over,
  } as SamlFileProvider;
}

describe('authBaseUrl / spEntityIdFor', () => {
  it('appends /api/auth once and strips trailing slashes', () => {
    expect(authBaseUrl('https://referat.kommune.dk/')).toBe(BASE);
    expect(authBaseUrl(`${BASE}/`)).toBe(BASE);
    expect(authBaseUrl('  ')).toBeUndefined();
    expect(authBaseUrl(undefined)).toBeUndefined();
  });

  it('defaults the SP entity id to the metadata URL of this installation, per provider', () => {
    expect(spEntityIdFor(provider(), BASE)).toBe(`${BASE}/sso/saml2/sp/metadata?providerId=kommune`);
    expect(spEntityIdFor(provider({ spEntityId: 'urn:referat:kommune' }), BASE)).toBe('urn:referat:kommune');
    expect(spEntityIdFor(provider(), undefined)).toBeUndefined();
  });
});

describe('defaultSsoFor', () => {
  it('builds the plugin entry from endpoints + certificate', () => {
    const entry = defaultSsoFor(provider(), BASE)!;
    expect(entry.providerId).toBe('kommune');
    expect(entry.domain).toBe('kommune.saml.invalid'); // never matches a real e-mail domain
    expect(entry.samlConfig).toMatchObject({
      entryPoint: 'https://idp.example/sso',
      cert: 'MIICcert',
      wantAssertionsSigned: true,
      authnRequestsSigned: false,
      callbackUrl: '',
      spMetadata: { entityID: `${BASE}/sso/saml2/sp/metadata?providerId=kommune` },
      idpMetadata: {
        entityID: 'https://idp.example/metadata',
        cert: 'MIICcert',
        singleSignOnService: [{ Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect', Location: 'https://idp.example/sso' }],
      },
    });
  });

  it('prefers IdP metadata when there is some', () => {
    const entry = defaultSsoFor(provider({ idpMetadata: '<EntityDescriptor/>', entryPoint: undefined, cert: undefined, idpEntityId: undefined }), BASE)!;
    expect(entry.samlConfig?.idpMetadata).toEqual({ metadata: '<EntityDescriptor/>' });
  });

  it('maps the claim names, and delivers role/group attributes under their own names', () => {
    const entry = defaultSsoFor(
      provider({
        claims: { userId: 'uid', email: 'mail', name: 'cn', emailVerified: 'mailVerified', firstName: 'gn', lastName: 'sn', upn: 'userPrincipalName', preferredUsername: 'sAMAccountName' },
        rolesClaim: { name: 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role', format: 'array', separator: ',' },
        groupsClaim: { name: 'memberOf', format: 'delimited', separator: ';' },
      }),
      BASE,
    )!;
    expect(entry.samlConfig?.mapping).toEqual({
      id: 'uid',
      email: 'mail',
      emailVerified: 'mailVerified',
      name: 'cn',
      firstName: 'gn',
      lastName: 'sn',
      extraFields: {
        'http://schemas.microsoft.com/ws/2008/06/identity/claims/role': 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role',
        memberOf: 'memberOf',
        upn: 'userPrincipalName',
        preferred_username: 'sAMAccountName',
      },
    });
  });

  it('is null without a stable SP entity id', () => {
    expect(defaultSsoFor(provider(), undefined)).toBeNull();
  });
});

describe('ssoPluginOptions', () => {
  const hooks = { onLogin: vi.fn(async () => {}) };

  it('is hardened: no provider registration, no trusted e-mail flag, callback on every login, timestamps required', () => {
    const o = ssoPluginOptions([provider()], hooks, BASE)!;
    expect(o).toMatchObject({
      providersLimit: 0,
      trustEmailVerified: false,
      provisionUserOnEveryLogin: true,
      saml: { requireTimestamps: true, algorithms: { onDeprecated: 'reject' } },
    });
    expect(o.defaultSSO).toHaveLength(1);
  });

  it('only warns about deprecated algorithms when a provider opted in (installation-wide switch)', () => {
    const o = ssoPluginOptions([provider(), provider({ id: 'other', allowDeprecatedAlgorithms: true })], hooks, BASE)!;
    expect(o.saml?.algorithms).toEqual({ onDeprecated: 'warn' });
  });

  it('passes one certificate as is and a rollover list on to samlify', () => {
    expect(defaultSsoFor(provider({ cert: ['MIIC1', 'MIIC2'] }), BASE)!.samlConfig).toMatchObject({
      cert: 'MIIC1',
      idpMetadata: { cert: ['MIIC1', 'MIIC2'] },
    });
    expect(defaultSsoFor(provider({ cert: ['MIIC1'] }), BASE)!.samlConfig?.idpMetadata).toMatchObject({ cert: 'MIIC1' });
  });

  it('skips a provider without BETTER_AUTH_URL even when it has its own spEntityId (no ACS URL)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(ssoPluginOptions([provider({ spEntityId: 'urn:referat:kommune' })], hooks, undefined)).toBeNull();
    warn.mockRestore();
  });

  it('hands the app user, the provider id and the mapped attributes to onLogin', async () => {
    const o = ssoPluginOptions([provider()], hooks, BASE)!;
    await o.provisionUser!({ user: { id: 'u1' } as never, userInfo: { id: 'x', roles: ['r'] }, provider: { providerId: 'kommune' } as never });
    expect(hooks.onLogin).toHaveBeenCalledWith('u1', 'kommune', { id: 'x', roles: ['r'] });
  });

  it('is null (and warns, content-free) when no provider is usable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(ssoPluginOptions([provider()], hooks, undefined)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(ssoPluginOptions([], hooks, BASE)).toBeNull();
    warn.mockRestore();
  });

  it('closes the plugin\'s provider-management endpoints', () => {
    expect(SSO_DISABLED_PATHS).toEqual(
      expect.arrayContaining(['/sso/register', '/sso/providers', '/sso/get-provider', '/sso/update-provider', '/sso/delete-provider']),
    );
  });
});

describe('isKnownSsoRequest', () => {
  const ids = ['kommune'];
  it('lets every non-sso route through', () => {
    expect(isKnownSsoRequest({ path: '/sign-in/email' }, ids)).toBe(true);
    expect(isKnownSsoRequest({}, ids)).toBe(true);
  });
  it('accepts a configured provider from params, query or body', () => {
    expect(isKnownSsoRequest({ path: '/sso/saml2/sp/acs/:providerId', params: { providerId: 'kommune' } }, ids)).toBe(true);
    expect(isKnownSsoRequest({ path: '/sso/saml2/sp/metadata', query: { providerId: 'kommune' } }, ids)).toBe(true);
    expect(isKnownSsoRequest({ path: '/sign-in/sso', body: { providerId: 'kommune' } }, ids)).toBe(true);
  });
  it('refuses an unknown or missing provider id on an sso route', () => {
    expect(isKnownSsoRequest({ path: '/sso/saml2/sp/acs/:providerId', params: { providerId: 'other' } }, ids)).toBe(false);
    expect(isKnownSsoRequest({ path: '/sign-in/sso', body: { email: 'a@b.dk' } }, ids)).toBe(false);
    expect(isKnownSsoRequest({ path: '/sso/saml2/sp/metadata' }, ids)).toBe(false);
    expect(isKnownSsoRequest({ path: '/sign-in/sso', body: { providerId: ['kommune'] } }, ids)).toBe(false);
  });
});
