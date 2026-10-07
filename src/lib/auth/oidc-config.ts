// Turns a resolved OIDC provider (./providers.ts) into a better-auth genericOAuth config.
// Everything here is pure or takes `fetch` as a seam, so it is unit-tested without a
// real IdP. Nothing the IdP sends is logged.
import type { GenericOAuthConfig } from 'better-auth/plugins';
import { claimSubset, readClaim } from '@/lib/authz/claims-roles';
import { stashLoginClaims } from '@/lib/authz/claims-stash';
import { decodeJwtPayload } from '@/lib/authz/identity';
import { claimsModeConfigured, isGuid, type IdpPrompt } from './config-file';
import { providerClaimSpecs, type OidcProviderConfig } from './providers';

type Profile = Record<string, unknown>;

const FETCH_TIMEOUT_MS = 10_000;
const MAX_JSON_BYTES = 1_000_000;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const looksLikeEmail = (v: string | undefined): v is string => !!v && /^[^\s@]+@[^\s@]+$/.test(v);

/** `claims.*` first, then the names IdPs actually use. A bare username is not an e-mail address and is skipped. */
function pickEmail(profile: Profile, p: OidcProviderConfig): { email: string; fromEmailClaim: boolean } | undefined {
  const configured = p.claims.email;
  const candidates: Array<[string, boolean]> = [
    ...(configured ? ([[configured, configured === 'email']] as Array<[string, boolean]>) : []),
    ['email', true],
    ['mail', false],
    ['upn', false],
    ['preferred_username', false],
  ];
  for (const [name, isEmailClaim] of candidates) {
    const v = str(readClaim(profile, name));
    if (looksLikeEmail(v)) return { email: v.toLowerCase(), fromEmailClaim: isEmailClaim };
  }
  return undefined;
}

function pickName(profile: Profile, p: OidcProviderConfig, email: string | undefined): string | undefined {
  const configured = p.claims.name ? str(readClaim(profile, p.claims.name)) : undefined;
  const given = str(profile.given_name);
  const family = str(profile.family_name);
  return (
    configured ??
    str(profile.name) ??
    ([given, family].filter(Boolean).join(' ') || undefined) ??
    str(profile.preferred_username) ??
    email
  );
}

/**
 * better-auth's `mapProfileToUser`: identity fields from the configured claim names, with
 * the usual fallbacks, and — as a side effect — the hand-over of this login's role/group
 * claims to the login hook (see authz/claims-stash.ts).
 *
 * `emailVerified` is only ever asserted from the explicitly configured `claims.emailVerified`
 * (a real `true`, or the string "true" that e.g. AD FS sends), and never for an address that
 * was taken from a fallback claim: better-auth uses it to decide whether a login may be
 * linked to an existing account with the same address.
 */
export function mapOidcProfile(p: OidcProviderConfig, profile: Profile): { id?: string; email?: string; name?: string; emailVerified?: boolean } {
  const picked = pickEmail(profile, p);
  const out: { id?: string; email?: string; name?: string; emailVerified?: boolean } = {};
  if (picked) out.email = picked.email;
  const name = pickName(profile, p, picked?.email);
  if (name) out.name = name;

  const idClaim = p.claims.userId;
  const rawId = idClaim ? readClaim(profile, idClaim) : undefined;
  if (idClaim && (typeof rawId === 'string' || typeof rawId === 'number') && String(rawId).trim() !== '') {
    out.id = String(rawId).trim();
  }

  if (p.claims.emailVerified) {
    const v = readClaim(profile, p.claims.emailVerified);
    out.emailVerified = (v === true || v === 'true') && (picked?.fromEmailClaim ?? false);
  } else if (picked && !picked.fromEmailClaim) {
    out.emailVerified = false;
  }

  // Hand the role/group claims over, keyed the way better-auth keys the account: provider + id.
  if (p.rolesClaim || p.groupsClaim) {
    const accountId = out.id ?? str(profile.id) ?? str(profile.sub);
    if (accountId) stashLoginClaims(p.providerId, accountId, claimSubset(profile, p));
  }
  return out;
}

// ─── userinfo merge ──────────────────────────────────────────────────────────

type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

async function fetchJson(fetchFn: FetchLike, url: string, headers: Record<string, string>): Promise<Profile | null> {
  try {
    const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > MAX_JSON_BYTES) return null;
    const json: unknown = JSON.parse(text);
    return json && typeof json === 'object' && !Array.isArray(json) ? (json as Profile) : null;
  } catch {
    return null;
  }
}

interface Discovered {
  userinfo?: string;
  issuer?: string;
}

/** Remembers a discovery document's userinfo endpoint and issuer for the life of the process (they do not change). */
const discovered = new Map<string, Discovered>();

async function discover(p: OidcProviderConfig, fetchFn: FetchLike): Promise<Discovered> {
  if (!p.discoveryUrl) return {};
  const hit = discovered.get(p.providerId);
  if (hit) return hit;
  const doc = await fetchJson(fetchFn, p.discoveryUrl, { Accept: 'application/json' });
  // Only a successful answer is remembered, so a discovery blip does not stick.
  if (!doc) return {};
  const found: Discovered = { userinfo: str(doc.userinfo_endpoint), issuer: str(doc.issuer) };
  discovered.set(p.providerId, found);
  return found;
}

async function userInfoUrlOf(p: OidcProviderConfig, fetchFn: FetchLike): Promise<string | undefined> {
  return p.userInfoUrl ?? (await discover(p, fetchFn)).userinfo;
}

/** The issuer the id token must name: the configured one, else the discovery document's. undefined = unknowable. */
async function expectedIssuerOf(p: OidcProviderConfig, fetchFn: FetchLike): Promise<string | undefined> {
  return p.issuer ?? (await discover(p, fetchFn)).issuer;
}

const CLOCK_TOLERANCE_S = 60;

/**
 * The checks OIDC Core 3.1.3.7 asks of a client before it trusts an id token that came straight
 * from the token endpoint (so the signature itself need not be verified): `aud` contains our
 * client id, `iss` is the expected issuer, and the token has not expired. Pure. The reason is a
 * short code, never a value.
 */
export function checkIdTokenClaims(
  claims: Profile,
  clientId: string,
  expectedIssuer: string | undefined,
  now = Date.now(),
): 'ok' | 'aud' | 'iss' | 'exp' {
  const aud = claims.aud;
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.some((a) => typeof a === 'string' && a === clientId)) return 'aud';
  if (expectedIssuer !== undefined && claims.iss !== expectedIssuer) return 'iss';
  if (typeof claims.exp === 'number' && claims.exp * 1000 < now - CLOCK_TOLERANCE_S * 1000) return 'exp';
  return 'ok';
}

/**
 * better-auth's default reads ONLY the id_token when it carries sub and email, and never asks
 * the userinfo endpoint; with no email in the id_token it gives up unless the userinfo has one.
 * Role and group claims, and the mail / upn / preferred_username fallbacks, are often available
 * only at the userinfo endpoint, so this merges its response in for whatever the id_token lacks.
 * The id_token (straight from the token endpoint) wins on every key both have, and a userinfo
 * answer whose `sub` differs from the id_token's is discarded (OIDC Core 5.3.2). Falls back to
 * the id_token alone when the endpoint is unknown or fails: the claims are then simply absent,
 * which grants nothing.
 */
export async function loadOidcProfile(
  p: OidcProviderConfig,
  tokens: { idToken?: string; accessToken?: string },
  fetchFn: FetchLike = fetch as unknown as FetchLike,
): Promise<Profile | null> {
  const fromToken = tokens.idToken ? decodeJwtPayload(tokens.idToken) : null;
  if (tokens.idToken && !fromToken) {
    console.warn(`[auth] login refused: undecodable id token from provider ${p.providerId}`);
    return null;
  }
  if (fromToken) {
    // Before any claim is trusted. With a discoveryUrl or issuer configured the issuer MUST be knowable
    // (a failed discovery refuses the login); with only explicit endpoints there is nothing to compare.
    const expected = await expectedIssuerOf(p, fetchFn);
    const knowable = !!(p.issuer || p.discoveryUrl);
    const verdict = knowable && expected === undefined ? 'iss' : checkIdTokenClaims(fromToken, p.clientId, expected);
    if (verdict !== 'ok') {
      console.warn(`[auth] login refused: id token ${verdict} check failed for provider ${p.providerId}`);
      return null;
    }
  }
  const wanted = [p.rolesClaim, p.groupsClaim].flatMap((s) => (s ? [s.name] : []));
  const missingClaim = wanted.some((name) => !fromToken || readClaim(fromToken, name) === undefined);
  const needsEmail = !fromToken || !pickEmail(fromToken, p);

  let merged: Profile = { ...(fromToken ?? {}) };
  if ((missingClaim || needsEmail) && tokens.accessToken) {
    const url = await userInfoUrlOf(p, fetchFn);
    const info = url ? await fetchJson(fetchFn, url, { Authorization: `Bearer ${tokens.accessToken}`, Accept: 'application/json' }) : null;
    // The userinfo answer must name the same person (OIDC Core 5.3.2); without an id token there is nothing to compare.
    const sameSubject = !fromToken?.sub || info?.sub === fromToken.sub;
    if (info && sameSubject) merged = { ...info, ...merged };
  }

  const sub = str(merged.sub);
  if (!sub) return null;
  // Without an address better-auth would log the WHOLE profile (role and group claims included) while
  // refusing the login. Refuse here instead, with a line that names the provider only.
  if (!pickEmail(merged, p)) {
    console.warn(`[auth] login refused: no e-mail address in the profile from provider ${p.providerId}`);
    return null;
  }
  return { ...merged, id: sub, emailVerified: merged.email_verified === true, image: merged.picture };
}

/** Test seam. */
export function resetOidcDiscoveryCache(): void {
  discovered.clear();
}

/** The genericOAuth entry for one provider. */
export function genericOAuthConfigFor(p: OidcProviderConfig): GenericOAuthConfig {
  return {
    providerId: p.providerId,
    clientId: p.clientId,
    clientSecret: p.clientSecret,
    ...(p.discoveryUrl ? { discoveryUrl: p.discoveryUrl } : {}),
    ...(p.issuer ? { issuer: p.issuer } : {}),
    ...(p.authorizationUrl ? { authorizationUrl: p.authorizationUrl } : {}),
    ...(p.tokenUrl ? { tokenUrl: p.tokenUrl } : {}),
    ...(p.userInfoUrl ? { userInfoUrl: p.userInfoUrl } : {}),
    scopes: p.scopes,
    pkce: p.pkce,
    ...(p.prompt ? { prompt: p.prompt } : {}),
    ...(p.maxAge !== undefined ? { authorizationUrlParams: { max_age: String(p.maxAge) } } : {}),
    mapProfileToUser: (profile) => mapOidcProfile(p, profile as Profile),
    getUserInfo: async (tokens) => {
      const profile = await loadOidcProfile(p, { idToken: tokens.idToken, accessToken: tokens.accessToken });
      return profile as never;
    },
  };
}

// ─── Microsoft Entra ID (the built-in social provider) ───────────────────────

export interface EntraProviderConfig {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  scopes?: string[];
  prompt?: IdpPrompt;
}

const ENTRA_AUTHORITY = 'https://login.microsoftonline.com';

/**
 * What an Entra id token must satisfy before a login is built from it: the audience is our app; and with ONE
 * tenant configured (a GUID) the token comes from that tenant (`tid`) and its issuer is that tenant's. With a
 * multi-tenant authority (only possible outside claims mode) the issuer varies per tenant and cannot be checked.
 */
export function checkEntraIdToken(claims: Profile, m: Pick<EntraProviderConfig, 'clientId' | 'tenantId'>, now = Date.now()): 'ok' | 'aud' | 'iss' | 'tid' | 'exp' {
  const singleTenant = isGuid(m.tenantId) ? m.tenantId.trim().toLowerCase() : undefined;
  const base = checkIdTokenClaims(claims, m.clientId, singleTenant ? `${ENTRA_AUTHORITY}/${singleTenant}/v2.0` : undefined, now);
  if (base !== 'ok') return base;
  if (singleTenant && !(typeof claims.tid === 'string' && claims.tid.trim().toLowerCase() === singleTenant)) return 'tid';
  return 'ok';
}

/**
 * The better-auth `socialProviders.microsoft` options. Differences from the defaults, all deliberate:
 *  - scopes are explicit and never include offline_access (no refresh token is wanted) or User.Read (no Graph call);
 *  - `getUserInfo` reads the id token from the token endpoint like the default does, but first checks audience,
 *    issuer and tenant, hands the role/group claims to the login hook, and never touches Graph;
 *  - a token that fails the checks refuses the login (better-auth answers unable_to_get_user_info).
 */
export function entraSocialConfig(m: EntraProviderConfig) {
  const extra = (m.scopes ?? []).filter((s) => s !== 'offline_access');
  return {
    clientId: m.clientId,
    clientSecret: m.clientSecret,
    tenantId: m.tenantId,
    disableDefaultScope: true,
    scope: [...new Set(['openid', 'profile', 'email', ...extra])],
    ...(m.prompt ? { prompt: m.prompt } : {}),
    disableProfilePhoto: true,
    getUserInfo: async (token: { idToken?: string }) => {
      const claims = token.idToken ? decodeJwtPayload(token.idToken) : null;
      if (!claims || typeof claims.sub !== 'string' || claims.sub === '') return null;
      const verdict = checkEntraIdToken(claims, m);
      if (verdict !== 'ok') {
        console.warn(`[auth] login refused: Microsoft id token ${verdict} check failed`);
        return null;
      }
      if (claimsModeConfigured()) {
        const specs = providerClaimSpecs('microsoft');
        stashLoginClaims('microsoft', claims.sub, {
          ...(specs ? claimSubset(claims, specs) : {}),
          ...(typeof claims.tid === 'string' ? { tid: claims.tid } : {}),
        });
      }
      const email = str(claims.email);
      return {
        user: {
          id: claims.sub,
          name: str(claims.name),
          email: email?.toLowerCase(),
          image: undefined,
          emailVerified: claims.email_verified === true,
        },
        data: claims,
      };
    },
  };
}
