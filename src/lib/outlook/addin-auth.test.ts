import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';

const mockQuery = vi.fn();
vi.mock('@/lib/db', () => ({ pool: { query: (...args: unknown[]) => mockQuery(...args) } }));

import {
  AddinAuthError,
  authenticateAddinRequest,
  bearerToken,
  userIdForClaims,
  verifyAddinToken,
} from './addin-auth';

const TENANT = '11111111-1111-1111-1111-111111111111';
const OTHER_TENANT = '99999999-9999-9999-9999-999999999999';
const CLIENT = '33333333-3333-3333-3333-333333333333';
const CONFIG = { clientId: CLIENT, tenantId: TENANT };

let privateKey: CryptoKey;
let strangerKey: CryptoKey;
let keys: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  strangerKey = (await generateKeyPair('RS256')).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' };
  keys = createLocalJWKSet({ keys: [jwk] });
});

/** A v2 token as Entra issues it to the add-in, with overrides. */
async function token(
  overrides: JWTPayload = {},
  { key = privateKey, expiresIn = '1h' }: { key?: CryptoKey; expiresIn?: string } = {},
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
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);
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
    expect(claims).toEqual({
      sub: 'pairwise-sub-1',
      oid: '22222222-2222-2222-2222-222222222222',
      tid: TENANT,
    });
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

  const refused: [string, JWTPayload][] = [
    ['issued by another tenant', { iss: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0` }],
    ['carrying another tenant id', { tid: OTHER_TENANT }],
    ['for another API (a Graph token)', { aud: '00000003-0000-0000-c000-000000000000' }],
    ['issued to another client app', { azp: '44444444-4444-4444-4444-444444444444' }],
    ['without our scope', { scp: 'User.Read' }],
    ['app-only (roles, no scp)', { scp: undefined, roles: ['access_as_user'] }],
    ['without a subject', { sub: undefined }],
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

  it('never puts the token in the user-facing message', async () => {
    const t = await token({ tid: OTHER_TENANT });
    const err = await refusal(verifyAddinToken(t, CONFIG, keys));
    expect(err.message).not.toContain(t);
    expect(err.message).toMatch(/Microsoft-login/);
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
    await expect(userIdForClaims({ sub: 'pairwise-sub-1', oid: null, tid: TENANT })).resolves.toBe('user-1');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/provider_id = 'microsoft' AND account_id = \$1/);
    expect(params).toEqual(['pairwise-sub-1']);
  });

  it('refuses someone who never signed in to the dashboard with Microsoft', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const err = await refusal(userIdForClaims({ sub: 'x', oid: null, tid: TENANT }));
    expect(err.code).toBe('no_account');
    expect(err.status).toBe(403);
  });

  it('refuses to guess when two users share an account id', async () => {
    mockQuery.mockResolvedValue({ rows: [{ user_id: 'a' }, { user_id: 'b' }] });
    expect((await refusal(userIdForClaims({ sub: 'x', oid: null, tid: TENANT }))).code).toBe('no_account');
  });
});

describe('authenticateAddinRequest', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
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
