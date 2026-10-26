import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { pool } from '@/lib/db';
import { outlookAddinConfig } from '@/lib/auth/providers';

/**
 * Who is calling from the Outlook add-in.
 *
 * The add-in signs in with nested app authentication (NAA): Outlook hands it an
 * Entra access token for our own API, issued to the same app registration the
 * dashboard signs in with. The server never sees a password or a session cookie
 * from the add-in, only that token, so everything below is the whole check:
 *
 *  - signed by Entra (keys from the tenant's JWKS, RS256 only),
 *  - issued by OUR tenant and no other (`iss` and `tid`),
 *  - for our API (`aud`), to our own client (`azp`/`appid`), on behalf of a
 *    user (`scp` contains access_as_user; an app-only token has `roles`, no `scp`),
 *  - not expired.
 *
 * The user is then found by the token's `sub`, which is what better-auth stored
 * as the Microsoft account id at dashboard sign-in. `sub` is pairwise per user
 * and app registration, and both tokens come from the same registration, so the
 * two match. Someone who has never signed in to the dashboard with Microsoft has
 * no account row, no stored Graph token, and cannot arm anything.
 */

export const ADDIN_SCOPE = 'access_as_user';

export type AddinAuthErrorCode = 'disabled' | 'missing_token' | 'invalid_token' | 'no_account';

/** Danish, user-safe: shown in the add-in's pane. */
const MESSAGES: Record<AddinAuthErrorCode, string> = {
  disabled: 'Outlook-tilføjelsesprogrammet er ikke slået til på serveren.',
  missing_token: 'Tilføjelsesprogrammet sendte ikke noget login med.',
  invalid_token: 'Dit Microsoft-login kunne ikke godkendes. Luk ruden og prøv igen.',
  no_account:
    'Du skal logge ind på OS2taletiltekst med Microsoft én gang, før du kan bruge knappen i Outlook.',
};

const STATUS: Record<AddinAuthErrorCode, number> = {
  disabled: 403,
  missing_token: 401,
  invalid_token: 401,
  no_account: 403,
};

export class AddinAuthError extends Error {
  readonly code: AddinAuthErrorCode;
  readonly status: number;
  constructor(code: AddinAuthErrorCode, detail?: string) {
    super(MESSAGES[code]);
    this.name = 'AddinAuthError';
    this.code = code;
    this.status = STATUS[code];
    // Server-side log only: the reason a token was refused, never the token.
    if (detail) this.cause = detail;
  }
}

export interface AddinClaims {
  sub: string;
  oid: string | null;
  tid: string;
}

/** One key set per tenant; jose caches the keys and refetches on an unknown `kid`. */
const keySets = new Map<string, JWTVerifyGetKey>();

function tenantKeys(tenantId: string): JWTVerifyGetKey {
  let keys = keySets.get(tenantId);
  if (!keys) {
    keys = createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`),
    );
    keySets.set(tenantId, keys);
  }
  return keys;
}

export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+([A-Za-z0-9._-]+)$/.exec(header.trim());
  return match ? match[1] : null;
}

function claimString(payload: JWTPayload, name: string): string | null {
  const value = payload[name];
  return typeof value === 'string' && value ? value : null;
}

/**
 * Verifies an add-in access token. `keys` is for tests; in production the
 * tenant's published signing keys are used.
 */
export async function verifyAddinToken(
  token: string,
  config: { clientId: string; tenantId: string },
  keys: JWTVerifyGetKey = tenantKeys(config.tenantId),
): Promise<AddinClaims> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, keys, {
      algorithms: ['RS256'],
      // v2 tokens (what the registration is set to issue) and v1, in case the
      // registration's token version is left at its default.
      issuer: [
        `https://login.microsoftonline.com/${config.tenantId}/v2.0`,
        `https://sts.windows.net/${config.tenantId}/`,
      ],
      audience: [config.clientId, `api://${config.clientId}`],
      requiredClaims: ['exp', 'sub', 'tid'],
      clockTolerance: 60,
    }));
  } catch (err) {
    throw new AddinAuthError('invalid_token', err instanceof Error ? err.message : String(err));
  }

  const tid = claimString(payload, 'tid')?.toLowerCase();
  if (tid !== config.tenantId) throw new AddinAuthError('invalid_token', 'tid is not our tenant');

  // v2 names the client `azp`, v1 `appid`.
  const client = (claimString(payload, 'azp') ?? claimString(payload, 'appid'))?.toLowerCase();
  if (client !== config.clientId) throw new AddinAuthError('invalid_token', 'issued to another client');

  const scopes = (claimString(payload, 'scp') ?? '').split(' ');
  if (!scopes.includes(ADDIN_SCOPE)) throw new AddinAuthError('invalid_token', 'no access_as_user scope');

  const sub = claimString(payload, 'sub');
  if (!sub) throw new AddinAuthError('invalid_token', 'no sub');
  return { sub, oid: claimString(payload, 'oid'), tid };
}

/** The better-auth user behind a verified token, by its Microsoft account. */
export async function userIdForClaims(claims: AddinClaims): Promise<string> {
  const result = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM accounts WHERE provider_id = 'microsoft' AND account_id = $1 LIMIT 2`,
    [claims.sub],
  );
  // Exactly one: an account id shared by two users would be a better-auth bug,
  // and guessing between them would act on the wrong person's meetings.
  if (result.rows.length !== 1) {
    throw new AddinAuthError('no_account', `matched ${result.rows.length} accounts`);
  }
  return result.rows[0].user_id;
}

/**
 * The whole gate for an add-in request: the feature is on, a bearer token is
 * present and valid, and it belongs to a known user. Returns that user's id.
 */
export async function authenticateAddinRequest(headers: Headers): Promise<string> {
  const config = outlookAddinConfig();
  if (!config) throw new AddinAuthError('disabled');
  const token = bearerToken(headers.get('authorization'));
  if (!token) throw new AddinAuthError('missing_token');
  const claims = await verifyAddinToken(token, config);
  return userIdForClaims(claims);
}
