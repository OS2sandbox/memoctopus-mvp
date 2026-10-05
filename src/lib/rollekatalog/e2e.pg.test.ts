// Needs a real Postgres 15+; skipped unless TEST_DATABASE_URL is set (see src/test/pg.ts).
// End to end: mock Rollekatalog -> runSync -> an app user linked to its directory
// row -> resolvePrincipal -> org-tree scope checks. It proves the pieces fit: what
// the sync writes is exactly what the permission code reads.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { hasPg, withFreshSchema } from '@/test/pg';
import type { ClientLike, SqlResult } from '@/lib/authz/pg-runner';

// resolvePrincipal uses the app's Drizzle instance. Point it at the throwaway
// schema's connection: Drizzle emits unqualified table names, which resolve
// through that connection's search_path.
const holder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/db', async () => {
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const schema = await import('@/lib/db/schema');
  const db = new Proxy(
    {},
    {
      get(_target, prop) {
        const real = drizzle(holder.client as Client, { schema }) as unknown as Record<string | symbol, unknown>;
        const value = real[prop];
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(real) : value;
      },
    },
  );
  return { db, pool: {} };
});

import { resolvePrincipal } from '@/lib/authz/principal';
import { isOrgUnitWithinScope, orgUnitsInScope, type ScopeEnv } from '@/lib/authz/scope';
import type { Principal } from '@/lib/authz/types';
import { createRollekatalogClient } from './client';
import { fixtureData, startMockRollekatalog, type MockRollekatalog } from './mock-server';
import { runSync } from './sync';
import type { SyncEnv } from './sync-run';

const U = (n: number) => `7e5e0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const O = (n: number) => `5a1b0000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Fixture tree:  1 Kommune > 2 Borgerservice > 3 Team Selvbetjening > 5 Digital Support
//                1 Kommune > 4 Økonomi
const ALL_UNITS = [1, 2, 3, 4, 5];

let mock: MockRollekatalog;
const opened: Client[] = [];

beforeAll(async () => {
  if (hasPg) mock = await startMockRollekatalog();
});
afterAll(async () => {
  if (mock) await mock.close();
});
beforeEach(() => {
  if (!hasPg) return;
  mock.resetData();
  mock.setFaults([]);
  vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
  vi.stubEnv('ROLLEKATALOG_URL', mock.url);
  vi.stubEnv('ROLLEKATALOG_READ_API_KEY', mock.readKey);
  vi.stubEnv('ROLLEKATALOG_ORG_API_KEY', mock.orgKey);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  holder.client = null;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.allSettled(opened.splice(0).map((c) => c.end()));
});

function schemaEnv(schema: string): SyncEnv {
  return {
    schema,
    connect: async (): Promise<ClientLike> => {
      const c = new Client({ connectionString: process.env.TEST_DATABASE_URL });
      await c.connect();
      opened.push(c);
      return {
        query: (text, params) => c.query(text, params as unknown[] | undefined) as unknown as Promise<SqlResult<never>>,
        release: () => void c.end().catch(() => {}),
      };
    },
  };
}

interface World {
  c: Client;
  schema: string;
  scopeEnv: ScopeEnv;
  sync: (opts?: { force?: boolean }) => ReturnType<typeof runSync>;
  principalOf: (directoryUuid: string) => Promise<Principal>;
  inScope: (p: Principal, cap: Parameters<typeof isOrgUnitWithinScope>[1]) => Promise<number[]>;
}

async function withWorld(fn: (w: World) => Promise<void>) {
  await withFreshSchema(async (c, schema) => {
    holder.client = c;
    const env = schemaEnv(schema);
    let tick = 0;
    const base = Date.now();
    const scopeEnv: ScopeEnv = {
      query: (text, params) => c.query(text, params as unknown[]),
      orgUnitsTable: `"${schema}".org_units`,
    };
    const world: World = {
      c,
      schema,
      scopeEnv,
      sync: (opts = {}) =>
        runSync(
          { trigger: 'cron', ...opts },
          {
            env,
            audit: async () => {},
            now: () => new Date(base + ++tick), // strictly later each call, but all "now"
            client: createRollekatalogClient({ backoffMs: 1, sleep: async () => {} }),
          },
        ),
      // The app account is linked to the directory row exactly as login matching does: via app_user_id.
      principalOf: async (directoryUuid) => {
        const appUser = `app-${directoryUuid}`;
        await c.query('INSERT INTO users (id, name, email) VALUES ($1, $1, $2) ON CONFLICT DO NOTHING', [appUser, `${appUser}@example.dk`]);
        await c.query('UPDATE directory_users SET app_user_id = NULL WHERE app_user_id = $1', [appUser]);
        await c.query('UPDATE directory_users SET app_user_id = $1 WHERE uuid = $2', [appUser, directoryUuid]);
        return resolvePrincipal(appUser);
      },
      // Which fixture units are inside the principal's scope for the capability.
      inScope: async (p, cap) => {
        const hits: number[] = [];
        for (const n of ALL_UNITS) if (await isOrgUnitWithinScope(p, cap, O(n), scopeEnv)) hits.push(n);
        return hits;
      },
    };
    await fn(world);
  });
}

describe.skipIf(!hasPg)('Rollekatalog sync -> principal -> scope (real Postgres)', () => {
  it('a skabelonansvarlig constrained to Borgerservice may manage templates for exactly that subtree', () =>
    withWorld(async (w) => {
      expect((await w.sync()).status).toBe('success');
      const jens = await w.principalOf(U(2)); // tt-skabelonansvarlig, constraint = Borgerservice (2)

      expect(jens.disabled).toBe(false);
      expect(jens.source).toBe('rollekatalog');
      expect(jens.roles).toEqual(['tt-bruger', 'tt-skabelonansvarlig']);
      expect(jens.capabilities).toContain('template.manage');
      expect(jens.capabilities).not.toContain('audit.read');
      expect(jens.capabilities).not.toContain('access.manage');
      expect(jens.capabilities).not.toContain('sync.run');

      expect(jens.scopes['template.manage']).toEqual({ global: false, roots: [{ orgUnitUuid: O(2), includeDescendants: true }] });
      // Borgerservice, Team Selvbetjening and Digital Support. NOT Kommune (the parent) and NOT Økonomi (a sibling).
      expect(await w.inScope(jens, 'template.manage')).toEqual([2, 3, 5]);
      expect(await isOrgUnitWithinScope(jens, 'template.manage', O(4), w.scopeEnv)).toBe(false);
      expect(await isOrgUnitWithinScope(jens, 'template.manage', O(1), w.scopeEnv)).toBe(false);
      expect(await orgUnitsInScope(jens, 'template.manage', w.scopeEnv)).toEqual({ all: false, uuids: expect.arrayContaining([O(2), O(3), O(5)]) });
    }));

  it('two constrained units give exactly those two subtrees (anne: Team Selvbetjening and Økonomi)', () =>
    withWorld(async (w) => {
      await w.sync();
      const anne = await w.principalOf(U(3));
      expect(await w.inScope(anne, 'template.manage')).toEqual([3, 4, 5]);
      expect(await isOrgUnitWithinScope(anne, 'template.manage', O(2), w.scopeEnv)).toBe(false);
    }));

  it('an assignment with a constraint on an unknown unit grants no scoped capability at all', () =>
    withWorld(async (w) => {
      await w.sync();
      const ole = await w.principalOf(U(8)); // tt-skabelonansvarlig constrained only to a unit Rollekatalog does not export
      expect(ole.roles).toEqual(['tt-bruger']);
      expect(ole.capabilities).not.toContain('template.manage');
      expect(await w.inScope(ole, 'template.manage')).toEqual([]);
    }));

  it('a tt-logleser without a usable constraint gets NO audit.read scope under the defaults', () =>
    withWorld(async (w) => {
      await w.sync();
      const ida = await w.principalOf(U(7)); // tt-logleser, no constraint
      expect(ida.roles).toEqual(['tt-bruger']);
      expect(ida.capabilities).not.toContain('audit.read');
      expect(ida.scopes['audit.read']).toBeUndefined();
      expect(await w.inScope(ida, 'audit.read')).toEqual([]);
      expect(await orgUnitsInScope(ida, 'audit.read', w.scopeEnv)).toEqual({ all: false, uuids: [] });
    }));

  it('a logleser with a constraint reads exactly that unit (lars: Økonomi, a leaf)', () =>
    withWorld(async (w) => {
      await w.sync();
      const lars = await w.principalOf(U(4));
      expect(lars.capabilities).toContain('audit.read');
      expect(lars.capabilities).not.toContain('audit.export'); // global-only
      expect(await w.inScope(lars, 'audit.read')).toEqual([4]);
    }));

  it('ROLLEKATALOG_GLOBAL_ROLES makes the same unscoped logleser global (the explicit opt-in)', () =>
    withWorld(async (w) => {
      vi.stubEnv('ROLLEKATALOG_GLOBAL_ROLES', 'tt-administrator,tt-logleser');
      await w.sync();
      const ida = await w.principalOf(U(7));
      expect(ida.scopes['audit.read']).toEqual({ global: true, roots: [] });
      expect(await w.inScope(ida, 'audit.read')).toEqual(ALL_UNITS);
      expect(ida.capabilities).toContain('audit.export');
    }));

  it('tt-administrator becomes global, even when Rollekatalog attached an org-unit constraint to it', () =>
    withWorld(async (w) => {
      await w.sync();
      for (const n of [1, 9]) {
        // mette.e carries a constraint on the admin role, rune.a none: both are global administrators.
        const admin = await w.principalOf(U(n));
        expect(admin.roles).toContain('tt-administrator');
        expect(admin.capabilities).toEqual(expect.arrayContaining(['access.manage', 'sync.run', 'audit.export', 'template.manage']));
        expect(admin.scopes['template.manage']).toEqual({ global: true, roots: [] });
        expect(await w.inScope(admin, 'template.manage')).toEqual(ALL_UNITS);
      }
    }));

  it('a user disabled in Rollekatalog is disabled in the principal, with no capabilities, although the roles are still listed upstream', () =>
    withWorld(async (w) => {
      await w.sync();
      expect(await w.c.query('SELECT count(*)::int AS n FROM role_assignments WHERE directory_user_uuid = $1', [U(5)])).toMatchObject({ rows: [{ n: 1 }] });
      const sofie = await w.principalOf(U(5));
      expect(sofie).toMatchObject({ disabled: true, roles: [], capabilities: [] });
      expect(await w.inScope(sofie, 'template.manage')).toEqual([]);
    }));

  it('a user who disappears upstream is disabled on the next sync and loses everything at once', () =>
    withWorld(async (w) => {
      await w.sync();
      const before = await w.principalOf(U(9));
      expect(before.capabilities).toContain('sync.run');

      const d = fixtureData();
      mock.setData({
        users: d.users.filter((u) => u.userId !== 'rune.a'),
        roleAssignments: (d.roleAssignments as Array<{ userId: string }>).filter((a) => a.userId !== 'rune.a'),
      });
      expect((await w.sync()).status).toBe('success');
      const after = await resolvePrincipal(`app-${U(9)}`);
      expect(after).toMatchObject({ disabled: true, capabilities: [], roles: [] });
    }));

  it('a role revoked upstream is gone after the next sync; a moved constraint moves the scope', () =>
    withWorld(async (w) => {
      await w.sync();
      expect(await w.inScope(await w.principalOf(U(2)), 'template.manage')).toEqual([2, 3, 5]);

      const d = fixtureData();
      mock.setData({
        roleAssignments: (d.roleAssignments as Array<{ userId: string; assignments: Array<{ roleIdentifier: string; roleConstraintValues: unknown[] }> }>).map((a) =>
          a.userId === 'jens.t'
            ? {
                ...a,
                assignments: [
                  { roleIdentifier: 'tt-skabelonansvarlig', roleConstraintValues: [{ constraintType: 'http://digital-identity.dk/constraints/orgunit/1', constraintValues: [O(4)] }] },
                ],
              }
            : a,
        ),
      });
      await w.sync();
      expect(await w.inScope(await resolvePrincipal(`app-${U(2)}`), 'template.manage')).toEqual([4]);

      mock.setData({ roleAssignments: (d.roleAssignments as Array<{ userId: string }>).filter((a) => a.userId !== 'jens.t') });
      await w.sync();
      const jens = await resolvePrincipal(`app-${U(2)}`);
      expect(jens.capabilities).not.toContain('template.manage');
      expect(jens.roles).toEqual(['tt-bruger']); // the implicit baseline stays
    }));

  it('ROLLEKATALOG_SCOPE_DESCENDANTS=false covers the unit only, not its subtree', () =>
    withWorld(async (w) => {
      vi.stubEnv('ROLLEKATALOG_SCOPE_DESCENDANTS', 'false');
      await w.sync();
      expect(await w.inScope(await w.principalOf(U(2)), 'template.manage')).toEqual([2]);
    }));

  it('ROLLEKATALOG_SCOPE_STRATEGY=manager scopes by the units a person manages or substitutes for', () =>
    withWorld(async (w) => {
      vi.stubEnv('ROLLEKATALOG_SCOPE_STRATEGY', 'manager');
      await w.sync();
      // ida.l is a substitute for the manager of Digital Support (a leaf).
      expect(await w.inScope(await w.principalOf(U(7)), 'audit.read')).toEqual([5]);
      // anne.p substitutes for jens.t on Borgerservice: the whole subtree.
      expect(await w.inScope(await w.principalOf(U(3)), 'template.manage')).toEqual([2, 3, 5]);
    }));

  describe('mode and staleness rules, with synced data', () => {
    it('local mode ignores the mirrored (rollekatalog-sourced) grants: they could not be edited or revoked there', () =>
      withWorld(async (w) => {
        await w.sync();
        vi.stubEnv('ACCESS_SOURCE', 'local');
        const jens = await w.principalOf(U(2));
        expect(jens.source).toBe('baseline');
        expect(jens.capabilities).toEqual(['template.use']);
        const rune = await w.principalOf(U(9));
        expect(rune.capabilities).not.toContain('sync.run');
      }));

    it('rollekatalog mode ignores a leftover source=local grant', () =>
      withWorld(async (w) => {
        await w.sync();
        await w.c.query(`INSERT INTO role_assignments (directory_user_uuid, role_key, source) VALUES ($1, 'tt-administrator', 'local')`, [U(7)]);
        const ida = await w.principalOf(U(7));
        expect(ida.capabilities).not.toContain('access.manage');
        expect(ida.roles).not.toContain('tt-administrator');
      }));

    it('grants older than ROLE_STALE_MAX_SECONDS vanish, the baseline stays, and the next sync brings them back', () =>
      withWorld(async (w) => {
        await w.sync();
        expect((await w.principalOf(U(2))).capabilities).toContain('template.manage');

        await w.c.query(`UPDATE role_assignments SET synced_at = now() - interval '2 days' WHERE source = 'rollekatalog'`);
        const stale = await resolvePrincipal(`app-${U(2)}`);
        expect(stale.capabilities).toEqual(['template.use']);
        expect(stale.roles).toEqual(['tt-bruger']);
        expect(stale.disabled).toBe(false);

        // An unchanged re-sync advances synced_at without changing a single row: that alone must restore access.
        const again = await w.sync();
        expect(again.counts.assignmentsUpserted).toBe(0);
        expect((await resolvePrincipal(`app-${U(2)}`)).capabilities).toContain('template.manage');

        // A longer limit keeps old grants (the setting is read at call time).
        await w.c.query(`UPDATE role_assignments SET synced_at = now() - interval '2 days' WHERE source = 'rollekatalog'`);
        vi.stubEnv('ROLE_STALE_MAX_SECONDS', String(3 * 86_400));
        expect((await resolvePrincipal(`app-${U(2)}`)).capabilities).toContain('template.manage');
      }));
  });
});
