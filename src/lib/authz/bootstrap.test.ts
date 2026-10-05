import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeRunner } from '@/test/fake-runner';
import type { SqlQueryable, SqlResult, SqlRunner } from './pg-runner';

vi.mock('@/lib/db', () => ({ pool: {} }));
const recordAdminAction = vi.fn(async () => {});
vi.mock('@/lib/audit/seam', () => ({ recordAdminAction: (...a: unknown[]) => recordAdminAction(...(a as [])) }));

import { identityQualifies, maybeBootstrapAdmin } from './bootstrap';

const ALLOW = ['admin@example.dk'];
const TENANT = 'aaaaaaaa-0000-4000-8000-000000000001';

beforeEach(() => {
  vi.stubEnv('ACCESS_SOURCE', 'local');
  vi.stubEnv('BOOTSTRAP_ADMIN_EMAILS', 'Admin@Example.dk');
  vi.stubEnv('MICROSOFT_TENANT_ID', '');
  recordAdminAction.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe('identityQualifies (rule table)', () => {
  const oidc = { email: 'admin@example.dk', email_verified: true };

  it('accepts a verified generic-OIDC email on the allow-list', () => {
    expect(identityQualifies('oidc', oidc, ALLOW)).toBe(true);
    expect(identityQualifies('authentik', oidc, ALLOW)).toBe(true);
  });
  it('refuses credential accounts', () => {
    expect(identityQualifies('credential', oidc, ALLOW)).toBe(false);
  });
  it.each([{ email_verified: false }, {}])('refuses an unverified OIDC email %j', (v) => {
    expect(identityQualifies('oidc', { email: 'admin@example.dk', ...v }, ALLOW)).toBe(false);
  });
  it('refuses emails that are not on the allow-list', () => {
    expect(identityQualifies('oidc', { email: 'other@example.dk', email_verified: true }, ALLOW)).toBe(false);
    expect(identityQualifies('oidc', { email_verified: true }, ALLOW)).toBe(false);
  });
  it('compares the email case-insensitively', () => {
    expect(identityQualifies('oidc', { email: 'ADMIN@EXAMPLE.DK', email_verified: true }, ALLOW)).toBe(true);
  });

  describe('microsoft', () => {
    const ms = { email: 'admin@example.dk', tid: TENANT };
    it('accepts a configured single tenant with a matching tid, without email_verified', () => {
      vi.stubEnv('MICROSOFT_TENANT_ID', TENANT.toUpperCase());
      expect(identityQualifies('microsoft', ms, ALLOW)).toBe(true);
    });
    it.each(['common', 'organizations', 'consumers', ''])('refuses multi-tenant setting "%s"', (t) => {
      vi.stubEnv('MICROSOFT_TENANT_ID', t);
      expect(identityQualifies('microsoft', { ...ms, tid: t || TENANT }, ALLOW)).toBe(false);
    });
    it('refuses a tid that is not the configured tenant', () => {
      vi.stubEnv('MICROSOFT_TENANT_ID', TENANT);
      expect(identityQualifies('microsoft', { ...ms, tid: 'bbbbbbbb-0000-4000-8000-000000000002' }, ALLOW)).toBe(false);
      expect(identityQualifies('microsoft', { email: ms.email }, ALLOW)).toBe(false);
    });
    it('does not let email_verified substitute for the tenant check', () => {
      expect(identityQualifies('microsoft', { ...ms, email_verified: true }, ALLOW)).toBe(false);
    });
  });
});

/** Stateful fake: tracks admin rows and serialises transactions on the advisory lock. */
function statefulDb(opts: { identities: Record<string, Array<{ provider_id: string; claims: unknown }>>; disabled?: boolean }) {
  const state = { admins: 0, grants: [] as string[], lockQueue: Promise.resolve() };
  const dirUsers = new Map<string, { uuid: string; disabled: boolean }>();
  if (opts.disabled) dirUsers.set('u1', { uuid: 'dir-u1', disabled: true });

  const handle = async (sql: string, params: readonly unknown[]): Promise<Array<Record<string, unknown>>> => {
    await Promise.resolve();
    if (sql.includes('FROM public.role_assignments') && sql.includes('LIMIT 1')) return state.admins > 0 ? [{ '?column?': 1 }] : [];
    if (sql.includes('FROM public.external_identities')) return opts.identities[params[0] as string] ?? [];
    if (sql.includes('FROM public.directory_users WHERE app_user_id')) {
      const d = dirUsers.get(params[0] as string);
      return d ? [d] : [];
    }
    if (sql.includes('INSERT INTO public.directory_users')) {
      const d = { uuid: `dir-${params[0]}`, disabled: false };
      dirUsers.set(params[0] as string, d);
      return [{ uuid: d.uuid }];
    }
    if (sql.includes('SELECT id FROM public.role_assignments')) return [];
    if (sql.includes('INSERT INTO public.role_assignments')) {
      state.admins += 1;
      state.grants.push(params[0] as string);
      return [{ id: `ra-${state.admins}` }];
    }
    return [];
  };

  const runner: SqlRunner = {
    query: (sql, params = []) => handle(sql, params).then((rows) => ({ rows, rowCount: rows.length }) as SqlResult<never>),
    async transaction(fn) {
      let release!: () => void;
      let locked = false;
      const tx: SqlQueryable = {
        async query(sql, params = []) {
          if (sql.includes('pg_advisory_xact_lock') && !locked) {
            const prev = state.lockQueue;
            state.lockQueue = new Promise<void>((r) => (release = r));
            await prev;
            locked = true;
          }
          const rows = await handle(sql, params);
          return { rows, rowCount: rows.length } as SqlResult<never>;
        },
      };
      try {
        return await fn(tx);
      } finally {
        if (locked) release();
      }
    },
  };
  return { runner, state };
}

const oidcIdentity = [{ provider_id: 'oidc', claims: { sub: 's', email: 'admin@example.dk', email_verified: true } }];

describe('maybeBootstrapAdmin', () => {
  it('is local-mode only', async () => {
    vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
    const { runner, calls } = makeFakeRunner();
    expect(await maybeBootstrapAdmin('u1', runner)).toEqual({ granted: false, reason: 'not_local_mode' });
    expect(calls).toHaveLength(0);
  });

  it('does nothing without an allow-list', async () => {
    vi.stubEnv('BOOTSTRAP_ADMIN_EMAILS', '');
    const { runner, calls } = makeFakeRunner();
    expect((await maybeBootstrapAdmin('u1', runner)).reason).toBe('no_allowlist');
    expect(calls).toHaveLength(0);
  });

  it('refuses when an active administrator already exists, without reading identities', async () => {
    const { runner, calls } = makeFakeRunner((sql) => (sql.includes('LIMIT 1') ? [{ x: 1 }] : []));
    expect((await maybeBootstrapAdmin('u1', runner)).reason).toBe('admin_exists');
    expect(calls.some((c) => c.sql.includes('external_identities'))).toBe(false);
  });

  it('only counts active assignments when looking for an existing administrator', async () => {
    const { runner, calls } = makeFakeRunner();
    await maybeBootstrapAdmin('u1', runner);
    const sql = calls[0].sql;
    expect(sql).toContain("role_key = 'tt-administrator'");
    expect(sql).toContain('start_date <= now()');
    expect(sql).toContain('stop_date > now()');
  });

  it('does not count unusable administrators (same definition as the revoke guard)', async () => {
    const { runner, calls } = makeFakeRunner();
    await maybeBootstrapAdmin('u1', runner);
    const sql = calls[0].sql;
    expect(sql).toContain('public.directory_users');
    expect(sql).toContain('du.disabled = false');
    expect(sql).toContain('du.app_user_id IS NOT NULL');
    expect(sql).toContain("ra.source = 'local'");
    expect(sql).toContain('ra.scope_org_unit_uuid IS NULL');
  });

  it('reads only SSO identities backed by an existing account', async () => {
    const { runner, calls } = makeFakeRunner();
    await maybeBootstrapAdmin('u1', runner);
    const q = calls.find((c) => c.sql.includes('external_identities'))!;
    expect(q.sql).toContain("provider_id <> 'credential'");
    expect(q.sql).toContain('public.accounts');
  });

  it('refuses a credential-only user (no SSO identity)', async () => {
    const { runner } = statefulDb({ identities: {} });
    expect((await maybeBootstrapAdmin('u1', runner)).reason).toBe('no_qualifying_identity');
  });

  it('refuses an unverified OIDC email', async () => {
    const { runner, state } = statefulDb({
      identities: { u1: [{ provider_id: 'oidc', claims: { email: 'admin@example.dk', email_verified: false } }] },
    });
    expect((await maybeBootstrapAdmin('u1', runner)).granted).toBe(false);
    expect(state.admins).toBe(0);
  });

  it('grants a global local tt-administrator, creating the directory user, in one transaction under the lock', async () => {
    const { runner, state } = statefulDb({ identities: { u1: oidcIdentity } });
    expect(await maybeBootstrapAdmin('u1', runner)).toEqual({ granted: true, reason: 'granted' });
    expect(state.grants).toEqual(['dir-u1']);
    expect(recordAdminAction).toHaveBeenCalledOnce();
    expect(recordAdminAction.mock.calls[0]).toMatchObject([
      expect.anything(),
      { type: 'access.role_assign', actorUserId: 'u1', details: { roleKey: 'tt-administrator', bootstrap: true } },
    ]);
  });

  it('writes created_by_user_id NULL, scope NULL and source local', async () => {
    const { runner, calls } = makeFakeRunner((sql) => {
      if (sql.includes('LIMIT 1')) return [];
      if (sql.includes('external_identities')) return [{ provider_id: 'oidc', claims: oidcIdentity[0].claims }];
      if (sql.includes('INSERT INTO public.directory_users')) return [{ uuid: 'd1' }];
      if (sql.includes('INSERT INTO public.role_assignments')) return [{ id: 'ra1' }];
      return [];
    });
    await maybeBootstrapAdmin('u1', runner);
    const insert = calls.find((c) => c.sql.includes('INSERT INTO public.role_assignments'))!;
    expect(insert.tx).toBe(true);
    expect(insert.sql).toMatch(/VALUES \(\$1, 'tt-administrator', NULL, true, 'local', NULL\)/);
    const sqls = calls.map((c) => c.sql);
    expect(sqls.findIndex((s) => s.includes('pg_advisory_xact_lock'))).toBeLessThan(
      sqls.findIndex((s) => s.includes('INSERT INTO public.role_assignments')),
    );
  });

  it('does not grant to a disabled directory user', async () => {
    const { runner, state } = statefulDb({ identities: { u1: oidcIdentity }, disabled: true });
    expect((await maybeBootstrapAdmin('u1', runner)).reason).toBe('directory_user_disabled');
    expect(state.admins).toBe(0);
  });

  it('two concurrent first logins produce exactly one grant (re-check inside the lock)', async () => {
    const { runner, state } = statefulDb({ identities: { u1: oidcIdentity, u2: oidcIdentity } });
    const results = await Promise.all([maybeBootstrapAdmin('u1', runner), maybeBootstrapAdmin('u2', runner)]);

    expect(results.filter((r) => r.granted)).toHaveLength(1);
    expect(results.find((r) => !r.granted)!.reason).toBe('admin_exists');
    expect(state.admins).toBe(1);
    expect(state.grants).toHaveLength(1);
  });

  it('the same user logging in twice concurrently is granted once', async () => {
    const { runner, state } = statefulDb({ identities: { u1: oidcIdentity } });
    const results = await Promise.all([maybeBootstrapAdmin('u1', runner), maybeBootstrapAdmin('u1', runner)]);
    expect(results.filter((r) => r.granted)).toHaveLength(1);
    expect(state.admins).toBe(1);
  });
});
