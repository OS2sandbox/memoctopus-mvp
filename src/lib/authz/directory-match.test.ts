import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeRunner } from '@/test/fake-runner';

vi.mock('@/lib/db', () => ({ pool: {} }));
const recordEvent = vi.fn(async () => {});
vi.mock('@/lib/audit/record', () => ({ recordEvent: (...a: unknown[]) => recordEvent(...(a as [])) }));

import { matchDirectoryUser } from './directory-match';
import type { ExternalIdentity } from './identity';

const EXT_UUID = '11111111-2222-4333-8444-555555555555';
const D1 = { uuid: 'd1', app_user_id: null };

const identity = (over: Partial<ExternalIdentity> & { claims?: ExternalIdentity['claims'] } = {}): ExternalIdentity => ({
  userId: 'u1',
  providerId: 'oidc',
  subject: 's',
  claims: { sub: 's', preferred_username: 'ABC123', email: 'a@example.dk', email_verified: true },
  ...over,
});

/** Responder: candidates for the SELECT ... FOR UPDATE, `own` for "is this user linked already". */
function db(candidates: Array<Record<string, unknown>>, own: Array<Record<string, unknown>> = [], updated = [{ uuid: 'd1' }]) {
  return makeFakeRunner((sql) => {
    if (sql.includes('FOR UPDATE')) return candidates;
    if (sql.includes('WHERE app_user_id = $1')) return own;
    if (sql.startsWith('UPDATE')) return updated;
  });
}

beforeEach(() => {
  vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
  vi.stubEnv('DIRECTORY_USERID_CLAIM', '');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  recordEvent.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('local mode', () => {
  it('is a no-op and touches no SQL', async () => {
    vi.stubEnv('ACCESS_SOURCE', 'local');
    const { runner, calls } = db([D1]);
    expect(await matchDirectoryUser(identity(), 'userid-claim', runner)).toEqual({ status: 'skipped' });
    expect(calls).toHaveLength(0);
  });
});

describe('userid-claim', () => {
  it('matches ext_user_id case-insensitively on the configured claim and links', async () => {
    const { runner, calls } = db([D1]);
    const res = await matchDirectoryUser(identity(), 'userid-claim', runner);
    expect(res).toEqual({ status: 'linked', directoryUserUuid: 'd1' });
    const select = calls.find((c) => c.sql.includes('FOR UPDATE'))!;
    expect(select.sql).toContain('lower(ext_user_id) = lower($1)');
    expect(select.sql).toContain("source = 'rollekatalog'");
    expect(select.sql).toContain('disabled = false');
    expect(select.params).toEqual(['ABC123']);
    expect(calls.map((c) => c.sql)[0]).toBe('BEGIN');
    expect(calls.at(-1)!.sql).toBe('COMMIT');
    expect(recordEvent).toHaveBeenCalledOnce();
  });

  it('uses DIRECTORY_USERID_CLAIM', async () => {
    vi.stubEnv('DIRECTORY_USERID_CLAIM', 'upn');
    const { runner, calls } = db([D1]);
    await matchDirectoryUser(identity({ claims: { sub: 's', upn: 'x@corp.dk' } }), 'userid-claim', runner);
    expect(calls.find((c) => c.sql.includes('FOR UPDATE'))!.params).toEqual(['x@corp.dk']);
  });

  it('strips the UPN domain before comparing when DIRECTORY_USERID_TRANSFORM=strip-upn-domain', async () => {
    vi.stubEnv('DIRECTORY_USERID_TRANSFORM', 'strip-upn-domain');
    vi.stubEnv('DIRECTORY_USERID_CLAIM', 'upn');
    const { runner, calls } = db([D1]);
    const res = await matchDirectoryUser(identity({ claims: { sub: 's', upn: 'ABC123@kommune.dk' } }), 'userid-claim', runner);
    expect(res.status).toBe('linked');
    const select = calls.find((c) => c.sql.includes('FOR UPDATE'))!;
    expect(select.params).toEqual(['ABC123']);
    expect(select.sql).toContain('lower(ext_user_id) = lower($1)');
  });

  it('leaves the claim untouched without the transform (a UPN then simply does not match)', async () => {
    vi.stubEnv('DIRECTORY_USERID_CLAIM', 'upn');
    const { runner, calls } = db([]);
    await matchDirectoryUser(identity({ claims: { sub: 's', upn: 'ABC123@kommune.dk' } }), 'userid-claim', runner);
    expect(calls.find((c) => c.sql.includes('FOR UPDATE'))!.params).toEqual(['ABC123@kommune.dk']);
  });

  it('matches a leading-@ value verbatim (nothing to strip), so it cannot collapse to an empty id', async () => {
    vi.stubEnv('DIRECTORY_USERID_TRANSFORM', 'strip-upn-domain');
    const { runner, calls } = db([]);
    const res = await matchDirectoryUser(identity({ claims: { sub: 's', preferred_username: '@kommune.dk' } }), 'userid-claim', runner);
    expect(calls.find((c) => c.sql.includes('FOR UPDATE'))!.params).toEqual(['@kommune.dk']);
    expect(res.status).toBe('no_match');
  });

  it('does not apply the transform to extuuid or email matching', async () => {
    vi.stubEnv('DIRECTORY_USERID_TRANSFORM', 'strip-upn-domain');
    const { runner, calls } = db([D1]);
    await matchDirectoryUser(identity(), 'email', runner);
    expect(calls.find((c) => c.sql.includes('FOR UPDATE'))!.params).toEqual(['a@example.dk']);
  });

  it('is no_match without querying when the claim is absent', async () => {
    const { runner, calls } = db([D1]);
    const res = await matchDirectoryUser(identity({ claims: { sub: 's' } }), 'userid-claim', runner);
    expect(res.status).toBe('no_match');
    expect(calls).toHaveLength(0);
  });

  it('refuses to guess on ambiguity', async () => {
    const { runner, calls } = db([D1, { uuid: 'd2', app_user_id: null }]);
    expect((await matchDirectoryUser(identity(), 'userid-claim', runner)).status).toBe('ambiguous');
    expect(calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false);
  });

  it('returns no_match when nothing is found', async () => {
    expect((await matchDirectoryUser(identity(), 'userid-claim', db([]).runner)).status).toBe('no_match');
  });
});

describe('extuuid-claim', () => {
  it('matches ext_uuid with a uuid-shaped claim', async () => {
    const { runner, calls } = db([D1]);
    const res = await matchDirectoryUser(identity({ claims: { sub: 's', preferred_username: EXT_UUID } }), 'extuuid-claim', runner);
    expect(res.status).toBe('linked');
    expect(calls.find((c) => c.sql.includes('FOR UPDATE'))!.sql).toContain('ext_uuid = $1::uuid');
  });

  it('does not query with a non-uuid claim value', async () => {
    const { runner, calls } = db([D1]);
    const res = await matchDirectoryUser(identity(), 'extuuid-claim', runner);
    expect(res.status).toBe('no_match');
    expect(calls).toHaveLength(0);
  });
});

describe('email', () => {
  it('matches a verified email', async () => {
    const { runner, calls } = db([D1]);
    expect((await matchDirectoryUser(identity(), 'email', runner)).status).toBe('linked');
    expect(calls.find((c) => c.sql.includes('FOR UPDATE'))!.sql).toContain('lower(email) = lower($1)');
  });

  it.each([{ email_verified: false }, { email_verified: undefined }])('refuses an unverified email %j', async (v) => {
    const { runner, calls } = db([D1]);
    const res = await matchDirectoryUser(identity({ claims: { sub: 's', email: 'a@example.dk', ...v } }), 'email', runner);
    expect(res.status).toBe('refused');
    expect(calls).toHaveLength(0);
  });
});

describe('Microsoft logins need a pinned single tenant and a matching tid (all modes, all transforms)', () => {
  const TID = '99999999-8888-4777-8666-555555555555';
  const OTHER = '00000000-0000-4000-8000-000000000000';
  const claimsFor = (mode: 'userid-claim' | 'extuuid-claim' | 'email', tid?: string) => ({
    sub: 's',
    preferred_username: mode === 'extuuid-claim' ? EXT_UUID : 'ABC123',
    email: 'a@example.dk',
    email_verified: true,
    ...(tid !== undefined ? { tid } : {}),
  });
  const ms = (mode: 'userid-claim' | 'extuuid-claim' | 'email', tid?: string) =>
    identity({ providerId: 'microsoft', claims: claimsFor(mode, tid) });

  const tenants: Array<[string, string, boolean]> = [
    ['unset', '', false],
    ['blank', '   ', false],
    ['common', 'common', false],
    ['organizations', 'ORGANIZATIONS', false],
    ['consumers', 'consumers', false],
    ['pinned', TID, true],
    ['pinned (upper case)', TID.toUpperCase(), true],
  ];
  const tids: Array<[string, string | undefined, boolean]> = [
    ['missing', undefined, false],
    ['different', OTHER, false],
    ['matching', TID, true],
    ['matching (upper case)', TID.toUpperCase(), true],
  ];

  for (const mode of ['userid-claim', 'extuuid-claim', 'email'] as const) {
    for (const transform of ['', 'none', 'strip-upn-domain']) {
      describe(`${mode} / transform "${transform || 'unset'}"`, () => {
        for (const [tName, tenant, tenantOk] of tenants) {
          for (const [idName, tid, tidOk] of tids) {
            const links = tenantOk && tidOk;
            it(`tenant ${tName} x tid ${idName} => ${links ? 'links' : 'refused, no SQL'}`, async () => {
              vi.stubEnv('MICROSOFT_TENANT_ID', tenant);
              vi.stubEnv('DIRECTORY_USERID_TRANSFORM', transform);
              const { runner, calls } = db([D1]);
              const res = await matchDirectoryUser(ms(mode, tid), mode, runner);
              if (links) {
                expect(res.status).toBe('linked');
              } else {
                expect(res).toEqual({ status: 'refused' });
                expect(calls).toHaveLength(0);
              }
            });
          }
        }
      });
    }
  }

  it('strip-upn-domain still strips the domain once the tenant is proven', async () => {
    vi.stubEnv('MICROSOFT_TENANT_ID', TID);
    vi.stubEnv('DIRECTORY_USERID_TRANSFORM', 'strip-upn-domain');
    const { runner, calls } = db([D1]);
    const id = identity({ providerId: 'microsoft', claims: { sub: 's', preferred_username: 'alice@kommune.dk', tid: TID } });
    expect((await matchDirectoryUser(id, 'userid-claim', runner)).status).toBe('linked');
    expect(calls.find((c) => c.sql.includes('FOR UPDATE'))!.params).toEqual(['alice']);
  });

  it('does not restrict generic OIDC logins (any tenant setting, any tid)', async () => {
    for (const mode of ['userid-claim', 'extuuid-claim', 'email'] as const) {
      vi.stubEnv('MICROSOFT_TENANT_ID', '');
      const { runner } = db([D1]);
      const id = identity({ providerId: 'oidc', claims: claimsFor(mode, OTHER) });
      expect((await matchDirectoryUser(id, mode, runner)).status).toBe('linked');
    }
  });

  it('still refuses the credential provider, whatever the tenant', async () => {
    vi.stubEnv('MICROSOFT_TENANT_ID', TID);
    const { runner, calls } = db([D1]);
    const id = identity({ providerId: 'credential', claims: claimsFor('userid-claim', TID) });
    expect((await matchDirectoryUser(id, 'userid-claim', runner)).status).toBe('refused');
    expect(calls).toHaveLength(0);
  });

  it('keeps ambiguity => ambiguous for a proven tenant', async () => {
    vi.stubEnv('MICROSOFT_TENANT_ID', TID);
    const { runner } = db([D1, { uuid: 'd2', app_user_id: null }]);
    expect((await matchDirectoryUser(ms('userid-claim', TID), 'userid-claim', runner)).status).toBe('ambiguous');
  });

  it('warns ONCE per process when the tenant is not pinned, with a reason code and no claim values', async () => {
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ pool: {} }));
    vi.doMock('@/lib/audit/record', () => ({ recordEvent: async () => {} }));
    const fresh = await import('./directory-match');
    vi.stubEnv('MICROSOFT_TENANT_ID', 'common');
    const warn = console.warn as unknown as ReturnType<typeof vi.fn>;
    warn.mockClear();
    const id = identity({ providerId: 'microsoft', userId: 'user-secret-id', claims: { sub: 'sub-secret', preferred_username: 'ABC123@secret.example', tid: TID } });
    for (let i = 0; i < 3; i++) {
      expect((await fresh.matchDirectoryUser(id, 'userid-claim', db([D1]).runner)).status).toBe('refused');
    }
    expect(warn).toHaveBeenCalledOnce();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('microsoft_tenant_not_pinned');
    for (const secret of ['user-secret-id', 'sub-secret', 'ABC123', 'secret.example', TID]) expect(logged).not.toContain(secret);
    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/audit/record');
  });

  it('does not warn in local mode or for a pinned-tenant mismatch', async () => {
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ pool: {} }));
    vi.doMock('@/lib/audit/record', () => ({ recordEvent: async () => {} }));
    const fresh = await import('./directory-match');
    const warn = console.warn as unknown as ReturnType<typeof vi.fn>;
    warn.mockClear();
    vi.stubEnv('ACCESS_SOURCE', 'local');
    await fresh.matchDirectoryUser(ms('userid-claim', TID), 'userid-claim', db([D1]).runner);
    vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
    vi.stubEnv('MICROSOFT_TENANT_ID', TID);
    await fresh.matchDirectoryUser(ms('userid-claim', OTHER), 'userid-claim', db([D1]).runner);
    expect(warn).not.toHaveBeenCalled();
    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/audit/record');
  });
});

describe('credential provider', () => {
  it.each(['userid-claim', 'extuuid-claim', 'email'] as const)('is refused in %s mode', async (mode) => {
    const { runner, calls } = db([D1]);
    const res = await matchDirectoryUser(identity({ providerId: 'credential' }), mode, runner);
    expect(res.status).toBe('refused');
    expect(calls).toHaveLength(0);
  });
});

describe('links', () => {
  it('is idempotent when already linked to this user', async () => {
    const { runner, calls } = db([{ uuid: 'd1', app_user_id: 'u1' }]);
    expect((await matchDirectoryUser(identity(), 'userid-claim', runner)).status).toBe('already_linked');
    expect(calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('never relinks a directory entry that points at a different app user', async () => {
    const { runner, calls } = db([{ uuid: 'd1', app_user_id: 'someone-else' }]);
    expect((await matchDirectoryUser(identity(), 'userid-claim', runner)).status).toBe('conflict');
    expect(calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('does not move a user already linked to another directory entry', async () => {
    const { runner, calls } = db([D1], [{ uuid: 'other' }]);
    expect((await matchDirectoryUser(identity(), 'userid-claim', runner)).status).toBe('conflict');
    expect(calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false);
  });

  it('guards the update itself against a concurrent link', async () => {
    const { runner, calls } = db([D1], [], []);
    expect((await matchDirectoryUser(identity(), 'userid-claim', runner)).status).toBe('conflict');
    expect(calls.find((c) => c.sql.startsWith('UPDATE'))!.sql).toContain('app_user_id IS NULL OR app_user_id = $1');
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('maps a unique violation to conflict and logs a code only', async () => {
    const { runner } = makeFakeRunner((sql) => {
      if (sql.includes('FOR UPDATE')) return [D1];
      if (sql.startsWith('UPDATE')) throw Object.assign(new Error('dup key ABC123'), { code: '23505' });
      return [];
    });
    expect((await matchDirectoryUser(identity(), 'userid-claim', runner)).status).toBe('conflict');
    const logged = JSON.stringify((console.warn as any).mock.calls);
    expect(logged).not.toContain('ABC123');
    expect(logged).not.toContain('u1');
  });

  it('propagates other database errors to the caller', async () => {
    const { runner } = makeFakeRunner(() => {
      throw new Error('boom');
    });
    await expect(matchDirectoryUser(identity(), 'userid-claim', runner)).rejects.toThrow('boom');
  });
});

describe('mode-switch relink (local row -> rollekatalog row)', () => {
  const OLD_LOCAL = { uuid: 'old-local', source: 'local' };

  it('moves the link in ONE transaction: release the local row first, then link the Rollekatalog row, then audit', async () => {
    const { runner, calls } = db([D1], [OLD_LOCAL]);
    const res = await matchDirectoryUser(identity(), 'userid-claim', runner);
    expect(res).toEqual({ status: 'linked', directoryUserUuid: 'd1' });

    const sqls = calls.map((c) => c.sql);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls.at(-1)).toBe('COMMIT');
    expect(calls.every((c) => c.tx)).toBe(true);
    const release = calls.findIndex((c) => c.sql.includes('SET app_user_id = NULL'));
    const link = calls.findIndex((c) => c.sql.includes('SET app_user_id = $1'));
    expect(release).toBeGreaterThan(-1);
    expect(link).toBeGreaterThan(release);
    expect(calls[release]!.params).toEqual(['old-local', 'u1']);
    expect(calls[release]!.sql).toContain("source = 'local'");
    expect(calls[link]!.params).toEqual(['u1', 'd1']);
    expect(recordEvent).toHaveBeenCalledOnce();
    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'access.user_link',
      actorUserId: 'u1',
      entityType: 'directory_user',
      entityId: 'd1',
      details: { via: 'userid-claim', automatic: true },
    }), { tx: expect.anything() });
  });

  it('does not relink when the existing link is to an ENABLED rollekatalog row', async () => {
    const { runner, calls } = db([D1], [{ uuid: 'other-rk', source: 'rollekatalog', disabled: false }]);
    expect((await matchDirectoryUser(identity(), 'userid-claim', runner)).status).toBe('conflict');
    expect(calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('never steals a target that belongs to a DIFFERENT app user, even when the own link is local', async () => {
    const { runner, calls } = db([{ uuid: 'd1', app_user_id: 'someone-else' }], [OLD_LOCAL]);
    expect((await matchDirectoryUser(identity(), 'userid-claim', runner)).status).toBe('conflict');
    expect(calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('is a conflict (and links nothing) when the release finds the row already moved by a concurrent login', async () => {
    const { runner, calls } = makeFakeRunner((sql) => {
      if (sql.includes('FOR UPDATE')) return [D1];
      if (sql.includes('WHERE app_user_id = $1')) return [OLD_LOCAL];
      if (sql.includes('SET app_user_id = NULL')) return [];
      return [{ uuid: 'd1' }];
    });
    expect((await matchDirectoryUser(identity(), 'userid-claim', runner)).status).toBe('conflict');
    expect(calls.some((c) => c.sql.includes('SET app_user_id = $1'))).toBe(false);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('rolls everything back (release included) when the link hits the unique index', async () => {
    const { runner, calls } = makeFakeRunner((sql) => {
      if (sql.includes('FOR UPDATE')) return [D1];
      if (sql.includes('WHERE app_user_id = $1')) return [OLD_LOCAL];
      if (sql.includes('SET app_user_id = NULL')) return [{ uuid: 'old-local' }];
      if (sql.includes('SET app_user_id = $1')) throw Object.assign(new Error('dup'), { code: '23505' });
      return [];
    });
    expect((await matchDirectoryUser(identity(), 'userid-claim', runner)).status).toBe('conflict');
    expect(calls.at(-1)!.sql).toBe('ROLLBACK');
    expect(calls.some((c) => c.sql === 'COMMIT')).toBe(false);
  });

  it('still refuses the credential provider even when a relink would be possible', async () => {
    const { runner, calls } = db([D1], [OLD_LOCAL]);
    expect((await matchDirectoryUser(identity({ providerId: 'credential' }), 'userid-claim', runner)).status).toBe('refused');
    expect(calls).toHaveLength(0);
  });

  it('still refuses on ambiguity without releasing the local link', async () => {
    const { runner, calls } = db([D1, { uuid: 'd2', app_user_id: null }], [OLD_LOCAL]);
    expect((await matchDirectoryUser(identity(), 'userid-claim', runner)).status).toBe('ambiguous');
    expect(calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false);
  });
});

describe('person re-created in Rollekatalog (stale link to a disabled rollekatalog row)', () => {
  const OLD_RK_DISABLED = { uuid: 'old-rk', source: 'rollekatalog', disabled: true };

  it('releases the disabled row and links the new one in ONE transaction, then audits', async () => {
    const { runner, calls } = db([D1], [OLD_RK_DISABLED]);
    const res = await matchDirectoryUser(identity(), 'userid-claim', runner);
    expect(res).toEqual({ status: 'linked', directoryUserUuid: 'd1' });

    const sqls = calls.map((c) => c.sql);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls.at(-1)).toBe('COMMIT');
    expect(calls.every((c) => c.tx)).toBe(true);
    const release = calls.findIndex((c) => c.sql.includes('SET app_user_id = NULL'));
    const link = calls.findIndex((c) => c.sql.includes('SET app_user_id = $1'));
    expect(release).toBeGreaterThan(-1);
    expect(link).toBeGreaterThan(release);
    expect(calls[release]!.params).toEqual(['old-rk', 'u1']);
    // The release is guarded on the row lock: still ours and still disabled.
    expect(calls[release]!.sql).toContain('app_user_id = $2');
    expect(calls[release]!.sql).toContain("source = 'rollekatalog' AND disabled = true");
    expect(calls[link]!.params).toEqual(['u1', 'd1']);
    expect(recordEvent).toHaveBeenCalledOnce();
    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'access.user_link',
      entityId: 'd1',
      details: { via: 'userid-claim', automatic: true },
    }), { tx: expect.anything() });
  });

  it('is a conflict when the old row is still enabled (nothing is released)', async () => {
    const { runner, calls } = db([D1], [{ ...OLD_RK_DISABLED, disabled: false }]);
    expect((await matchDirectoryUser(identity(), 'userid-claim', runner)).status).toBe('conflict');
    expect(calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('never steals a target linked to a DIFFERENT app user', async () => {
    const { runner, calls } = db([{ uuid: 'd1', app_user_id: 'someone-else' }], [OLD_RK_DISABLED]);
    expect((await matchDirectoryUser(identity(), 'userid-claim', runner)).status).toBe('conflict');
    expect(calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('is a conflict when the guarded release finds the row re-enabled or moved meanwhile', async () => {
    const { runner, calls } = makeFakeRunner((sql) => {
      if (sql.includes('FOR UPDATE')) return [D1];
      if (sql.includes('WHERE app_user_id = $1')) return [OLD_RK_DISABLED];
      if (sql.includes('SET app_user_id = NULL')) return [];
      return [{ uuid: 'd1' }];
    });
    expect((await matchDirectoryUser(identity(), 'userid-claim', runner)).status).toBe('conflict');
    expect(calls.some((c) => c.sql.includes('SET app_user_id = $1'))).toBe(false);
    expect(recordEvent).not.toHaveBeenCalled();
  });
});

describe('matchDirectoryUser with an invalid ACCESS_SOURCE', () => {
  it('throws ConfigError and never touches the database', async () => {
    vi.stubEnv('ACCESS_SOURCE', 'rolekatalog');
    const { runner, calls } = db([D1]);
    await expect(matchDirectoryUser(identity(), 'userid-claim', runner)).rejects.toMatchObject({ name: 'ConfigError' });
    expect(calls).toHaveLength(0);
  });
});
