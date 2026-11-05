import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import {
  SignJWT,
  createLocalJWKSet,
  createRemoteJWKSet,
  errors,
  exportJWK,
  generateKeyPair,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';

const mockQuery = vi.fn();
vi.mock('@/lib/db', () => ({ pool: { query: (...args: unknown[]) => mockQuery(...args) } }));

// The tenant's published key set, as authenticateAddinRequest fetches it. Swapped
// for the local test keys, so the whole production path runs without a network.
const remote = vi.hoisted(() => ({ keys: null as null | ((...args: unknown[]) => unknown) }));
vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return {
    ...actual,
    createRemoteJWKSet: vi.fn(() => (...args: unknown[]) => remote.keys!(...args)),
  };
});
let keys: JWTVerifyGetKey;

import {
  AddinAuthError,
  addinAllowedEmails,
  assertAddinAllowed,
  authenticateAddinRequest,
  bearerToken,
  userIdForClaims,
  verifyAddinIdToken,
  verifyAddinToken,
} from './addin-auth';

const TENANT = '11111111-1111-1111-1111-111111111111';
const OTHER_TENANT = '99999999-9999-9999-9999-999999999999';
const CLIENT = '33333333-3333-3333-3333-333333333333';
const OTHER_CLIENT = '55555555-5555-5555-5555-555555555555';
const CONFIG = { clientId: CLIENT, tenantId: TENANT };

let privateKey: CryptoKey;
let strangerKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  strangerKey = (await generateKeyPair('RS256')).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' };
  keys = createLocalJWKSet({ keys: [jwk] });
  remote.keys = keys as never;
});

/** A v2 token as Entra issues it to the add-in, with overrides. */
async function token(
  overrides: JWTPayload = {},
  {
    key = privateKey,
    kid = 'k1',
    expiresIn = '1h',
    notBefore,
  }: { key?: CryptoKey; kid?: string; expiresIn?: string | null; notBefore?: string } = {},
): Promise<string> {
  const payload: JWTPayload = {
    iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
    aud: CLIENT,
    tid: TENANT,
    azp: CLIENT,
    scp: 'access_as_user',
    sub: 'pairwise-sub-1',
    oid: '22222222-2222-2222-2222-222222222222',
    ...overrides,
  };
  const jwt = new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid }).setIssuedAt();
  if (expiresIn) jwt.setExpirationTime(expiresIn);
  if (notBefore) jwt.setNotBefore(notBefore);
  return jwt.sign(key);
}

async function refusal(promise: Promise<unknown>): Promise<AddinAuthError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(AddinAuthError);
    return err as AddinAuthError;
  }
  throw new Error('expected the token to be refused');
}

describe('verifyAddinToken', () => {
  it('accepts a v2 token for our API, client and tenant', async () => {
    const claims = await verifyAddinToken(await token(), CONFIG, keys);
    expect(claims).toEqual({ sub: 'pairwise-sub-1' });
  });

  it('accepts a v1 token too (registration left at its default version)', async () => {
    const v1 = await token({
      iss: `https://sts.windows.net/${TENANT}/`,
      aud: `api://${CLIENT}`,
      azp: undefined,
      appid: CLIENT,
    });
    await expect(verifyAddinToken(v1, CONFIG, keys)).resolves.toMatchObject({ sub: 'pairwise-sub-1' });
  });

  it('accepts several scopes when ours is among them', async () => {
    const t = await token({ scp: 'User.Read access_as_user' });
    await expect(verifyAddinToken(t, CONFIG, keys)).resolves.toBeDefined();
  });

  // A GUID is case-insensitive, and the issuer (checked exactly) already pins the
  // tenant; Entra writes both in lowercase. An uppercase `tid` is the same tenant.
  it('accepts our tenant id in uppercase in tid', async () => {
    const t = await token({ tid: TENANT.toUpperCase() });
    await expect(verifyAddinToken(t, CONFIG, keys)).resolves.toEqual({ sub: 'pairwise-sub-1' });
  });

  const refused: [string, JWTPayload][] = [
    ['issued by another tenant', { iss: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0` }],
    ['carrying another tenant id', { tid: OTHER_TENANT }],
    ['for another API (a Graph token)', { aud: '00000003-0000-0000-c000-000000000000' }],
    ['for another app\'s API', { aud: `api://${OTHER_CLIENT}` }],
    ['issued to another client app', { azp: '44444444-4444-4444-4444-444444444444' }],
    ['naming no client at all (neither azp nor appid)', { azp: undefined }],
    ['without our scope', { scp: 'User.Read' }],
    ['with a lookalike of our scope', { scp: 'access_as_user2' }],
    ['app-only (roles, no scp)', { scp: undefined, roles: ['access_as_user'] }],
    ['without a subject', { sub: undefined }],
    ['without a tenant id', { tid: undefined }],
    ['v1, issued by another tenant', { iss: `https://sts.windows.net/${OTHER_TENANT}/`, aud: `api://${CLIENT}`, azp: undefined, appid: CLIENT }],
    ['v1, issued to another client app', { iss: `https://sts.windows.net/${TENANT}/`, aud: `api://${CLIENT}`, azp: undefined, appid: OTHER_CLIENT }],
  ];
  it.each(refused)('refuses a token %s', async (_name, overrides) => {
    const err = await refusal(verifyAddinToken(await token(overrides), CONFIG, keys));
    expect(err.code).toBe('invalid_token');
    expect(err.status).toBe(401);
  });

  it('refuses an expired token', async () => {
    const t = await token({}, { expiresIn: '-10 minutes' });
    expect((await refusal(verifyAddinToken(t, CONFIG, keys))).code).toBe('invalid_token');
  });

  it('refuses a token without an expiry', async () => {
    const t = await token({}, { expiresIn: null });
    expect((await refusal(verifyAddinToken(t, CONFIG, keys))).code).toBe('invalid_token');
  });

  it('refuses a token that is not valid yet (beyond the clock tolerance)', async () => {
    const t = await token({}, { notBefore: '10 minutes' });
    expect((await refusal(verifyAddinToken(t, CONFIG, keys))).code).toBe('invalid_token');
  });

  it('refuses a token signed with a key id the tenant does not publish', async () => {
    const t = await token({}, { kid: 'unknown-kid' });
    const err = await refusal(verifyAddinToken(t, CONFIG, keys));
    expect(err.code).toBe('invalid_token');
    expect(err.status).toBe(401);
  });

  it('refuses a token signed with a key that is not the tenant\'s', async () => {
    const t = await token({}, { key: strangerKey });
    expect((await refusal(verifyAddinToken(t, CONFIG, keys))).code).toBe('invalid_token');
  });

  it('refuses an HS256 token, whatever it claims', async () => {
    const t = await new SignJWT({ iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, aud: CLIENT, tid: TENANT, azp: CLIENT, scp: 'access_as_user', sub: 's' })
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('a-shared-secret-of-sufficient-length!!'));
    expect((await refusal(verifyAddinToken(t, CONFIG, keys))).code).toBe('invalid_token');
  });

  it('refuses something that is not a JWT', async () => {
    expect((await refusal(verifyAddinToken('not-a-jwt', CONFIG, keys))).code).toBe('invalid_token');
  });

  // The user's login is fine then: the server could not fetch the keys to check
  // it. Telling them it failed would send them signing in again for nothing.
  const keyFailures: [string, () => Error][] = [
    ['a timeout', () => new errors.JWKSTimeout()],
    ['a non-200 answer', () => new errors.JOSEError('Expected 200 OK from the JSON Web Key Set HTTP response')],
    ['a malformed key set', () => new errors.JWKSInvalid('JSON Web Key Set malformed')],
    ['a network error', () => new TypeError('fetch failed')],
  ];
  it.each(keyFailures)('says the check is unavailable, not the login invalid, on %s fetching keys', async (_name, failure) => {
    const failing: JWTVerifyGetKey = async () => {
      throw failure();
    };
    const err = await refusal(verifyAddinToken(await token(), CONFIG, failing));
    expect(err.code).toBe('unavailable');
    expect(err.status).toBe(503);
    expect(err.message).toMatch(/Prøv igen/);
  });

  it('never puts the token in the user-facing message', async () => {
    const t = await token({ tid: OTHER_TENANT });
    const err = await refusal(verifyAddinToken(t, CONFIG, keys));
    expect(err.message).not.toContain(t);
    expect(err.message).toMatch(/Microsoft-login/);
  });
});

describe('verifyAddinIdToken (OUTLOOK_ADDIN_CLIENT_ID)', () => {
  const ADDIN_CLIENT = 'dbdbdbdb-5555-4444-a121-fb0d3041449e';
  const ID_CONFIG = { clientId: ADDIN_CLIENT, tenantId: TENANT };
  const OID = '22222222-2222-2222-2222-222222222222';

  /** A v2 ID token as Entra issues it to the add-in's own app. */
  function idToken(overrides: JWTPayload = {}, opts?: { key?: CryptoKey; expiresIn?: string }) {
    return token({
      aud: ADDIN_CLIENT,
      azp: undefined,
      scp: undefined,
      sub: 'pairwise-sub-of-the-addin-app',
      oid: OID.toUpperCase(),
      preferred_username: 'someone@example.dk',
      ...overrides,
    }, opts);
  }

  it('accepts an ID token for the add-in app from our tenant, and lowercases the oid', async () => {
    await expect(verifyAddinIdToken(await idToken(), ID_CONFIG, keys)).resolves.toEqual({
      sub: 'pairwise-sub-of-the-addin-app',
      oid: OID,
      tid: TENANT,
    });
  });

  const refused: [string, JWTPayload][] = [
    ['issued by another tenant', { iss: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0` }],
    ['from the v1 endpoint', { iss: `https://sts.windows.net/${TENANT}/` }],
    ['carrying another tenant id', { tid: OTHER_TENANT }],
    ['for the dashboard app instead', { aud: CLIENT }],
    ['for our API (an access token)', { aud: `api://${ADDIN_CLIENT}` }],
    ['with scopes (an access token)', { scp: 'User.Read' }],
    ['with roles (app-only)', { roles: ['x'] }],
    ['marked app-only', { idtyp: 'app' }],
    ['without an object id', { oid: undefined }],
    ['with an object id that is not a GUID', { oid: 'someone' }],
    ['without a subject', { sub: undefined }],
  ];
  it.each(refused)('refuses a token %s', async (_name, overrides) => {
    const err = await refusal(verifyAddinIdToken(await idToken(overrides), ID_CONFIG, keys));
    expect(err.code).toBe('invalid_token');
  });

  it('refuses an expired one, and one not signed by the tenant', async () => {
    expect((await refusal(verifyAddinIdToken(await idToken({}, { expiresIn: '-10 minutes' }), ID_CONFIG, keys))).code)
      .toBe('invalid_token');
    expect((await refusal(verifyAddinIdToken(await idToken({}, { key: strangerKey }), ID_CONFIG, keys))).code)
      .toBe('invalid_token');
  });
});

describe('bearerToken', () => {
  it('reads a bearer token', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(bearerToken('  Bearer   abc.def.ghi ')).toBe('abc.def.ghi');
  });
  it('ignores anything else', () => {
    expect(bearerToken(null)).toBeNull();
    expect(bearerToken('Basic dXNlcjpwdw==')).toBeNull();
    expect(bearerToken('Bearer ')).toBeNull();
    expect(bearerToken('Bearer a b')).toBeNull();
  });
});

describe('userIdForClaims', () => {
  beforeEach(() => mockQuery.mockReset());

  it('finds the user by the Microsoft account id (sub)', async () => {
    mockQuery.mockResolvedValue({ rows: [{ user_id: 'user-1' }] });
    await expect(userIdForClaims({ sub: 'pairwise-sub-1' })).resolves.toBe('user-1');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/provider_id = 'microsoft' AND account_id = \$1/);
    expect(params).toEqual(['pairwise-sub-1']);
  });

  it('refuses someone who never signed in to the dashboard with Microsoft', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const err = await refusal(userIdForClaims({ sub: 'x' }));
    expect(err.code).toBe('no_account');
    expect(err.status).toBe(403);
  });

  it('refuses to guess when two users share an account id', async () => {
    mockQuery.mockResolvedValue({ rows: [{ user_id: 'a' }, { user_id: 'b' }] });
    expect((await refusal(userIdForClaims({ sub: 'x' }))).code).toBe('no_account');
  });
});

describe('userIdForClaims in id mode (by object id)', () => {
  const OID = '22222222-2222-2222-2222-222222222222';
  /** An ID token as better-auth stored it at dashboard sign-in; unsigned is fine, it is only read. */
  const stored = (claims: Record<string, unknown>) =>
    `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
  const claims = { sub: 'pairwise-sub-of-the-addin-app', oid: OID, tid: TENANT };

  beforeEach(() => mockQuery.mockReset());

  it('finds the user whose stored dashboard ID token has the same oid and tenant', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { user_id: 'user-other', id_token: stored({ oid: '77777777-7777-7777-7777-777777777777', tid: TENANT }) },
        { user_id: 'user-1', id_token: stored({ sub: 'dashboard-sub', oid: OID.toUpperCase(), tid: TENANT.toUpperCase() }) },
        { user_id: 'user-junk', id_token: 'not-a-jwt' },
      ],
    });
    await expect(userIdForClaims(claims, 'id')).resolves.toBe('user-1');
    expect(mockQuery.mock.calls[0][0]).toMatch(/provider_id = 'microsoft' AND id_token IS NOT NULL/);
  });

  it('does not match the same oid in another tenant', async () => {
    mockQuery.mockResolvedValue({ rows: [{ user_id: 'user-1', id_token: stored({ oid: OID, tid: OTHER_TENANT }) }] });
    expect((await refusal(userIdForClaims(claims, 'id'))).code).toBe('no_account');
  });

  it('refuses when nobody matches, and when two users do', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    expect((await refusal(userIdForClaims(claims, 'id'))).code).toBe('no_account');

    mockQuery.mockResolvedValue({
      rows: [
        { user_id: 'a', id_token: stored({ oid: OID, tid: TENANT }) },
        { user_id: 'b', id_token: stored({ oid: OID, tid: TENANT }) },
      ],
    });
    expect((await refusal(userIdForClaims(claims, 'id'))).code).toBe('no_account');
  });

  it('accepts one user with two account rows for the same oid', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { user_id: 'user-1', id_token: stored({ oid: OID, tid: TENANT }) },
        { user_id: 'user-1', id_token: stored({ oid: OID, tid: TENANT }) },
      ],
    });
    await expect(userIdForClaims(claims, 'id')).resolves.toBe('user-1');
  });

  it('never matches without an oid', async () => {
    expect((await refusal(userIdForClaims({ ...claims, oid: undefined }, 'id'))).code).toBe('no_account');
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('OUTLOOK_ADDIN_ALLOWED_USERS', () => {
  const saved = process.env.OUTLOOK_ADDIN_ALLOWED_USERS;
  beforeEach(() => mockQuery.mockReset());
  afterEach(() => {
    if (saved === undefined) delete process.env.OUTLOOK_ADDIN_ALLOWED_USERS;
    else process.env.OUTLOOK_ADDIN_ALLOWED_USERS = saved;
  });

  it('lets everyone in while unset or blank, without a query', async () => {
    for (const value of [undefined, '', '   ']) {
      if (value === undefined) delete process.env.OUTLOOK_ADDIN_ALLOWED_USERS;
      else process.env.OUTLOOK_ADDIN_ALLOWED_USERS = value;
      expect(addinAllowedEmails()).toBeNull();
      await expect(assertAddinAllowed('user-1')).resolves.toBeUndefined();
    }
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('lets a listed user in, whatever the case or spacing', async () => {
    process.env.OUTLOOK_ADDIN_ALLOWED_USERS = ' Someone@Example.dk , other@example.dk';
    mockQuery.mockResolvedValue({ rows: [{ email: 'someone@example.DK' }] });
    await expect(assertAddinAllowed('user-1')).resolves.toBeUndefined();
    expect(mockQuery.mock.calls[0][1]).toEqual(['user-1']);
  });

  it('refuses anyone else, and fails closed on a list with no addresses', async () => {
    process.env.OUTLOOK_ADDIN_ALLOWED_USERS = 'someone@example.dk';
    mockQuery.mockResolvedValue({ rows: [{ email: 'colleague@example.dk' }] });
    const err = await refusal(assertAddinAllowed('user-2'));
    expect(err.code).toBe('not_allowed');
    expect(err.status).toBe(403);

    mockQuery.mockResolvedValue({ rows: [] });
    expect((await refusal(assertAddinAllowed('ghost'))).code).toBe('not_allowed');

    process.env.OUTLOOK_ADDIN_ALLOWED_USERS = ' , ';
    mockQuery.mockResolvedValue({ rows: [{ email: 'someone@example.dk' }] });
    expect((await refusal(assertAddinAllowed('user-1'))).code).toBe('not_allowed');
  });
});

describe('authenticateAddinRequest', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    remote.keys = keys as never;
  });

  function enable(addinClient?: string) {
    process.env.OUTLOOK_ADDIN_ENABLED = 'true';
    process.env.TEAMS_GRAPH_ENABLED = 'true';
    process.env.MICROSOFT_CLIENT_ID = CLIENT;
    process.env.MICROSOFT_CLIENT_SECRET = 'secret';
    process.env.MICROSOFT_TENANT_ID = TENANT;
    delete process.env.MICROSOFT_ENABLED;
    delete process.env.OUTLOOK_ADDIN_ALLOWED_USERS;
    if (addinClient) process.env.OUTLOOK_ADDIN_CLIENT_ID = addinClient;
    else delete process.env.OUTLOOK_ADDIN_CLIENT_ID;
  }

  it('verifies the token against the tenant\'s keys and finds its user', async () => {
    enable();
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [{ user_id: 'user-1' }] });

    const userId = await authenticateAddinRequest(new Headers({ authorization: `Bearer ${await token()}` }));

    expect(userId).toBe('user-1');
    expect(mockQuery.mock.calls[0][1]).toEqual(['pairwise-sub-1']);
    expect(vi.mocked(createRemoteJWKSet)).toHaveBeenCalledWith(
      new URL(`https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`),
    );
  });

  it('refuses a token from another tenant before looking anyone up', async () => {
    enable();
    mockQuery.mockReset();
    const t = await token({ tid: OTHER_TENANT });
    const err = await refusal(authenticateAddinRequest(new Headers({ authorization: `Bearer ${t}` })));
    expect(err.code).toBe('invalid_token');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('is unavailable, not a failed login, when the tenant\'s keys cannot be fetched', async () => {
    enable();
    remote.keys = async () => {
      throw new errors.JWKSTimeout();
    };
    const err = await refusal(authenticateAddinRequest(new Headers({ authorization: `Bearer ${await token()}` })));
    expect(err.code).toBe('unavailable');
    expect(err.status).toBe(503);
  });

  it('is disabled while Microsoft sign-in is switched off', async () => {
    enable();
    process.env.MICROSOFT_ENABLED = 'false';
    const err = await refusal(authenticateAddinRequest(new Headers({ authorization: 'Bearer a.b.c' })));
    expect(err.code).toBe('disabled');
  });

  it('is disabled when the client id is not a GUID', async () => {
    enable();
    process.env.MICROSOFT_CLIENT_ID = 'my-app';
    const err = await refusal(authenticateAddinRequest(new Headers({ authorization: 'Bearer a.b.c' })));
    expect(err.code).toBe('disabled');
  });

  it('is disabled unless OUTLOOK_ADDIN_ENABLED is exactly true', async () => {
    process.env.TEAMS_GRAPH_ENABLED = 'true';
    process.env.MICROSOFT_CLIENT_ID = CLIENT;
    process.env.MICROSOFT_CLIENT_SECRET = 'secret';
    process.env.MICROSOFT_TENANT_ID = TENANT;
    for (const value of [undefined, '', '1', 'yes']) {
      if (value === undefined) delete process.env.OUTLOOK_ADDIN_ENABLED;
      else process.env.OUTLOOK_ADDIN_ENABLED = value;
      const err = await refusal(authenticateAddinRequest(new Headers({ authorization: 'Bearer a.b.c' })));
      expect(err.code).toBe('disabled');
    }
  });

  it('is disabled when the tenant is not pinned to one tenant id', async () => {
    process.env.OUTLOOK_ADDIN_ENABLED = 'true';
    process.env.TEAMS_GRAPH_ENABLED = 'true';
    process.env.MICROSOFT_CLIENT_ID = CLIENT;
    process.env.MICROSOFT_CLIENT_SECRET = 'secret';
    process.env.MICROSOFT_TENANT_ID = 'organizations';
    const err = await refusal(authenticateAddinRequest(new Headers({ authorization: 'Bearer a.b.c' })));
    expect(err.code).toBe('disabled');
  });

  it('is disabled while the Graph integration is off', async () => {
    process.env.OUTLOOK_ADDIN_ENABLED = 'true';
    process.env.TEAMS_GRAPH_ENABLED = 'false';
    process.env.MICROSOFT_CLIENT_ID = CLIENT;
    process.env.MICROSOFT_CLIENT_SECRET = 'secret';
    process.env.MICROSOFT_TENANT_ID = TENANT;
    const err = await refusal(authenticateAddinRequest(new Headers({ authorization: 'Bearer a.b.c' })));
    expect(err.code).toBe('disabled');
  });

  const bearer = (t: string) => new Headers({ authorization: `Bearer ${t}` });

  it('end to end, id mode: the add-in app\'s ID token finds the user by oid, and an API token is refused', async () => {
    const addinClient = 'dbdbdbdb-5555-4444-a121-fb0d3041449e';
    const oid = '22222222-2222-2222-2222-222222222222';
    enable(addinClient);
    remote.keys = keys as never;
    const storedPayload = Buffer.from(JSON.stringify({ oid, tid: TENANT })).toString('base64url');
    mockQuery.mockReset().mockResolvedValue({ rows: [{ user_id: 'user-1', id_token: `e30.${storedPayload}.sig` }] });

    const id = await token({ aud: addinClient, azp: undefined, scp: undefined, sub: 'addin-sub', oid });
    await expect(authenticateAddinRequest(bearer(id))).resolves.toBe('user-1');

    // The api-mode token no longer gets in once the add-in has its own app.
    expect((await refusal(authenticateAddinRequest(bearer(await token())))).code).toBe('invalid_token');
  });

  it('asks for a token when none is sent', async () => {
    process.env.OUTLOOK_ADDIN_ENABLED = 'true';
    process.env.TEAMS_GRAPH_ENABLED = 'true';
    process.env.MICROSOFT_CLIENT_ID = CLIENT;
    process.env.MICROSOFT_CLIENT_SECRET = 'secret';
    process.env.MICROSOFT_TENANT_ID = TENANT;
    const err = await refusal(authenticateAddinRequest(new Headers()));
    expect(err.code).toBe('missing_token');
  });
});
