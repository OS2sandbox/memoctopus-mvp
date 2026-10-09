// Captures a whitelisted snapshot of an SSO login's identity claims into
// public.external_identities. Later steps (directory match, bootstrap admin)
// read that snapshot, never the raw token.
import { defaultRunner, type SqlRunner } from './pg-runner';

/** The ONLY claims ever persisted. Never groups/roles, never the token itself. */
export const CLAIM_WHITELIST = [
  'sub',
  'email',
  'email_verified',
  'preferred_username',
  'upn',
  'oid',
  'tid',
  'name',
] as const;

type ClaimName = (typeof CLAIM_WHITELIST)[number];
export type IdentityClaims = Partial<Record<Exclude<ClaimName, 'email_verified'>, string>> & {
  email_verified?: boolean;
};

export interface ExternalIdentity {
  userId: string;
  providerId: string;
  subject: string;
  claims: IdentityClaims;
}

/**
 * Decodes the payload of a JWT WITHOUT verifying its signature. That is
 * acceptable here only because the token is the one better-auth received
 * directly from the IdP's token endpoint over TLS and stored itself (the same
 * trust better-auth's own default claim reading relies on); it is never taken
 * from the browser. Returns null on anything malformed.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload: unknown = JSON.parse(json);
    return payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Keeps whitelisted claims of the expected type only. `email_verified` must be a
 * real boolean: string forms like "true" are dropped so that a verification
 * check can only ever pass on an explicit `true` (fail closed).
 */
export function pickClaims(payload: Record<string, unknown>): IdentityClaims {
  const out: IdentityClaims = {};
  for (const key of CLAIM_WHITELIST) {
    const value = payload[key];
    if (key === 'email_verified') {
      if (typeof value === 'boolean') out.email_verified = value;
    } else if (typeof value === 'string' && value.trim() !== '') {
      out[key] = value;
    }
  }
  return out;
}

interface AccountRow {
  provider_id: string;
  id_token: string | null;
}

/**
 * Upserts one external_identities row from an already-decoded claim set. The shared
 * tail of both capture paths: the id_token of an OIDC account (below) and the mapped
 * attributes of a SAML assertion (captureIdentityFromAttributes), neither of which
 * persists anything beyond the whitelist. Null when the claims carry no subject or the
 * subject is already bound to another user.
 */
async function upsertIdentity(
  runner: SqlRunner,
  userId: string,
  providerId: string,
  payload: Record<string, unknown>,
): Promise<ExternalIdentity | null> {
  const claims = pickClaims(payload);
  if (!claims.sub) {
    console.warn(`[authz] identity without subject (provider ${providerId})`);
    return null;
  }

  // The WHERE keeps (provider, subject) bound to the first user that claimed
  // it: a second app user presenting the same subject must not steal the row.
  const res = await runner.query(
    `INSERT INTO public.external_identities AS ei (user_id, provider_id, subject, claims)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (provider_id, subject) DO UPDATE
       SET claims = EXCLUDED.claims, last_seen_at = now()
       WHERE ei.user_id = EXCLUDED.user_id
     RETURNING id`,
    [userId, providerId, claims.sub, JSON.stringify(claims)],
  );
  if (res.rows.length === 0) {
    console.warn(`[authz] external identity already bound to another user (code identity_conflict, provider ${providerId})`);
    return null;
  }
  return { userId, providerId, subject: claims.sub, claims };
}

/**
 * Upserts one external_identities row per SSO account of the user. Never throws
 * for bad tokens (logged by label only); DB errors propagate to the caller,
 * which owns the swallow-and-log policy.
 */
export async function captureExternalIdentity(
  userId: string,
  runner: SqlRunner = defaultRunner(),
): Promise<ExternalIdentity[]> {
  // 'credential' is better-auth's email/password account: its "identity" is
  // whatever the visitor typed at sign-up and must never be treated as SSO.
  // SAML accounts have no id_token and are captured from the assertion instead.
  const accounts = await runner.query<AccountRow>(
    `SELECT provider_id, id_token FROM public.accounts
      WHERE user_id = $1 AND provider_id <> 'credential' AND id_token IS NOT NULL`,
    [userId],
  );

  const captured: ExternalIdentity[] = [];
  for (const account of accounts.rows) {
    const payload = account.id_token ? decodeJwtPayload(account.id_token) : null;
    if (!payload) {
      console.warn(`[authz] id_token not decodable for an SSO account (provider ${account.provider_id})`);
      continue;
    }
    const identity = await upsertIdentity(runner, userId, account.provider_id, payload);
    if (identity) captured.push(identity);
  }
  return captured;
}

/**
 * The SAML counterpart of captureExternalIdentity: there is no id_token, so the identity
 * snapshot is built from the attributes that better-auth's SAML mapping delivered
 * (userInfo: id, email, name, plus the optional `upn` / `preferred_username` extras).
 * Same whitelist, same ownership rule. `email_verified` is only ever true when the
 * mapping said so as a real boolean (better-auth leaves it false unless trusted).
 */
export async function captureIdentityFromAttributes(
  userId: string,
  providerId: string,
  userInfo: Record<string, unknown>,
  runner: SqlRunner = defaultRunner(),
): Promise<ExternalIdentity | null> {
  if (providerId === 'credential') return null;
  const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);
  return upsertIdentity(runner, userId, providerId, {
    sub: typeof userInfo.id === 'number' ? String(userInfo.id) : userInfo.id,
    email: first(userInfo.email),
    name: first(userInfo.name),
    upn: first(userInfo.upn),
    preferred_username: first(userInfo.preferred_username),
    email_verified: userInfo.emailVerified,
  });
}
