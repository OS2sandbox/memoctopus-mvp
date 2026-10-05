import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeRunner } from '@/test/fake-runner';

vi.mock('@/lib/db', () => ({ pool: {} }));
const recordAdminAction = vi.fn(async () => {});
vi.mock('@/lib/audit/seam', () => ({ recordAdminAction: (...a: unknown[]) => recordAdminAction(...(a as [])) }));

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
  recordAdminAction.mockClear();
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
    expect(select.params).toEqual(['ABC123']);
    expect(calls.map((c) => c.sql)[0]).toBe('BEGIN');
    expect(calls.at(-1)!.sql).toBe('COMMIT');
    expect(recordAdminAction).toHaveBeenCalledOnce();
  });

  it('uses DIRECTORY_USERID_CLAIM', async () => {
    vi.stubEnv('DIRECTORY_USERID_CLAIM', 'upn');
    const { runner, calls } = db([D1]);
    await matchDirectoryUser(identity({ claims: { sub: 's', upn: 'x@corp.dk' } }), 'userid-claim', runner);
    expect(calls.find((c) => c.sql.includes('FOR UPDATE'))!.params).toEqual(['x@corp.dk']);
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
    expect(recordAdminAction).not.toHaveBeenCalled();
  });

  it('never relinks a directory entry that points at a different app user', async () => {
    const { runner, calls } = db([{ uuid: 'd1', app_user_id: 'someone-else' }]);
    expect((await matchDirectoryUser(identity(), 'userid-claim', runner)).status).toBe('conflict');
    expect(calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false);
    expect(recordAdminAction).not.toHaveBeenCalled();
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
    expect(recordAdminAction).not.toHaveBeenCalled();
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
