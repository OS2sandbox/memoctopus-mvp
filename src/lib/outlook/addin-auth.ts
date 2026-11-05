import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
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
 *
 * That is the `api` mode. With OUTLOOK_ADDIN_CLIENT_ID the add-in signs in with
 * a second app registration instead and sends its ID token (`id` mode,
 * verifyAddinIdToken() and userIdForObjectId() below).
 */

export const ADDIN_SCOPE = 'access_as_user';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type AddinAuthErrorCode = 'disabled' | 'missing_token' | 'invalid_token' | 'no_account' | 'not_allowed';

/** Danish, user-safe: shown in the add-in's pane. */
const MESSAGES: Record<AddinAuthErrorCode, string> = {
  disabled: 'Outlook-tilføjelsesprogrammet er ikke slået til på serveren.',
  missing_token: 'Tilføjelsesprogrammet sendte ikke noget login med.',
  invalid_token: 'Dit Microsoft-login kunne ikke godkendes. Luk ruden og prøv igen.',
  no_account:
    'Du skal logge ind på OS2taletiltekst med Microsoft én gang, før du kan bruge knappen i Outlook.',
  not_allowed: 'Outlook-tilføjelsesprogrammet er ikke slået til for dig endnu. Kontakt jeres IT-administrator.',
};

const STATUS: Record<AddinAuthErrorCode, number> = {
  disabled: 403,
  missing_token: 401,
  invalid_token: 401,
  no_account: 403,
  not_allowed: 403,
};

/**
 * OUTLOOK_ADDIN_ALLOWED_USERS: comma-separated e-mail addresses that may use the
 * add-in, matched case-insensitively against the user's OS2taletiltekst e-mail.
 * Unset or empty: everyone. Set to anything else, it fails closed (a list that
 * parses to no addresses lets nobody in). For trying the add-in out on a live
 * server, on top of whatever the admin assigned in Outlook and Entra.
 */
export function addinAllowedEmails(): Set<string> | null {
  const raw = process.env.OUTLOOK_ADDIN_ALLOWED_USERS?.trim();
  if (!raw) return null;
  return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

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

/**
 * The `id` sign-in mode: an ID token issued to the add-in's own app
 * registration (OUTLOOK_ADDIN_CLIENT_ID). It proves who the user is and nothing
 * else, which is all the add-in's calls need: every Graph call is made with the
 * user's stored dashboard grant, never with anything the add-in sends.
 *
 *  - signed by Entra (tenant JWKS, RS256 only), v2 issuer of OUR tenant, `tid` ours,
 *  - for the add-in's app (`aud`), not expired,
 *  - an ID token, not an access token: no `scp`, no `roles`, not `idtyp: app`,
 *  - with an `oid`, the user's object id, which unlike `sub` is the same in
 *    every app registration of the tenant.
 */
export async function verifyAddinIdToken(
  token: string,
  config: { clientId: string; tenantId: string },
  keys: JWTVerifyGetKey = tenantKeys(config.tenantId),
): Promise<AddinClaims> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, keys, {
      algorithms: ['RS256'],
      issuer: `https://login.microsoftonline.com/${config.tenantId}/v2.0`,
      audience: config.clientId,
      requiredClaims: ['exp', 'sub', 'tid', 'oid'],
      clockTolerance: 60,
    }));
  } catch (err) {
    throw new AddinAuthError('invalid_token', err instanceof Error ? err.message : String(err));
  }

  const tid = claimString(payload, 'tid')?.toLowerCase();
  if (tid !== config.tenantId) throw new AddinAuthError('invalid_token', 'tid is not our tenant');
  if (payload.scp !== undefined || payload.roles !== undefined || payload.idtyp === 'app') {
    throw new AddinAuthError('invalid_token', 'an access token, not an ID token');
  }
  const oid = claimString(payload, 'oid')?.toLowerCase();
  if (!oid || !GUID_RE.test(oid)) throw new AddinAuthError('invalid_token', 'no object id');
  const sub = claimString(payload, 'sub');
  if (!sub) throw new AddinAuthError('invalid_token', 'no sub');
  return { sub, oid, tid };
}

/** `oid` and `tid` from an ID token better-auth stored at sign-in; null if unreadable. */
function storedIdTokenClaims(idToken: string): { oid: string; tid: string } | null {
  try {
    const claims = decodeJwt(idToken);
    const oid = typeof claims.oid === 'string' ? claims.oid.toLowerCase() : null;
    const tid = typeof claims.tid === 'string' ? claims.tid.toLowerCase() : null;
    return oid && tid ? { oid, tid } : null;
  } catch {
    return null;
  }
}

/**
 * The better-auth user with this Entra object id, for the `id` sign-in mode.
 * better-auth keys the Microsoft account on the dashboard app's pairwise `sub`,
 * which an ID token from another app registration does not share, so the
 * match is on the `oid` and `tid` in the ID token stored at dashboard sign-in.
 * That token is not re-verified: better-auth wrote it after its own code
 * exchange with Entra, and it is only read here, never trusted as a bearer.
 * Microsoft accounts are scanned in full; fine for one municipality's users.
 */
async function userIdForObjectId(oid: string, tid: string): Promise<string> {
  const result = await pool.query<{ user_id: string; id_token: string }>(
    `SELECT user_id, id_token FROM accounts WHERE provider_id = 'microsoft' AND id_token IS NOT NULL`,
  );
  const users = new Set<string>();
  for (const row of result.rows) {
    const stored = storedIdTokenClaims(row.id_token);
    if (stored && stored.oid === oid && stored.tid === tid) users.add(row.user_id);
  }
  // Exactly one, for the same reason as by sub: never guess between two users.
  if (users.size !== 1) throw new AddinAuthError('no_account', `matched ${users.size} users by oid`);
  return [...users][0];
}

/**
 * The better-auth user behind a verified token, by its Microsoft account: by
 * `sub` for an access token from the dashboard's own app (`api`), by object id
 * for an ID token from the add-in's app (`id`).
 */
export async function userIdForClaims(claims: AddinClaims, mode: 'api' | 'id' = 'api'): Promise<string> {
  if (mode === 'id') {
    if (!claims.oid) throw new AddinAuthError('no_account', 'no object id');
    return userIdForObjectId(claims.oid, claims.tid);
  }
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

/** Throws not_allowed unless the user is on OUTLOOK_ADDIN_ALLOWED_USERS (when it is set). */
export async function assertAddinAllowed(userId: string): Promise<void> {
  const allowed = addinAllowedEmails();
  if (!allowed) return;
  const result = await pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId]);
  const email = result.rows[0]?.email?.trim().toLowerCase();
  if (!email || !allowed.has(email)) {
    throw new AddinAuthError('not_allowed', `user ${userId} is not on OUTLOOK_ADDIN_ALLOWED_USERS`);
  }
}

/**
 * The whole gate for an add-in request: the feature is on, a bearer token is
 * present and valid, it belongs to a known user, and that user is allowed.
 * Returns that user's id.
 */
export async function authenticateAddinRequest(headers: Headers): Promise<string> {
  const config = outlookAddinConfig();
  if (!config) throw new AddinAuthError('disabled');
  const token = bearerToken(headers.get('authorization'));
  if (!token) throw new AddinAuthError('missing_token');
  const claims = config.token === 'id'
    ? await verifyAddinIdToken(token, config)
    : await verifyAddinToken(token, config);
  const userId = await userIdForClaims(claims, config.token);
  await assertAddinAllowed(userId);
  return userId;
}
