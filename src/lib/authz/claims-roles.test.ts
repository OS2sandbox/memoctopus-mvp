import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeRunner } from '@/test/fake-runner';
import type { ClaimListSpec, RolesConfig } from '@/lib/auth/providers';

vi.mock('@/lib/db', () => ({ pool: {} }));

// The role mapping and claim names are config (AUTH_CONFIG_FILE); here they are plain state.
const state: { roles: RolesConfig; specs: { claims: object; rolesClaim?: ClaimListSpec; groupsClaim?: ClaimListSpec } | null } = {
  roles: { state: 'unset' },
  specs: null,
};
vi.mock('@/lib/auth/providers', () => ({
  authRolesConfig: () => state.roles,
  providerClaimSpecs: () => state.specs,
}));

import {
  applyClaimsLogin,
  applyClaimsLoginSafely,
  claimSubset,
  clearClaimsRoles,
  decideFromClaims,
  extractClaimValues,
  mapClaimRoles,
  readClaim,
} from './claims-roles';

const arr = (name: string): ClaimListSpec => ({ name, format: 'array', separator: ',' });
const delim = (name: string, separator = ';'): ClaimListSpec => ({ name, format: 'delimited', separator });
const rolesCfg = (appRoleMap: Record<string, string>, groupRoleMap: Record<string, string> = {}): RolesConfig => ({
  state: 'ok',
  appRoleMap: new Map(Object.entries(appRoleMap).map(([k, role]) => [k, { role: role as never, global: true }])),
  groupRoleMap: new Map(Object.entries(groupRoleMap).map(([k, role]) => [k, { role: role as never, global: true }])),
});

beforeEach(() => {
  state.roles = rolesCfg({ admin: 'tt-administrator', su: 'tt-skabelonansvarlig' }, { 'g-log': 'tt-logleser' });
  state.specs = { claims: {}, rolesClaim: arr('roles'), groupsClaim: delim('memberOf') };
  vi.stubEnv('ACCESS_SOURCE', 'claims');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('readClaim', () => {
  it('reads an exact key first (SAML attribute names are URLs full of dots), then a dotted path', () => {
    const claims = { 'http://x.example/role': ['a'], realm_access: { roles: ['b'] }, 'a.b': 'exact' , a: { b: 'nested' } };
    expect(readClaim(claims, 'http://x.example/role')).toEqual(['a']);
    expect(readClaim(claims, 'realm_access.roles')).toEqual(['b']);
    expect(readClaim(claims, 'a.b')).toBe('exact');
    expect(readClaim(claims, 'nope.nope')).toBeUndefined();
  });

  it('never reads inherited properties', () => {
    expect(readClaim({}, '__proto__')).toBeUndefined();
    expect(readClaim({}, 'constructor.name')).toBeUndefined();
    expect(readClaim(JSON.parse('{"__proto__": {"roles": ["x"]}}'), 'roles')).toBeUndefined();
  });
});

describe('extractClaimValues', () => {
  it('is "unconfigured" without a spec, and an absent claim is no values', () => {
    expect(extractClaimValues({ roles: ['a'] }, undefined)).toEqual({ status: 'unconfigured' });
    expect(extractClaimValues({}, arr('roles'))).toEqual({ status: 'ok', values: [] });
    expect(extractClaimValues({ roles: null }, arr('roles'))).toEqual({ status: 'ok', values: [] });
  });

  it('reads an array, or a lone string as one value, trimming and deduplicating', () => {
    expect(extractClaimValues({ roles: [' a ', 'b', 'a', ''] }, arr('roles'))).toEqual({ status: 'ok', values: ['a', 'b'] });
    expect(extractClaimValues({ roles: 'a;b' }, arr('roles'))).toEqual({ status: 'ok', values: ['a;b'] }); // an array claim is never split
  });

  it('splits a delimited string on the separator', () => {
    expect(extractClaimValues({ g: 'a; b ;;c' }, delim('g'))).toEqual({ status: 'ok', values: ['a', 'b', 'c'] });
    expect(extractClaimValues({ g: 'a b' }, delim('g', ' '))).toEqual({ status: 'ok', values: ['a', 'b'] });
  });

  it.each([
    ['an object', { roles: { a: 1 } }, arr('roles')],
    ['a number', { roles: 5 }, arr('roles')],
    ['an array with a non-string', { roles: ['a', 1] }, arr('roles')],
    ['a nested array', { roles: [['a']] }, arr('roles')],
    ['an array where a string is declared', { g: ['a'] }, delim('g')],
    ['a value that is far too long', { roles: ['x'.repeat(513)] }, arr('roles')],
  ])('is invalid for %s', (_n, claims, spec) => {
    expect(extractClaimValues(claims, spec)).toEqual({ status: 'invalid' });
  });

  it('is invalid for an absurd number of values', () => {
    expect(extractClaimValues({ roles: Array.from({ length: 1001 }, (_v, i) => `r${i}`) }, arr('roles'))).toEqual({ status: 'invalid' });
  });
});

describe('claimSubset', () => {
  it('keeps only what the specs read (the top-level key for a dotted path)', () => {
    expect(
      claimSubset({ roles: ['a'], realm_access: { roles: ['b'] }, name: 'secret person', email: 'x@y.dk' }, { rolesClaim: arr('roles'), groupsClaim: arr('realm_access.roles') }),
    ).toEqual({ roles: ['a'], realm_access: { roles: ['b'] } });
  });
});

describe('mapClaimRoles', () => {
  it('maps known values and ignores the rest', () => {
    const map = rolesCfg({ admin: 'tt-administrator' });
    if (map.state !== 'ok') throw new Error();
    expect(mapClaimRoles(['admin', 'unknown', 'ADMIN'], map.appRoleMap)).toEqual(['tt-administrator']); // exact match, case-sensitive
  });
});

describe('decideFromClaims', () => {
  it('maps roles claim values via appRoleMap and groups via groupRoleMap, unknown values grant nothing', () => {
    const d = decideFromClaims({ roles: ['admin', 'nonsense'], memberOf: 'g-log;g-other' }, 'p');
    expect(d.roles.sort()).toEqual(['tt-administrator', 'tt-logleser']);
    expect(d.external).toEqual([
      { kind: 'role', identifier: 'admin' },
      { kind: 'role', identifier: 'nonsense' },
      { kind: 'group', identifier: 'g-log' },
      { kind: 'group', identifier: 'g-other' },
    ]);
  });

  it('a group value never grants an app role through the roles map, nor the other way round', () => {
    expect(decideFromClaims({ roles: [], memberOf: 'admin' }, 'p').roles).toEqual([]);
    expect(decideFromClaims({ roles: ['g-log'] }, 'p').roles).toEqual([]);
  });

  it('is empty without claims, without a provider spec, with an unset or invalid roles section', () => {
    expect(decideFromClaims(null, 'p')).toEqual({ roles: [], external: [] });
    state.specs = null;
    expect(decideFromClaims({ roles: ['admin'] }, 'p')).toEqual({ roles: [], external: [] });
    state.specs = { claims: {}, rolesClaim: arr('roles') };
    state.roles = { state: 'unset' };
    expect(decideFromClaims({ roles: ['admin'] }, 'p').roles).toEqual([]);
    state.roles = { state: 'invalid' };
    expect(decideFromClaims({ roles: ['admin'] }, 'p').roles).toEqual([]);
  });

  it('still reports the values for the catalogue when only the role mapping is unusable', () => {
    state.roles = { state: 'invalid' };
    expect(decideFromClaims({ roles: ['admin'] }, 'p').external).toEqual([{ kind: 'role', identifier: 'admin' }]);
  });

  it('one malformed claim poisons the whole login', () => {
    expect(decideFromClaims({ roles: ['admin'], memberOf: ['not', 'a', 'string'] }, 'p')).toEqual({ roles: [], external: [] });
    expect(decideFromClaims({ roles: { a: 1 }, memberOf: 'g-log' }, 'p')).toEqual({ roles: [], external: [] });
  });

  it('stores nothing for a claim that is not configured', () => {
    state.specs = { claims: {}, rolesClaim: arr('roles') }; // no groupsClaim
    expect(decideFromClaims({ roles: ['admin'], memberOf: 'g-log' }, 'p').external).toEqual([{ kind: 'role', identifier: 'admin' }]);
    state.specs = { claims: {} };
    expect(decideFromClaims({ roles: ['admin'], memberOf: 'g-log' }, 'p')).toEqual({ roles: [], external: [] });
  });
});

describe('applyClaimsLogin', () => {
  const input = { userId: 'u1', providerId: 'p', claims: { roles: ['admin', 'su'], memberOf: 'g-log' } as Record<string, unknown> | null };

  function runner(directory: Array<{ uuid: string; disabled: boolean }> = [{ uuid: 'D1', disabled: false }]) {
    return makeFakeRunner((sql) => {
      if (sql.includes('FROM public.directory_users WHERE app_user_id')) return directory;
      if (sql.includes('INSERT INTO public.user_external_roles')) return [{ '?column?': 1 }];
      return [];
    });
  }

  it('does nothing outside claims mode', async () => {
    vi.stubEnv('ACCESS_SOURCE', 'local');
    const { runner: r, calls } = runner();
    expect((await applyClaimsLogin(input, r)).outcome).toBe('skipped_not_claims_mode');
    expect(calls).toHaveLength(0);
  });

  it('replaces the claims rows in ONE transaction: delete, insert per role, then the external roles', async () => {
    const { runner: r, calls } = runner();
    const res = await applyClaimsLogin(input, r);
    expect(res).toMatchObject({ outcome: 'applied', rolesWritten: 3, externalStored: 1 });
    const sqls = calls.map((c) => c.sql.replace(/\s+/g, ' ').trim());
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls.at(-1)).toBe('COMMIT');
    expect(calls.slice(1, -1).every((c) => c.tx)).toBe(true);
    const del = sqls.findIndex((s) => s.startsWith("DELETE FROM public.role_assignments WHERE directory_user_uuid = $1 AND source = 'claims'"));
    const inserts = sqls.flatMap((s, i) => (s.startsWith('INSERT INTO public.role_assignments') ? [i] : []));
    expect(del).toBeGreaterThan(0);
    expect(inserts).toHaveLength(3); // admin, su and the group g-log
    expect(inserts.every((i) => i > del)).toBe(true);
    expect(calls[inserts[0]].params).toEqual(['D1', expect.stringMatching(/^tt-/)]);
    expect(sqls[inserts[0]]).toContain("NULL, true, 'claims', now()"); // global scope, claims source, fresh synced_at
    // Only values that are in the (active) catalogue are stored.
    const ext = calls.find((c) => c.sql.includes('INSERT INTO public.user_external_roles'))!;
    expect(ext.sql).toMatch(/FROM\s+public\.external_roles/);
    expect(ext.sql).toContain('WHERE e.active');
    expect(ext.params).toEqual(['u1', ['role', 'role', 'group'], ['admin', 'su', 'g-log']]);
  });

  it('creates the directory row on the first claims login (source claims), tolerating a concurrent one', async () => {
    let created = false;
    const { runner: r, calls } = makeFakeRunner((sql) => {
      if (sql.includes('FROM public.directory_users WHERE app_user_id')) return created ? [{ uuid: 'D9', disabled: false }] : [];
      if (sql.includes('INSERT INTO public.directory_users')) {
        created = true;
        return [];
      }
      return [];
    });
    await applyClaimsLogin(input, r);
    const insert = calls.find((c) => c.sql.includes('INSERT INTO public.directory_users'))!;
    expect(insert.sql).toContain("'claims'");
    expect(insert.sql).toContain('ON CONFLICT (app_user_id) DO NOTHING');
    expect(calls.find((c) => c.sql.startsWith('INSERT INTO public.role_assignments'))!.params[0]).toBe('D9');
  });

  it('writes nothing for a disabled person and removes what is left', async () => {
    const { runner: r, calls } = runner([{ uuid: 'D1', disabled: true }]);
    expect((await applyClaimsLogin(input, r)).outcome).toBe('skipped_disabled');
    expect(calls.some((c) => c.sql.startsWith('INSERT INTO public.role_assignments'))).toBe(false);
    expect(calls.some((c) => c.sql.includes('DELETE FROM public.user_external_roles'))).toBe(true);
  });

  it('claims null (the IdP told us nothing usable) clears everything it gave', async () => {
    const { runner: r, calls } = runner();
    const res = await applyClaimsLogin({ ...input, claims: null }, r);
    expect(res).toMatchObject({ rolesWritten: 0, externalStored: 0 });
    expect(calls.some((c) => c.sql.startsWith('INSERT INTO public.role_assignments'))).toBe(false);
    expect(calls.some((c) => c.sql.includes("DELETE FROM public.role_assignments WHERE directory_user_uuid = $1 AND source = 'claims'"))).toBe(true);
  });

  it('a database error rolls the whole replacement back', async () => {
    const { runner: r, sqls } = makeFakeRunner((sql) => {
      if (sql.includes('FROM public.directory_users WHERE app_user_id')) return [{ uuid: 'D1', disabled: false }];
      if (sql.startsWith('INSERT INTO public.role_assignments')) throw Object.assign(new Error('boom'), { code: '23514' });
      return [];
    });
    await expect(applyClaimsLogin(input, r)).rejects.toThrow('boom');
    expect(sqls().at(-1)).toBe('ROLLBACK');
  });
});

describe('applyClaimsLoginSafely / clearClaimsRoles', () => {
  it('never throws, logs only a label, and clears on failure (fail closed)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let attempts = 0;
    const { runner: r, calls } = makeFakeRunner((sql) => {
      if (sql.includes('FROM public.directory_users WHERE app_user_id')) {
        // The apply fails, the clear (which does not look the row up) works.
        attempts++;
        throw Object.assign(new Error('secret-claim-value in message'), { code: '08006' });
      }
      return [];
    });
    await expect(applyClaimsLoginSafely({ userId: 'u1', providerId: 'p', claims: { roles: ['admin'] } }, r)).resolves.toBeUndefined();
    expect(attempts).toBe(1);
    expect(calls.some((c) => c.sql.includes("USING public.directory_users du") && c.sql.includes("ra.source = 'claims'"))).toBe(true);
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).toContain('apply_claims');
    expect(logged).not.toContain('secret-claim-value');
  });

  it('clearClaimsRoles removes the claims rows and the external roles of the user, in one transaction', async () => {
    const { runner: r, calls } = makeFakeRunner();
    await clearClaimsRoles('u1', r);
    const sqls = calls.map((c) => c.sql.replace(/\s+/g, ' ').trim());
    expect(sqls).toHaveLength(4);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[1]).toMatch(/^DELETE FROM public\.role_assignments ra USING public\.directory_users du .* ra\.source = 'claims'$/);
    expect(sqls[2]).toBe('DELETE FROM public.user_external_roles WHERE user_id = $1');
    expect(sqls[3]).toBe('COMMIT');
  });
});
