// Checks on a SAML response that the better-auth sso plugin (1.6.11) does not make, found
// while testing it against a real signed response (saml.flow.test.ts):
//   - the Audience is never compared with this app's entity id, nor the Recipient / Destination
//     with its ACS URL, so a response the IdP signed for ANOTHER service provider is accepted
//     here (a malicious or compromised second app of the same IdP could log people in as
//     themselves, here);
//   - InResponseTo is never bound to an AuthnRequest this app issued: the plugin reads
//     `extract.inResponseTo`, which samlify does not produce (it nests it as
//     `extract.response.inResponseTo`), so its own check never runs.
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
import { defaultSsoFor, isKnownSsoRequest, spEntityIdFor } from './saml';

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

export type GuardResult = { ok: true } | { ok: false; code: 'unparsable' | 'audience' | 'recipient' | 'destination' | 'unknown_request' | 'unsolicited' };

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

export async function checkSamlResponseBinding(opts: {
  provider: SamlFileProvider;
  /** base64 SAMLResponse from the POST body */
  samlResponse: string;
  /** This app's ACS URL for the provider, as the IdP was told. */
  acsUrl: string;
  /** `<BETTER_AUTH_URL>/api/auth`, the base the plugin builds its URLs from. */
  base: string;
  /** Accept a response with no InResponseTo (IdP-initiated login). */
  allowIdpInitiated?: boolean;
  store: VerificationStore;
}): Promise<GuardResult> {
  const { provider, acsUrl, store } = opts;
  const spEntityId = spEntityIdFor(provider, opts.base);
  if (!spEntityId || opts.samlResponse.length > MAX_RESPONSE_LENGTH) return { ok: false, code: 'unparsable' };

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

  // The bearer confirmation INSIDE the signed assertion: where it is to be delivered and which request
  // it answers. (The plugin refuses a response with more than one assertion, so there is one to read.)
  const confirmation = saml.Extractor.extract(samlContent, [
    {
      key: 'confirmation',
      localPath: ['Response', 'Assertion', 'Subject', 'SubjectConfirmation', 'SubjectConfirmationData'],
      attributes: ['Recipient', 'InResponseTo'],
    },
  ]).confirmation as unknown;
  if (Array.isArray(confirmation)) return { ok: false, code: 'unparsable' };
  const signed = (confirmation && typeof confirmation === 'object' ? confirmation : {}) as {
    recipient?: unknown;
    inResponseTo?: unknown;
  };
  if (signed.recipient !== undefined && signed.recipient !== acsUrl) return { ok: false, code: 'recipient' };

  const response = (extract.response ?? {}) as { destination?: unknown; inResponseTo?: unknown };
  if (typeof response.destination === 'string' && response.destination !== acsUrl) {
    return { ok: false, code: 'destination' };
  }

  // The request this answers: the signed value when there is one, else the Response's (which an
  // attacker could strip or forge when only the assertion is signed, hence the cross-check).
  const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
  const fromAssertion = text(signed.inResponseTo);
  const fromResponse = text(response.inResponseTo);
  if (fromAssertion && fromResponse && fromAssertion !== fromResponse) return { ok: false, code: 'unknown_request' };
  const inResponseTo = fromAssertion ?? fromResponse;
  if (inResponseTo === null) {
    return opts.allowIdpInitiated === false ? { ok: false, code: 'unsolicited' } : { ok: true };
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
    baseURL: string;
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
): Promise<GuardResult | null> {
  if (!ctx.path || !ACS_PATHS.has(ctx.path)) return null;
  const samlResponse = (ctx.body as { SAMLResponse?: unknown } | null | undefined)?.SAMLResponse;
  if (typeof samlResponse !== 'string') return null; // the plugin answers a bodiless GET / POST itself
  const providerId = ctx.params?.providerId;
  const provider = providers.find((p) => p.id === providerId);
  if (!provider) return null;

  const adapter = ctx.context.internalAdapter;
  return checkSamlResponseBinding({
    provider,
    samlResponse,
    // The plugin tells the IdP its own ACS route; both routes accept the same POST.
    acsUrl: `${ctx.context.baseURL}/sso/saml2/sp/acs/${provider.id}`,
    base: ctx.context.baseURL,
    allowIdpInitiated: provider.allowIdpInitiated,
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
  } = {},
) {
  const ids = providers.map((p) => p.id);
  return createAuthMiddleware(async (ctx) => {
    if (!isKnownSsoRequest(ctx as never, ids)) throw ctx.error('NOT_FOUND', { message: 'Unknown provider' });
    const verdict = await guardAcsRequest(ctx as never, providers);
    // Fail closed also for 'unparsable': if our own parse of the response failed, so would the plugin's.
    if (verdict && !verdict.ok) {
      await options.onRefused?.(ctx);
      throw ctx.redirect(`${ctx.context.baseURL}/error?error=invalid_saml_response`);
    }
  });
}
