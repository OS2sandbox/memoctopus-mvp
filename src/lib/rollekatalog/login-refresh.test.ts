import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeRunner } from '@/test/fake-runner';

vi.mock('@/lib/db', () => ({ pool: {} }));

import { MOCK_READ_KEY, startMockRollekatalog, type MockRollekatalog } from './mock-server';
import { grantedRoles, refreshUserFromRollekatalog } from './login-refresh';

const UUID = '9d3c0000-0000-4000-8000-000000000003';

interface State {
  dir: { uuid: string; ext_uuid: string | null; ext_user_id: string | null; disabled: boolean } | null;
  assignments: Array<{ id: string; role_key: string; source: string }>;
}

/** Statement-level fake of the three statements the refresh issues; the real SQL is covered by login-refresh.pg.test.ts. */
function world(state: State) {
  return makeFakeRunner((sql, params) => {
    if (sql.startsWith('SELECT')) return state.dir ? [state.dir] : [];
    if (sql.startsWith('DELETE')) {
      const granted = params[1] as string[];
      const gone = state.assignments.filter((a) => !granted.includes(a.role_key.toLowerCase()));
      state.assignments = state.assignments.filter((a) => granted.includes(a.role_key.toLowerCase()));
      return gone.map((a) => ({ id: a.id }));
    }
    if (sql.startsWith('UPDATE')) {
      if (state.dir && !state.dir.disabled) {
        state.dir.disabled = true;
        return [{ uuid: state.dir.uuid }];
      }
      return [];
    }
    return [];
  });
}

const initial = (over: Partial<State> = {}): State => ({
  dir: { uuid: 'dir-1', ext_uuid: UUID, ext_user_id: 'anne.p', disabled: false },
  assignments: [
    { id: 'a1', role_key: 'tt-bruger', source: 'rollekatalog' },
    { id: 'a2', role_key: 'tt-skabelonansvarlig', source: 'rollekatalog' },
  ],
  ...over,
});

let mock: MockRollekatalog;
beforeAll(async () => {
  mock = await startMockRollekatalog();
});
afterAll(async () => {
  await mock.close();
});
beforeEach(() => {
  mock.resetData();
  mock.setFaults([]);
  mock.clearRequests();
  vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
  vi.stubEnv('ROLLEKATALOG_URL', mock.url);
  vi.stubEnv('ROLLEKATALOG_READ_API_KEY', mock.readKey);
  // The refresh must not need the ORG key.
  vi.stubEnv('ROLLEKATALOG_ORG_API_KEY', '');
  vi.stubEnv('ROLLEKATALOG_ITSYSTEM_ID', 'os2taletiltekst');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const loggedText = () => JSON.stringify([...(console.warn as any).mock.calls, ...(console.error as any).mock.calls]);

describe('no-op cases', () => {
  it('does nothing in local mode: no SQL, no HTTP', async () => {
    vi.stubEnv('ACCESS_SOURCE', 'local');
    const { runner, calls } = world(initial());
    expect(await refreshUserFromRollekatalog('u1', { runner })).toEqual({ status: 'skipped', reason: 'not_rollekatalog_mode' });
    expect(calls).toHaveLength(0);
    expect(mock.requests).toHaveLength(0);
  });

  it.each([
    ['URL unset', { ROLLEKATALOG_URL: '' }],
    ['URL insecure', { ROLLEKATALOG_URL: 'http://rollekatalog.example.dk' }],
    ['READ key unset', { ROLLEKATALOG_READ_API_KEY: '' }],
  ])('does nothing when not configured (%s)', async (_n, env) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const { runner, calls } = world(initial());
    expect(await refreshUserFromRollekatalog('u1', { runner })).toEqual({ status: 'skipped', reason: 'not_configured' });
    expect(calls).toHaveLength(0);
    expect(mock.requests).toHaveLength(0);
  });

  it('does nothing for a user without a rollekatalog-sourced directory row (no HTTP)', async () => {
    const { runner, calls } = world(initial({ dir: null }));
    expect(await refreshUserFromRollekatalog('u1', { runner })).toEqual({ status: 'skipped', reason: 'not_linked' });
    expect(calls.every((c) => c.sql.startsWith('SELECT'))).toBe(true);
    expect(calls[0]!.sql).toContain("source = 'rollekatalog'");
    expect(mock.requests).toHaveLength(0);
  });

  it('does nothing for a row with neither ext_user_id nor ext_uuid', async () => {
    const { runner } = world(initial({ dir: { uuid: 'dir-1', ext_uuid: null, ext_user_id: null, disabled: false } }));
    expect(await refreshUserFromRollekatalog('u1', { runner })).toEqual({ status: 'skipped', reason: 'not_linked' });
    expect(mock.requests).toHaveLength(0);
  });
});

describe('Rollekatalog answers', () => {
  it('unchanged roles: nothing is written', async () => {
    const state = initial();
    const { runner, calls } = world(state);
    const res = await refreshUserFromRollekatalog('u1', { runner });
    expect(res).toEqual({ status: 'refreshed', markedDisabled: false, revokedRoles: 0 });
    expect(state.assignments).toHaveLength(2);
    expect(calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false);
    expect(mock.requests).toEqual([expect.objectContaining({ path: '/api/user/anne.p/rolesAsList', keyRole: 'read', status: 200 })]);
    expect(mock.requests[0]!.query).toContain('system=os2taletiltekst');
  });

  it('a disabled user is marked disabled and no other call is made', async () => {
    const state = initial({ dir: { uuid: 'dir-5', ext_uuid: '9d3c0000-0000-4000-8000-000000000005', ext_user_id: 'sofie.s', disabled: false } });
    const { runner } = world(state);
    const res = await refreshUserFromRollekatalog('u1', { runner });
    expect(res).toEqual({ status: 'refreshed', markedDisabled: true, revokedRoles: 0 });
    expect(state.dir!.disabled).toBe(true);
    expect(mock.requests).toHaveLength(1);
  });

  it('an already disabled row is not rewritten', async () => {
    const state = initial({ dir: { uuid: 'dir-5', ext_uuid: null, ext_user_id: 'sofie.s', disabled: true } });
    const { runner, calls } = world(state);
    expect(await refreshUserFromRollekatalog('u1', { runner })).toEqual({ status: 'refreshed', markedDisabled: false, revokedRoles: 0 });
    expect(calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false);
  });

  it('never re-enables: disabled=false in the answer leaves a disabled mirror row alone', async () => {
    const state = initial({ dir: { uuid: 'dir-1', ext_uuid: UUID, ext_user_id: 'anne.p', disabled: true } });
    const { runner, calls } = world(state);
    await refreshUserFromRollekatalog('u1', { runner });
    expect(state.dir!.disabled).toBe(true);
    expect(calls.some((c) => /SET disabled = false/.test(c.sql))).toBe(false);
  });

  it('a vanished user (404 on userId AND uuid) is marked disabled', async () => {
    const state = initial({ dir: { uuid: 'dir-x', ext_uuid: '9d3c0000-0000-4000-8000-0000000000ff', ext_user_id: 'nobody', disabled: false } });
    const { runner } = world(state);
    expect(await refreshUserFromRollekatalog('u1', { runner })).toEqual({ status: 'refreshed', markedDisabled: true, revokedRoles: 0 });
    expect(state.dir!.disabled).toBe(true);
    expect(mock.requests.map((r) => r.status)).toEqual([404, 404]);
  });

  it('a renamed userId (404) is found again by uuid and is NOT disabled', async () => {
    const state = initial({ dir: { uuid: 'dir-1', ext_uuid: UUID, ext_user_id: 'old.name', disabled: false } });
    const { runner } = world(state);
    expect(await refreshUserFromRollekatalog('u1', { runner })).toEqual({ status: 'refreshed', markedDisabled: false, revokedRoles: 0 });
    expect(state.dir!.disabled).toBe(false);
    expect(mock.requests.map((r) => r.status)).toEqual([404, 200]);
  });

  it('falls back to ext_uuid when there is no ext_user_id', async () => {
    const { runner } = world(initial({ dir: { uuid: 'dir-1', ext_uuid: UUID, ext_user_id: null, disabled: false } }));
    await refreshUserFromRollekatalog('u1', { runner });
    expect(mock.requests[0]!.path).toBe(`/api/user/${UUID}/rolesAsList`);
  });

  it('a revoked role deletes that role only', async () => {
    mock.setData({
      rolesAsList: {
        'anne.p': { nameID: 'x', systemRoles: ['tt-bruger'], userRoles: [], dataRoles: [], functionRoles: [], disabled: false },
      },
    });
    const state = initial();
    const { runner, calls } = world(state);
    const res = await refreshUserFromRollekatalog('u1', { runner });
    expect(res).toEqual({ status: 'refreshed', markedDisabled: false, revokedRoles: 1 });
    expect(state.assignments.map((a) => a.role_key)).toEqual(['tt-bruger']);
    const del = calls.find((c) => c.sql.startsWith('DELETE'))!;
    expect(del.sql).toContain("source = 'rollekatalog'");
    expect(del.params).toEqual(['dir-1', ['tt-bruger']]);
  });

  it('an answer without any roles revokes all rollekatalog roles of that user', async () => {
    mock.setData({ rolesAsList: { 'anne.p': { systemRoles: [], disabled: false } } });
    const state = initial();
    const { runner } = world(state);
    expect((await refreshUserFromRollekatalog('u1', { runner })).status).toBe('refreshed');
    expect(state.assignments).toEqual([]);
  });

  it('role identifiers are compared case-insensitively and trimmed', async () => {
    mock.setData({ rolesAsList: { 'anne.p': { systemRoles: [' TT-Bruger ', 'TT-SKABELONANSVARLIG'], disabled: false } } });
    const state = initial();
    const { runner } = world(state);
    expect(await refreshUserFromRollekatalog('u1', { runner })).toMatchObject({ revokedRoles: 0 });
    expect(state.assignments).toHaveLength(2);
  });

  it('a NEW role in the answer is never granted (no INSERT, nothing but the expected statements)', async () => {
    mock.setData({
      rolesAsList: { 'anne.p': { systemRoles: ['tt-bruger', 'tt-skabelonansvarlig', 'tt-administrator'], disabled: false } },
    });
    const state = initial();
    const { runner, calls } = world(state);
    const res = await refreshUserFromRollekatalog('u1', { runner });
    expect(res).toEqual({ status: 'refreshed', markedDisabled: false, revokedRoles: 0 });
    expect(state.assignments.map((a) => a.role_key)).toEqual(['tt-bruger', 'tt-skabelonansvarlig']);
    expect(calls.some((c) => /INSERT/i.test(c.sql))).toBe(false);
  });

  it('only ever issues SELECT, DELETE of rollekatalog rows and UPDATE disabled', async () => {
    mock.setData({ rolesAsList: { 'anne.p': { systemRoles: [], disabled: true } } });
    const { runner, calls } = world(initial());
    await refreshUserFromRollekatalog('u1', { runner });
    for (const c of calls) {
      expect(c.sql).toMatch(/^(SELECT|DELETE|UPDATE)/);
      if (!c.sql.startsWith('SELECT')) expect(c.sql).toContain("source = 'rollekatalog'");
    }
  });
});

describe('failures never throw and never change anything', () => {
  const expectUntouched = (state: State, calls: Array<{ sql: string }>) => {
    expect(state.assignments).toHaveLength(2);
    expect(state.dir!.disabled).toBe(false);
    expect(calls.filter((c) => !c.sql.startsWith('SELECT'))).toEqual([]);
  };

  it('a timeout is reported as code timeout within the short budget, without retrying', async () => {
    mock.setFaults([{ match: '/api/user/', delayMs: 800 }]);
    const state = initial();
    const { runner, calls } = world(state);
    const started = Date.now();
    const res = await refreshUserFromRollekatalog('u1', { runner, clientOptions: { timeoutMs: 150 } });
    expect(res).toEqual({ status: 'error', code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(700);
    expect(mock.requests.length).toBeLessThanOrEqual(1);
    expectUntouched(state, calls);
  });

  it('caps the HTTP timeout at 3 s even when ROLLEKATALOG_TIMEOUT_MS is larger', async () => {
    vi.stubEnv('ROLLEKATALOG_TIMEOUT_MS', '60000');
    const seen: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...a: unknown[]) => {
      if (typeof ms === 'number') seen.push(ms);
      return realSetTimeout(fn, ms, ...a);
    }) as typeof setTimeout);
    const { runner } = world(initial());
    await refreshUserFromRollekatalog('u1', { runner });
    expect(seen.filter((ms) => ms > 3000 && ms !== 4000)).toEqual([]);
    expect(seen.some((ms) => ms <= 3000 && ms > 2000)).toBe(true);
  });

  it('401 (wrong READ key) is reported as unauthorized and leaves the mirror alone', async () => {
    vi.stubEnv('ROLLEKATALOG_READ_API_KEY', 'definitely-wrong-key-9876');
    const state = initial();
    const { runner, calls } = world(state);
    expect(await refreshUserFromRollekatalog('u1', { runner })).toEqual({ status: 'error', code: 'unauthorized' });
    expectUntouched(state, calls);
    expect(mock.requests).toHaveLength(1);
    expect(loggedText()).not.toContain('definitely-wrong-key-9876');
  });

  it('403 (ORG key used as READ key) is reported as forbidden', async () => {
    vi.stubEnv('ROLLEKATALOG_READ_API_KEY', mock.orgKey);
    const state = initial();
    const { runner, calls } = world(state);
    expect(await refreshUserFromRollekatalog('u1', { runner })).toEqual({ status: 'error', code: 'forbidden' });
    expectUntouched(state, calls);
  });

  it('a 5xx is an error, not a revocation, and is not retried on the login path', async () => {
    mock.setFaults([{ match: '/api/user/', status: 503 }]);
    const state = initial();
    const { runner, calls } = world(state);
    expect(await refreshUserFromRollekatalog('u1', { runner })).toEqual({ status: 'error', code: 'server_error' });
    expect(mock.requests).toHaveLength(1);
    expectUntouched(state, calls);
  });

  it('a malformed (non-JSON) response is invalid_response', async () => {
    mock.setFaults([{ match: '/api/user/', invalidJson: true }]);
    const state = initial();
    const { runner, calls } = world(state);
    expect(await refreshUserFromRollekatalog('u1', { runner })).toEqual({ status: 'error', code: 'invalid_response' });
    expectUntouched(state, calls);
  });

  it('a JSON answer without the required disabled flag is invalid_response (never trusted as "no roles")', async () => {
    mock.setData({ rolesAsList: { 'anne.p': { systemRoles: [] } } });
    const state = initial();
    const { runner, calls } = world(state);
    expect(await refreshUserFromRollekatalog('u1', { runner })).toEqual({ status: 'error', code: 'invalid_response' });
    expectUntouched(state, calls);
  });

  it('an unreachable server is network', async () => {
    vi.stubEnv('ROLLEKATALOG_URL', 'http://127.0.0.1:1');
    const state = initial();
    const { runner, calls } = world(state);
    expect(await refreshUserFromRollekatalog('u1', { runner })).toEqual({ status: 'error', code: 'network' });
    expectUntouched(state, calls);
  });

  it('a database failure is swallowed and reported without the message', async () => {
    const { runner } = makeFakeRunner(() => {
      throw Object.assign(new Error('connection to secret-host failed'), { code: '08006' });
    });
    const res = await refreshUserFromRollekatalog('u1', { runner });
    expect(res).toEqual({ status: 'error', code: 'unexpected' });
    expect(loggedText()).not.toContain('secret-host');
    expect(loggedText()).toContain('/08006');
  });

  it('logs only short codes: no key, URL, user id or role names', async () => {
    mock.setData({ rolesAsList: { 'anne.p': { systemRoles: [], disabled: false } } });
    const { runner } = world(initial());
    await refreshUserFromRollekatalog('u1', { runner });
    mock.setFaults([{ match: '/api/user/', status: 500 }]);
    await refreshUserFromRollekatalog('u1', { runner });
    const logged = loggedText();
    for (const secret of [MOCK_READ_KEY, mock.url, 'anne.p', UUID, 'tt-skabelonansvarlig', 'u1']) {
      expect(logged).not.toContain(secret);
    }
  });
});

describe('grantedRoles', () => {
  it('uses system role identifiers only, normalised', () => {
    expect([...grantedRoles({ systemRoles: [' TT-Bruger', '', 'tt-logleser'] })]).toEqual(['tt-bruger', 'tt-logleser']);
  });
});
