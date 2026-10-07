// A real SAML login against the real better-auth sso plugin, with an in-memory database
// and a signing stand-in IdP (src/test/saml-idp.ts): sign-in redirect, the ACS POST, the
// session, and the attributes that reach provisionUser. Also the attacks that matter:
// unsigned, wrongly signed, tampered, replayed, and an unknown provider.
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { sso } from '@better-auth/sso';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildSamlResponse,
  decodeResponse,
  encodeResponse,
  generateIdpKeys,
  opensslAvailable,
  parseAuthnRequestUrl,
  type IdpKeys,
} from '@/test/saml-idp';
import { SSO_DISABLED_PATHS, ssoPluginOptions } from './saml';
import { samlBeforeHook } from './saml-guard';
import type { SamlFileProvider } from './providers';

const BASE = 'http://localhost:3004';
const AUTH = `${BASE}/api/auth`;
const IDP = 'https://idp.example/metadata';
const ACS = `${AUTH}/sso/saml2/sp/acs/kommune`;
const SP_ENTITY = `${AUTH}/sso/saml2/sp/metadata?providerId=kommune`;

const run = opensslAvailable();

/** The response sets a (non-empty) session cookie. */
const hasSession = (res: Response) => /session_token=[^;\s]/.test(res.headers.get('set-cookie') ?? '');

describe.skipIf(!run)('SAML login through the sso plugin', () => {
  let keys: IdpKeys;
  let otherKeys: IdpKeys;
  const onLogin = vi.fn();
  let db: Record<string, Array<Record<string, unknown>>>;
  let auth: ReturnType<typeof makeAuth>;

  function provider(over: Partial<SamlFileProvider> = {}): SamlFileProvider {
    return {
      type: 'saml',
      id: 'kommune',
      label: 'Kommunen',
      enabled: true,
      entryPoint: 'https://idp.example/sso',
      idpEntityId: IDP,
      cert: keys.cert,
      wantAssertionsSigned: true,
      authnRequestsSigned: false,
      claims: { email: 'mail', name: 'displayName', userId: 'uid', upn: 'upn' },
      rolesClaim: { name: 'roles', format: 'array', separator: ',' },
      groupsClaim: { name: 'groups', format: 'delimited', separator: ';' },
      ...over,
    } as SamlFileProvider;
  }

  function makeAuth(p: SamlFileProvider = provider()) {
    const options = ssoPluginOptions([p], { onLogin }, AUTH)!;
    return betterAuth({
      baseURL: BASE,
      secret: 'x'.repeat(40),
      database: memoryAdapter(db),
      disabledPaths: SSO_DISABLED_PATHS,
      // better-auth switches the origin / CSRF check off under NODE_ENV=test; this test is about it.
      advanced: { disableOriginCheck: false },
      hooks: { before: samlBeforeHook([p], { base: AUTH }) },
      plugins: [sso(options)],
    });
  }

  beforeAll(() => {
    keys = generateIdpKeys('idp');
    otherKeys = generateIdpKeys('attacker');
  });

  beforeEach(() => {
    onLogin.mockReset().mockResolvedValue(undefined);
    db = { user: [], session: [], account: [], verification: [], ssoProvider: [] };
    auth = makeAuth();
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    auth.handler(
      new Request(`${AUTH}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE, ...headers },
        body: JSON.stringify(body),
      }),
    );

  /** SP-initiated: the AuthnRequest the app sends the browser off with. */
  async function startLogin(): Promise<{ id: string; relayState: string | null }> {
    const res = await post('/sign-in/sso', { providerId: 'kommune', callbackURL: '/dashboard' });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(url.startsWith('https://idp.example/sso')).toBe(true);
    return parseAuthnRequestUrl(url);
  }

  /** What the browser does at the end: an auto-submitted form POST from the IdP's origin, no cookies. */
  const acs = (SAMLResponse: string, RelayState: string | null) =>
    auth.handler(
      new Request(ACS, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://idp.example' },
        body: new URLSearchParams({ SAMLResponse, ...(RelayState ? { RelayState } : {}) }).toString(),
      }),
    );

  const attrs = {
    uid: 'ola01',
    mail: 'Ola@Kommune.dk',
    displayName: 'Ola Olsen',
    upn: 'ola01@kommune.dk',
    roles: ['Administrator', 'Logleser'],
    groups: 'g-borger;g-skole',
  };

  function response(over: Partial<Parameters<typeof buildSamlResponse>[0]> = {}) {
    return buildSamlResponse({
      issuer: IDP,
      acsUrl: ACS,
      audience: SP_ENTITY,
      nameId: 'ola01',
      attributes: attrs,
      keys,
      ...over,
    });
  }

  it('logs a person in: session cookie, user and account created, attributes delivered to the callback', async () => {
    const req = await startLogin();
    const res = await acs(response({ inResponseTo: req.id }), req.relayState);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/dashboard');
    expect(hasSession(res)).toBe(true);
    expect(db.user).toHaveLength(1);
    expect(db.account).toHaveLength(1);
    expect(db.account[0]).toMatchObject({ providerId: 'kommune', accountId: 'ola01' });

    expect(onLogin).toHaveBeenCalledTimes(1);
    const [userId, providerId, userInfo] = onLogin.mock.calls[0];
    expect(userId).toBe(db.user[0].id);
    expect(providerId).toBe('kommune');
    expect(userInfo).toMatchObject({
      id: 'ola01',
      email: 'ola@kommune.dk',
      name: 'Ola Olsen',
      upn: 'ola01@kommune.dk',
      emailVerified: false,
      roles: ['Administrator', 'Logleser'],
      groups: 'g-borger;g-skole',
    });
  });

  it('runs the callback again on the SECOND login (roles must follow the IdP), with the new roles', async () => {
    for (const roles of [['Administrator', 'Logleser'], ['Logleser']]) {
      const req = await startLogin();
      const res = await acs(response({ inResponseTo: req.id, attributes: { ...attrs, roles } }), req.relayState);
      expect(res.status).toBe(302);
    }
    expect(db.user).toHaveLength(1);
    expect(onLogin).toHaveBeenCalledTimes(2);
    expect(onLogin.mock.calls[0][2].roles).toEqual(['Administrator', 'Logleser']);
    // A lone value arrives as a bare string: claims-roles reads that as one value.
    expect(onLogin.mock.calls[1][2].roles).toBe('Logleser');
  });

  it('accepts the cross-site POST of the IdP on the ACS path (the plugin skips the origin check there), and not elsewhere', async () => {
    const req = await startLogin();
    const res = await acs(response({ inResponseTo: req.id }), req.relayState);
    expect(res.status).toBe(302);
    expect(res.headers.get('location') ?? '').not.toContain('error');
    const cookie = 'better-auth.session_token=abc.def';
    const withCookie = await auth.handler(
      new Request(ACS, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://idp.example', cookie },
        body: new URLSearchParams({ SAMLResponse: response() }).toString(),
      }),
    );
    expect(withCookie.status).not.toBe(403);
    const signOut = await auth.handler(
      new Request(`${AUTH}/sign-out`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example', cookie },
        body: '{}',
      }),
    );
    expect(signOut.status).toBe(403);
  });

  it('rejects an UNSIGNED assertion: no session, no callback', async () => {
    const req = await startLogin();
    const res = await acs(response({ inResponseTo: req.id, sign: 'none' }), req.relayState);
    expect(hasSession(res)).toBe(false);
    expect(db.user).toHaveLength(0);
    expect(db.session).toHaveLength(0);
    expect(onLogin).not.toHaveBeenCalled();
  });

  it('rejects an assertion signed with a key the IdP metadata does not carry', async () => {
    const req = await startLogin();
    const res = await acs(response({ inResponseTo: req.id, keys: otherKeys }), req.relayState);
    expect(hasSession(res)).toBe(false);
    expect(db.user).toHaveLength(0);
    expect(onLogin).not.toHaveBeenCalled();
  });

  it('rejects an assertion whose roles were edited after it was signed', async () => {
    const req = await startLogin();
    const good = decodeResponse(response({ inResponseTo: req.id }));
    expect(good).toContain('Logleser');
    const tampered = encodeResponse(good.replace('Logleser', 'Superadmin'));
    const res = await acs(tampered, req.relayState);
    expect(hasSession(res)).toBe(false);
    expect(db.user).toHaveLength(0);
    expect(onLogin).not.toHaveBeenCalled();
  });

  it('rejects a replay of an already used response', async () => {
    const req = await startLogin();
    const r = response({ inResponseTo: req.id, assertionId: '_assertion-1' });
    expect(hasSession(await acs(r, req.relayState))).toBe(true);
    const again = await acs(r, req.relayState);
    expect(hasSession(again)).toBe(false);
    expect(onLogin).toHaveBeenCalledTimes(1);
  });

  it('rejects a response signed for ANOTHER service provider (audience and recipient)', async () => {
    const req = await startLogin();
    const other = response({ inResponseTo: req.id, audience: 'https://other-sp.example/meta' });
    expect(hasSession(await acs(other, req.relayState))).toBe(false);
    const req2 = await startLogin();
    const elsewhere = response({ inResponseTo: req2.id, acsUrl: 'https://other-sp.example/acs' });
    expect(hasSession(await acs(elsewhere, req2.relayState))).toBe(false);
    expect(onLogin).not.toHaveBeenCalled();
  });

  it('rejects a response that answers a request this app never made, or made for another provider', async () => {
    expect(hasSession(await acs(response({ inResponseTo: '_never-issued' }), null))).toBe(false);
    expect(onLogin).not.toHaveBeenCalled();
  });

  it('uses a request id once: a second response to the same AuthnRequest is refused', async () => {
    const req = await startLogin();
    expect(hasSession(await acs(response({ inResponseTo: req.id, assertionId: '_a1' }), req.relayState))).toBe(true);
    expect(hasSession(await acs(response({ inResponseTo: req.id, assertionId: '_a2' }), req.relayState))).toBe(false);
    expect(onLogin).toHaveBeenCalledTimes(1);
  });

  it('refuses an unsolicited (IdP-initiated) response by default, and accepts it only with allowIdpInitiated: true', async () => {
    expect(hasSession(await acs(response(), null))).toBe(false);
    expect(onLogin).not.toHaveBeenCalled();
    auth = makeAuth(provider({ allowIdpInitiated: true }));
    expect(hasSession(await acs(response({ assertionId: '_unsolicited-2' }), null))).toBe(true);
  });

  it('without IdP-initiated logins the SIGNED assertion-level InResponseTo is what counts, not the Response-level one', async () => {
    const req = await startLogin();
    const onlyOnResponse = response({ inResponseTo: req.id, inResponseToLevel: 'response' });
    expect(hasSession(await acs(onlyOnResponse, req.relayState))).toBe(false);
    expect(onLogin).not.toHaveBeenCalled();
    // The request id was not consumed by the refusal: the proper answer still works.
    const onlyInAssertion = response({ inResponseTo: req.id, inResponseToLevel: 'assertion' });
    expect(hasSession(await acs(onlyInAssertion, req.relayState))).toBe(true);
  });

  it('refuses a response whose assertion carries no Recipient', async () => {
    const req = await startLogin();
    expect(hasSession(await acs(response({ inResponseTo: req.id, recipient: null }), req.relayState))).toBe(false);
    expect(onLogin).not.toHaveBeenCalled();
  });

  it('requires the Destination of a response that is signed as a whole, but not of one with a signed assertion only', async () => {
    const req = await startLogin();
    expect(hasSession(await acs(response({ inResponseTo: req.id, sign: 'message', destination: null }), req.relayState))).toBe(false);
    const req2 = await startLogin();
    expect(hasSession(await acs(response({ inResponseTo: req2.id, sign: 'both', destination: 'https://other-sp.example/acs' }), req2.relayState))).toBe(false);
    const req3 = await startLogin();
    expect(hasSession(await acs(response({ inResponseTo: req3.id, sign: 'message' }), req3.relayState))).toBe(true);
    const req4 = await startLogin();
    expect(hasSession(await acs(response({ inResponseTo: req4.id, sign: 'assertion', destination: null }), req4.relayState))).toBe(true);
  });

  it('refuses a response with a DOCTYPE or ENTITY declaration before any XML parser sees it', async () => {
    for (const prelude of ['<!DOCTYPE r [<!ENTITY x "y">]>', '<!doctype r>']) {
      const req = await startLogin();
      const res = await acs(response({ inResponseTo: req.id, prelude }), req.relayState);
      expect(hasSession(res), prelude).toBe(false);
    }
    expect(onLogin).not.toHaveBeenCalled();
  });

  it('applies the same checks to a JSON-bodied POST (the guard does not depend on the content type)', async () => {
    const req = await startLogin();
    const foreign = response({ inResponseTo: req.id, audience: 'https://other-sp.example/meta' });
    const res = await auth.handler(
      new Request(ACS, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://idp.example' },
        body: JSON.stringify({ SAMLResponse: foreign, RelayState: req.relayState }),
      }),
    );
    expect(hasSession(res)).toBe(false);
    expect(db.user).toHaveLength(0);
    const unsigned = await auth.handler(
      new Request(ACS, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://idp.example' },
        body: JSON.stringify({ SAMLResponse: response({ inResponseTo: req.id, sign: 'none' }), RelayState: req.relayState }),
      }),
    );
    expect(hasSession(unsigned)).toBe(false);
    expect(onLogin).not.toHaveBeenCalled();
  });

  it('still refuses an unsigned response when wantAssertionsSigned is switched off (the option is cosmetic)', async () => {
    auth = makeAuth(provider({ wantAssertionsSigned: false }));
    const req = await startLogin();
    expect(hasSession(await acs(response({ inResponseTo: req.id, sign: 'none' }), req.relayState))).toBe(false);
    expect(db.user).toHaveLength(0);
    expect(onLogin).not.toHaveBeenCalled();
  });

  it('refuses a NotBefore a few seconds ahead: the library keeps no clock tolerance (the host needs NTP)', async () => {
    const req = await startLogin();
    const soon = new Date(Date.now() + 5_000);
    const res = await acs(response({ inResponseTo: req.id, notBefore: soon, notOnOrAfter: new Date(soon.getTime() + 300_000) }), req.relayState);
    expect(hasSession(res)).toBe(false);
    expect(onLogin).not.toHaveBeenCalled();
  });

  it('refuses a SHA-1 signature unless allowDeprecatedAlgorithms is set', async () => {
    const sha1 = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1';
    const req = await startLogin();
    expect(hasSession(await acs(response({ inResponseTo: req.id, signatureAlgorithm: sha1 }), req.relayState))).toBe(false);
    expect(onLogin).not.toHaveBeenCalled();
    auth = makeAuth(provider({ allowDeprecatedAlgorithms: true }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const req2 = await startLogin();
    expect(hasSession(await acs(response({ inResponseTo: req2.id, signatureAlgorithm: sha1, assertionId: '_sha1' }), req2.relayState))).toBe(true);
  });

  it('accepts a list of certificates (a rollover): a response signed by either verifies', async () => {
    auth = makeAuth(provider({ cert: [otherKeys.cert, keys.cert] }));
    const req = await startLogin();
    expect(hasSession(await acs(response({ inResponseTo: req.id }), req.relayState))).toBe(true);
    const req2 = await startLogin();
    expect(hasSession(await acs(response({ inResponseTo: req2.id, keys: otherKeys, assertionId: '_other' }), req2.relayState))).toBe(true);
    const third = generateIdpKeys('third');
    const req3 = await startLogin();
    expect(hasSession(await acs(response({ inResponseTo: req3.id, keys: third, assertionId: '_third' }), req3.relayState))).toBe(false);
  });

  describe('IdP metadata', () => {
    const metadata = (cert?: string) =>
      `<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${IDP}"><IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">` +
      (cert
        ? `<KeyDescriptor use="signing"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>${cert.replace(/-----[A-Z ]+-----|\s+/g, '')}</X509Certificate></X509Data></KeyInfo></KeyDescriptor>`
        : '') +
      `<SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example/sso"/></IDPSSODescriptor></EntityDescriptor>`;

    const withMetadata = (xml: string) =>
      provider({ entryPoint: undefined, idpEntityId: undefined, cert: undefined, idpMetadata: xml });

    it('logs in with metadata that carries the signing certificate (control)', async () => {
      auth = makeAuth(withMetadata(metadata(keys.cert)));
      const req = await startLogin();
      expect(hasSession(await acs(response({ inResponseTo: req.id }), req.relayState))).toBe(true);
    });

    it('refuses everything when the metadata carries no signing certificate', async () => {
      auth = makeAuth(withMetadata(metadata()));
      const req = await startLogin();
      expect(hasSession(await acs(response({ inResponseTo: req.id }), req.relayState))).toBe(false);
      expect(onLogin).not.toHaveBeenCalled();
    });
  });

  it('refuses an oversized response without parsing it', async () => {
    const req = await startLogin();
    const huge = Buffer.from('<a>' + 'x'.repeat(300_000) + '</a>').toString('base64');
    expect(huge.length).toBeGreaterThan(262_144);
    expect(hasSession(await acs(huge, req.relayState))).toBe(false);
    expect(onLogin).not.toHaveBeenCalled();
  });

  it('rejects an expired assertion', async () => {
    const req = await startLogin();
    const past = new Date(Date.now() - 3600_000);
    const res = await acs(response({ inResponseTo: req.id, notBefore: new Date(past.getTime() - 60_000), notOnOrAfter: past }), req.relayState);
    expect(hasSession(res)).toBe(false);
    expect(onLogin).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown provider id and for the provider-management endpoints', async () => {
    const unknown = await post('/sign-in/sso', { providerId: 'nobody', callbackURL: '/dashboard' });
    expect(unknown.status).toBe(404);
    const acsUnknown = await auth.handler(
      new Request(`${AUTH}/sso/saml2/sp/acs/nobody`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://idp.example' },
        body: new URLSearchParams({ SAMLResponse: response() }).toString(),
      }),
    );
    expect(acsUnknown.status).toBe(404);
    for (const path of SSO_DISABLED_PATHS) {
      const res = await auth.handler(new Request(`${AUTH}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: '{}' }));
      expect(res.status, path).toBe(404);
    }
  });

  it('publishes SP metadata with the ACS URL and entity id the IdP must be given', async () => {
    const res = await auth.handler(new Request(`${AUTH}/sso/saml2/sp/metadata?providerId=kommune`));
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain(SP_ENTITY.replaceAll('&', '&amp;'));
    expect(xml).toContain(ACS);
  });
});
