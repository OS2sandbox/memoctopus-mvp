// Checks on a SAML response that the better-auth sso plugin (1.6.11) does not make, found
// while testing it against a real signed response (saml.flow.test.ts):
//   - the Audience is never compared with this app's entity id, nor the Recipient / Destination
//     with its ACS URL, so a response the IdP signed for ANOTHER service provider is accepted
//     here (a malicious or compromised second app of the same IdP could log people in as
//     themselves, here);
//   - InResponseTo is never bound to an AuthnRequest this app issued: the plugin reads
//     `extract.inResponseTo`, which samlify does not produce (it nests it as
//     `extract.response.inResponseTo`), so its own check never runs.
//   - a response that carries a DOCTYPE or ENTITY declaration is refused before any XML parser sees it;
//   - the Recipient is REQUIRED (not just compared when present), and so is the Destination of a
//     response that is signed as a whole;
//   - unless allowIdpInitiated, the request this answers must be named by the SIGNED InResponseTo of
//     the assertion (the Response-level one is not covered by an assertion-only signature).
// The ACS URL and the entity id are derived from BETTER_AUTH_URL (authBaseUrl()), never from the
// request's Host header or the framework's idea of the base URL.
// This runs as a `before` hook on the ACS routes. It verifies the response itself (the same
// signature check the plugin then does again) and refuses before any user or session exists.
// It only ever REFUSES; passing it grants nothing, the plugin still decides.
//
// Server-only. Pinned to @better-auth/sso 1.6.11 + samlify 2.13: the stored-request key below
// is the plugin's own (src/routes/saml-pipeline.ts). A plugin upgrade must re-run saml.flow.test.ts.
import '@better-auth/sso';
import { createAuthMiddleware } from 'better-auth/api';
import * as samlifyNs from 'samlify';
import samlifyDefault from 'samlify';
import type { SamlFileProvider } from './providers';
import { authBaseUrl, defaultSsoFor, isKnownSsoRequest, spEntityIdFor } from './saml';

type Samlify = typeof samlifyNs;
const saml: Samlify = typeof samlifyNs.IdentityProvider === 'function' ? samlifyNs : (samlifyDefault as unknown as Samlify);

/** The plugin's own default cap on a SAML response; checked here first so our parse is never fed more. */
const MAX_RESPONSE_LENGTH = 262_144;

/** The plugin's key for an AuthnRequest id it issued (value: JSON { id, providerId, expiresAt }). */
const AUTHN_REQUEST_KEY_PREFIX = 'saml-authn-request:';

export interface VerificationStore {
  find(identifier: string): Promise<{ value: string } | null | undefined>;
  remove(identifier: string): Promise<unknown>;
}

export type GuardResult = { ok: true } | { ok: false; code: 'unparsable' | 'audience' | 'recipient' | 'destination' | 'unknown_request' | 'unsolicited' | 'algorithm' };

// The plugin validates the signature algorithm only from the redirect binding's SigAlg parameter, which a POST
// response (the only binding used here) never has, so its `algorithms.onDeprecated` option never fires for a
// response. The algorithms are read from the signed XML here instead: an allow-list, with SHA-1 added back only
// for a provider that opted in (allowDeprecatedAlgorithms).
const NS_MORE = 'http://www.w3.org/2001/04/xmldsig-more#';
const NS_ENC = 'http://www.w3.org/2001/04/xmlenc#';
const SECURE_SIGNATURE_ALGORITHMS = new Set(
  ['rsa-sha256', 'rsa-sha384', 'rsa-sha512', 'ecdsa-sha256', 'ecdsa-sha384', 'ecdsa-sha512'].map((a) => NS_MORE + a),
);
const SECURE_DIGEST_ALGORITHMS = new Set([`${NS_ENC}sha256`, `${NS_MORE}sha384`, `${NS_ENC}sha512`]);
const DEPRECATED_ALGORITHMS = new Set([
  'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
  'http://www.w3.org/2000/09/xmldsig#dsa-sha1',
  'http://www.w3.org/2000/09/xmldsig#sha1',
]);

/** A DTD has no place in a SAML response: it is how XXE and entity-expansion attacks are made. */
const DTD_RE = /<!\s*(DOCTYPE|ENTITY)/i;

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : []);

/** The IdP / SP as samlify sees them, built the way the plugin builds them from the same config. */
function entities(p: SamlFileProvider, acsUrl: string, spEntityId: string, base: string) {
  const cfg = defaultSsoFor(p, base)?.samlConfig;
  const idpData = cfg?.idpMetadata;
  const idp = idpData?.metadata
    ? saml.IdentityProvider({ metadata: idpData.metadata })
    : saml.IdentityProvider({
        entityID: idpData?.entityID ?? cfg?.issuer,
        singleSignOnService: idpData?.singleSignOnService,
        signingCert: idpData?.cert ?? cfg?.cert,
      });
  const sp = saml.ServiceProvider({
    entityID: spEntityId,
    assertionConsumerService: [{ Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST', Location: acsUrl }],
    wantMessageSigned: p.wantAssertionsSigned,
  });
  return { idp, sp };
}

/** The signature and digest algorithm URIs of the signatures on the Response and on its Assertion. */
function signatureAlgorithmsOf(samlContent: string): { signature: string[]; digest: string[] } {
  const at = (root: string[]) => [
    { key: `${root.join('/')}#sig`, localPath: [...root, 'Signature', 'SignedInfo', 'SignatureMethod'], attributes: ['Algorithm'] },
    { key: `${root.join('/')}#dig`, localPath: [...root, 'Signature', 'SignedInfo', 'Reference', 'DigestMethod'], attributes: ['Algorithm'] },
  ];
  const out = saml.Extractor.extract(samlContent, [...at(['Response']), ...at(['Response', 'Assertion'])]) as Record<string, unknown>;
  const collect = (suffix: string) =>
    Object.entries(out)
      .filter(([k]) => k.endsWith(suffix))
      .flatMap(([, v]) => (Array.isArray(v) ? v : [v]))
      .flatMap((v) => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v) : []))
      .filter((v): v is string => typeof v === 'string');
  return { signature: collect('#sig'), digest: collect('#dig') };
}

export async function checkSamlResponseBinding(opts: {
  provider: SamlFileProvider;
  /** base64 SAMLResponse from the POST body */
  samlResponse: string;
  /** `<BETTER_AUTH_URL>/api/auth`, the base the plugin builds its URLs from (and the ACS URL is derived from; never from the request). */
  base: string;
  /** Accept a response that answers no request of ours (IdP-initiated login). Default false. */
  allowIdpInitiated?: boolean;
  store: VerificationStore;
}): Promise<GuardResult> {
  const { provider, store } = opts;
  // This app's ACS URL for the provider, as the IdP was told: derived from the configured base, never from the request.
  const acsUrl = `${opts.base}/sso/saml2/sp/acs/${provider.id}`;
  const spEntityId = spEntityIdFor(provider, opts.base);
  if (!spEntityId || opts.samlResponse.length > MAX_RESPONSE_LENGTH) return { ok: false, code: 'unparsable' };
  try {
    if (DTD_RE.test(Buffer.from(opts.samlResponse.replace(/\s+/g, ''), 'base64').toString('utf8'))) return { ok: false, code: 'unparsable' };
  } catch {
    return { ok: false, code: 'unparsable' };
  }

  let extract: Record<string, unknown>;
  let samlContent: string;
  try {
    const { idp, sp } = entities(provider, acsUrl, spEntityId, opts.base);
    const parsed = await sp.parseLoginResponse(idp, 'post', {
      body: { SAMLResponse: opts.samlResponse.replace(/\s+/g, '') },
    });
    extract = parsed.extract as Record<string, unknown>;
    samlContent = parsed.samlContent as string;
  } catch {
    // Signature, issuer, time or structure: the plugin refuses it with its own detail.
    return { ok: false, code: 'unparsable' };
  }

  // The signed Audience must name us.
  if (!asList(extract.audience).includes(spEntityId)) return { ok: false, code: 'audience' };

  const algorithms = signatureAlgorithmsOf(samlContent);
  const deprecatedOk = provider.allowDeprecatedAlgorithms === true;
  const acceptable = (set: Set<string>, found: string[]) =>
    found.every((a) => set.has(a) || (deprecatedOk && DEPRECATED_ALGORITHMS.has(a)));
  if (
    algorithms.signature.length === 0 ||
    algorithms.digest.length === 0 ||
    !acceptable(SECURE_SIGNATURE_ALGORITHMS, algorithms.signature) ||
    !acceptable(SECURE_DIGEST_ALGORITHMS, algorithms.digest)
  ) {
    return { ok: false, code: 'algorithm' };
  }

  // The bearer confirmation INSIDE the signed assertion: where it is to be delivered and which request
  // it answers. (The plugin refuses a response with more than one assertion, so there is one to read.)
  const extracted = saml.Extractor.extract(samlContent, [
    {
      key: 'confirmation',
      localPath: ['Response', 'Assertion', 'Subject', 'SubjectConfirmation', 'SubjectConfirmationData'],
      attributes: ['Recipient', 'InResponseTo'],
    },
    // Present only when the Response element itself carries a signature.
    { key: 'responseSignature', localPath: ['Response', 'Signature', 'SignedInfo', 'Reference'], attributes: ['URI'] },
  ]);
  const confirmation = extracted.confirmation as unknown;
  if (Array.isArray(confirmation)) return { ok: false, code: 'unparsable' };
  const signed = (confirmation && typeof confirmation === 'object' ? confirmation : {}) as {
    recipient?: unknown;
    inResponseTo?: unknown;
  };
  // The Recipient is mandatory: a bearer assertion that does not say where it may be delivered can be replayed anywhere.
  if (signed.recipient !== acsUrl) return { ok: false, code: 'recipient' };

  const response = (extract.response ?? {}) as { destination?: unknown; inResponseTo?: unknown };
  if (typeof response.destination === 'string') {
    if (response.destination !== acsUrl) return { ok: false, code: 'destination' };
  } else if (extracted.responseSignature) {
    // A response signed as a whole must name its Destination (SAML profiles 4.1.4.5).
    return { ok: false, code: 'destination' };
  }

  // The request this answers: the signed value when there is one, else the Response's (which an
  // attacker could strip or forge when only the assertion is signed, hence the cross-check).
  const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
  const fromAssertion = text(signed.inResponseTo);
  const fromResponse = text(response.inResponseTo);
  if (fromAssertion && fromResponse && fromAssertion !== fromResponse) return { ok: false, code: 'unknown_request' };
  const allowIdpInitiated = opts.allowIdpInitiated === true;
  // Without IdP-initiated logins, only the signed assertion-level value counts as proof of a request of ours.
  const inResponseTo = allowIdpInitiated ? (fromAssertion ?? fromResponse) : fromAssertion;
  if (inResponseTo === null) {
    return allowIdpInitiated ? { ok: true } : { ok: false, code: 'unsolicited' };
  }

  // Answers a request: it must be one this app issued for THIS provider and still be open; it is
  // consumed either way, so a response (or its copy) cannot answer the same request twice.
  const key = `${AUTHN_REQUEST_KEY_PREFIX}${inResponseTo}`;
  const stored = await store.find(key);
  await store.remove(key);
  if (!stored) return { ok: false, code: 'unknown_request' };
  try {
    const record = JSON.parse(stored.value) as { providerId?: unknown; expiresAt?: unknown };
    if (record.providerId !== provider.id || typeof record.expiresAt !== 'number' || record.expiresAt < Date.now()) {
      return { ok: false, code: 'unknown_request' };
    }
  } catch {
    return { ok: false, code: 'unknown_request' };
  }
  return { ok: true };
}

/** Route templates of the two endpoints that complete a SAML login. */
const ACS_PATHS = new Set(['/sso/saml2/sp/acs/:providerId', '/sso/saml2/callback/:providerId']);

interface HookContext {
  path?: string;
  method?: string;
  params?: Record<string, unknown> | null;
  body?: unknown;
  context: {
    internalAdapter: {
      findVerificationValue(identifier: string): Promise<{ value: string } | null | undefined>;
      deleteVerificationByIdentifier(identifier: string): Promise<unknown>;
    };
  };
}

/**
 * The `before` hook body for the ACS routes. Null when this request is not a SAML response POST
 * (nothing to check), otherwise the verdict. A provider the config does not know is left to the
 * unknown-provider guard in saml.ts.
 */
export async function guardAcsRequest(
  ctx: HookContext,
  providers: readonly SamlFileProvider[],
  baseOverride?: string,
): Promise<GuardResult | null> {
  if (!ctx.path || !ACS_PATHS.has(ctx.path)) return null;
  const samlResponse = (ctx.body as { SAMLResponse?: unknown } | null | undefined)?.SAMLResponse;
  if (typeof samlResponse !== 'string') return null; // the plugin answers a bodiless GET / POST itself
  const providerId = ctx.params?.providerId;
  const provider = providers.find((p) => p.id === providerId);
  if (!provider) return null;

  // Derived from BETTER_AUTH_URL, not from ctx.context.baseURL (which may follow the request's Host).
  const base = baseOverride ?? authBaseUrl();
  if (!base) return { ok: false, code: 'unparsable' };

  const adapter = ctx.context.internalAdapter;
  return checkSamlResponseBinding({
    provider,
    samlResponse,
    base,
    allowIdpInitiated: provider.allowIdpInitiated === true,
    store: {
      find: (identifier) => adapter.findVerificationValue(identifier),
      remove: (identifier) => adapter.deleteVerificationByIdentifier(identifier),
    },
  });
}

/**
 * The better-auth `before` hook for installations with SAML providers: unknown provider ids are a
 * plain 404, and a SAML response must pass checkSamlResponseBinding before the plugin sees it.
 */
export function samlBeforeHook(
  providers: readonly SamlFileProvider[],
  options: {
    /**
     * Called (and awaited) before a refused response is answered. A request refused in a `before` hook
     * never reaches the `after` hooks, so the failed-login audit has to be fed from here.
     */
    onRefused?: (ctx: unknown) => Promise<void>;
    /** `<BETTER_AUTH_URL>/api/auth`; default authBaseUrl(). A test seam: production never passes it. */
    base?: string;
  } = {},
) {
  const ids = providers.map((p) => p.id);
  return createAuthMiddleware(async (ctx) => {
    if (!isKnownSsoRequest(ctx as never, ids)) throw ctx.error('NOT_FOUND', { message: 'Unknown provider' });
    const verdict = await guardAcsRequest(ctx as never, providers, options.base);
    // Fail closed also for 'unparsable': if our own parse of the response failed, so would the plugin's.
    if (verdict && !verdict.ok) {
      await options.onRefused?.(ctx);
      throw ctx.redirect(`${options.base ?? authBaseUrl() ?? ctx.context.baseURL}/error?error=invalid_saml_response`);
    }
  });
}
