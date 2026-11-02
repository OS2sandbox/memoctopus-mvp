// A tiny SAML 2.0 identity provider for tests and the dev simulation: it signs
// assertions with a throwaway key and lets a test shape (or break) the response.
// NOT for production use: it trusts whoever asks. Needs the `openssl` binary to make
// the throwaway key and certificate.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
// samlify ships its own signing helper; using it keeps the stand-in byte-compatible with
// what the better-auth sso plugin (which is built on samlify) validates.
import * as saml from 'samlify';

export interface IdpKeys {
  /** PEM certificate */
  cert: string;
  /** PEM private key */
  key: string;
}

/** True when `openssl` can be run (the stand-in cannot make keys without it). */
export function opensslAvailable(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function generateIdpKeys(commonName = 'test-idp'): IdpKeys {
  const dir = mkdtempSync(path.join(tmpdir(), 'saml-idp-'));
  try {
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2', '-subj', `/CN=${commonName}`,
        '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')],
      { stdio: 'ignore' },
    );
    return {
      cert: readFileSync(path.join(dir, 'cert.pem'), 'utf8'),
      key: readFileSync(path.join(dir, 'key.pem'), 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const xmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export interface ParsedAuthnRequest {
  id: string;
  acsUrl: string | null;
  spEntityId: string | null;
  relayState: string | null;
}

/** Reads the HTTP-Redirect AuthnRequest out of the URL the SP sent the browser to. */
export function parseAuthnRequestUrl(redirectUrl: string): ParsedAuthnRequest {
  const url = new URL(redirectUrl);
  const encoded = url.searchParams.get('SAMLRequest');
  if (!encoded) throw new Error('no SAMLRequest in the redirect URL');
  const xml = inflateRawSync(Buffer.from(encoded, 'base64')).toString('utf8');
  const attr = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(xml)?.[1] ?? null;
  return {
    id: attr('ID') ?? '',
    acsUrl: attr('AssertionConsumerServiceURL'),
    spEntityId: /<saml:Issuer[^>]*>([^<]*)<\/saml:Issuer>/.exec(xml)?.[1] ?? null,
    relayState: url.searchParams.get('RelayState'),
  };
}

export interface ResponseOptions {
  /** The IdP's entity id (Issuer). */
  issuer: string;
  /** Where the response is posted; also the Destination and Recipient. */
  acsUrl: string;
  /** The SP's entity id (Audience). */
  audience: string;
  nameId: string;
  /** Attribute name -> one value or several. */
  attributes?: Record<string, string | string[]>;
  /** ID of the AuthnRequest this answers; leave out for an unsolicited (IdP-initiated) response. */
  inResponseTo?: string;
  /** What to sign. Default 'assertion'. */
  sign?: 'assertion' | 'message' | 'both' | 'none';
  keys: IdpKeys;
  /** Validity window; defaults to now .. now + 5 min. */
  notBefore?: Date;
  notOnOrAfter?: Date;
  assertionId?: string;
  /** Where InResponseTo is put: both (default), only on the Response, or only in the assertion's SubjectConfirmationData. */
  inResponseToLevel?: 'both' | 'response' | 'assertion';
  /** Recipient of the bearer confirmation; default the ACS URL, `null` leaves the attribute out. */
  recipient?: string | null;
  /** Destination of the Response; default the ACS URL, `null` leaves the attribute out. */
  destination?: string | null;
  /** XML-DSig signature algorithm URI; default RSA-SHA256. */
  signatureAlgorithm?: string;
  /** Markup put in front of the root element (e.g. a DOCTYPE), after signing. */
  prelude?: string;
}

/** A base64 SAMLResponse (HTTP-POST binding) for the options. */
export function buildSamlResponse(o: ResponseOptions): string {
  const now = new Date();
  const notBefore = (o.notBefore ?? new Date(now.getTime() - 60_000)).toISOString();
  const notOnOrAfter = (o.notOnOrAfter ?? new Date(now.getTime() + 5 * 60_000)).toISOString();
  const rand = () => `_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;

  const attributeStatement = o.attributes && Object.keys(o.attributes).length > 0
    ? '<saml:AttributeStatement>' +
      Object.entries(o.attributes)
        .map(([name, value]) => {
          const values = Array.isArray(value) ? value : [value];
          return (
            `<saml:Attribute Name="${xmlEscape(name)}" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:basic">` +
            values.map((v) => `<saml:AttributeValue xsi:type="xs:string">${xmlEscape(v)}</saml:AttributeValue>`).join('') +
            '</saml:Attribute>'
          );
        })
        .join('') +
      '</saml:AttributeStatement>'
    : '';

  const inResponseTo = o.inResponseTo ? ` InResponseTo="${xmlEscape(o.inResponseTo)}"` : '';
  const raw = saml.SamlLib.replaceTagsByValue(
    saml.SamlLib.defaultLoginResponseTemplate.context.replaceAll(' InResponseTo="{InResponseTo}"', inResponseTo),
    {
      ID: rand(),
      AssertionID: o.assertionId ?? rand(),
      Destination: o.destination === undefined ? o.acsUrl : (o.destination ?? ''),
      Audience: o.audience,
      SubjectRecipient: o.recipient === undefined ? o.acsUrl : (o.recipient ?? ''),
      Issuer: o.issuer,
      IssueInstant: now.toISOString(),
      StatusCode: 'urn:oasis:names:tc:SAML:2.0:status:Success',
      ConditionsNotBefore: notBefore,
      ConditionsNotOnOrAfter: notOnOrAfter,
      SubjectConfirmationDataNotOnOrAfter: notOnOrAfter,
      NameIDFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
      NameID: o.nameId, // samlify (>= 2.13) escapes tag values itself
      AuthnStatement: '',
      AttributeStatement: '',
      InResponseTo: o.inResponseTo ?? '',
    },
  );

  // Added after the tag replacement: samlify 2.13 escapes tag VALUES (the fix for an XML injection
  // through attribute values), so markup must not travel through it.
  let withAttributes = raw.replace('</saml:Conditions>', `</saml:Conditions>${attributeStatement}`);

  if (o.inResponseTo && o.inResponseToLevel === 'response') {
    withAttributes = withAttributes.replace(/(<saml:SubjectConfirmationData[^>]*?) InResponseTo="[^"]*"/, '$1');
  }
  if (o.inResponseTo && o.inResponseToLevel === 'assertion') {
    withAttributes = withAttributes.replace(/(<samlp:Response[^>]*?) InResponseTo="[^"]*"/, '$1');
  }
  if (o.recipient === null) withAttributes = withAttributes.replace(/ Recipient=""/, '');
  if (o.destination === null) withAttributes = withAttributes.replace(/ Destination=""/, '');

  const sign = o.sign ?? 'assertion';
  const common = {
    privateKey: o.keys.key,
    // samlify wants the bare base64 body of the certificate, not the PEM armour.
    signingCert: o.keys.cert.replace(/-----[A-Z ]+-----|\s+/g, ''),
    signatureAlgorithm: o.signatureAlgorithm ?? 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    isBase64Output: false,
  };
  let xml = withAttributes;
  if (sign === 'assertion' || sign === 'both') {
    xml = saml.SamlLib.constructSAMLSignature({
      ...common,
      rawSamlMessage: xml,
      referenceTagXPath: "/*[local-name(.)='Response']/*[local-name(.)='Assertion']",
      signatureConfig: {
        prefix: 'ds',
        location: { reference: "/*[local-name(.)='Response']/*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' },
      },
    });
  }
  if (sign === 'message' || sign === 'both') {
    xml = saml.SamlLib.constructSAMLSignature({
      ...common,
      rawSamlMessage: xml,
      isMessageSigned: true,
      signatureConfig: {
        prefix: 'ds',
        location: { reference: "/*[local-name(.)='Response']/*[local-name(.)='Issuer']", action: 'after' },
      },
    });
  }
  if (o.prelude) xml = xml.startsWith('<?xml') ? xml.replace(/^(<\?xml[^>]*\?>)/, `$1${o.prelude}`) : `${o.prelude}${xml}`;
  return Buffer.from(xml, 'utf8').toString('base64');
}

/** Decodes a response built above (to tamper with it in a test), and encodes it back. */
export const decodeResponse = (b64: string): string => Buffer.from(b64, 'base64').toString('utf8');
export const encodeResponse = (xml: string): string => Buffer.from(xml, 'utf8').toString('base64');
