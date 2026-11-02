// Needs a real Postgres 15+; skipped unless TEST_DATABASE_URL is set (see src/test/pg.ts).
// Runs the real recursive CTEs against a throwaway schema, via the ScopeEnv seam.
import { describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { hasPg, withFreshSchema } from '@/test/pg';
import { makePrincipal } from '@/test/helpers';
import { isOrgUnitWithinScope, orgSubtreeUuids, orgUnitsInScope, type ScopeEnv } from './scope';

function envFor(client: Client, schema: string): ScopeEnv {
  return { query: (text, params) => client.query(text, params as unknown[]), orgUnitsTable: `"${schema}".org_units` };
}

async function unit(c: Client, name: string, parent: string | null = null): Promise<string> {
  const r = await c.query(`INSERT INTO org_units (name, parent_uuid, source) VALUES ($1, $2, 'local') RETURNING uuid`, [
    name,
    parent,
  ]);
  return r.rows[0].uuid;
}

const manager = (roots: Array<{ orgUnitUuid: string; includeDescendants: boolean }>) =>
  makePrincipal({
    capabilities: ['template.use', 'template.manage'],
    scopes: { 'template.manage': { global: false, roots } },
  });

const UNKNOWN = '99999999-9999-4999-8999-999999999999';

describe.skipIf(!hasPg)('org scope (real Postgres)', () => {
  it('covers the subtree with descendants, not siblings or the parent', () =>
    withFreshSchema(async (c, schema) => {
      const env = envFor(c, schema);
      const root = await unit(c, 'Kommune');
      const a = await unit(c, 'A', root);
      const a1 = await unit(c, 'A1', a);
      const a11 = await unit(c, 'A11', a1);
      const b = await unit(c, 'B', root);

      const p = manager([{ orgUnitUuid: a, includeDescendants: true }]);
      for (const id of [a, a1, a11]) expect(await isOrgUnitWithinScope(p, 'template.manage', id, env)).toBe(true);
      for (const id of [root, b]) expect(await isOrgUnitWithinScope(p, 'template.manage', id, env)).toBe(false);

      expect([...(await orgSubtreeUuids([{ orgUnitUuid: a, includeDescendants: true }], env))].sort()).toEqual(
        [a, a1, a11].sort(),
      );
      const inScope = await orgUnitsInScope(p, 'template.manage', env);
      expect(inScope.all).toBe(false);
      expect(inScope.all === false && [...inScope.uuids].sort()).toEqual([a, a1, a11].sort());
    }));

  it('without descendants only the unit itself is covered', () =>
    withFreshSchema(async (c, schema) => {
      const env = envFor(c, schema);
      const a = await unit(c, 'A');
      const a1 = await unit(c, 'A1', a);
      const p = manager([{ orgUnitUuid: a, includeDescendants: false }]);
      expect(await isOrgUnitWithinScope(p, 'template.manage', a, env)).toBe(true);
      expect(await isOrgUnitWithinScope(p, 'template.manage', a1, env)).toBe(false);
      expect([...(await orgSubtreeUuids([{ orgUnitUuid: a, includeDescendants: false }], env))]).toEqual([a]);
    }));

  it('null/global scope: global covers everything, an empty scope covers nothing', () =>
    withFreshSchema(async (c, schema) => {
      const env = envFor(c, schema);
      const a = await unit(c, 'A');
      const global = makePrincipal({
        capabilities: ['template.use', 'audit.read'],
        scopes: { 'audit.read': { global: true, roots: [] } },
      });
      expect(await isOrgUnitWithinScope(global, 'audit.read', a, env)).toBe(true);
      expect(await orgUnitsInScope(global, 'audit.read', env)).toEqual({ all: true });
      expect(await isOrgUnitWithinScope(manager([]), 'template.manage', a, env)).toBe(false);
    }));

  it('terminates on a cycle in the parent data', () =>
    withFreshSchema(async (c, schema) => {
      const env = envFor(c, schema);
      const a = await unit(c, 'A');
      const b = await unit(c, 'B', a);
      const x = await unit(c, 'Outside');
      await c.query(`UPDATE org_units SET parent_uuid = $1 WHERE uuid = $2`, [b, a]); // A -> B -> A
      const p = manager([{ orgUnitUuid: a, includeDescendants: true }]);

      expect([...(await orgSubtreeUuids([{ orgUnitUuid: a, includeDescendants: true }], env))].sort()).toEqual(
        [a, b].sort(),
      );
      expect(await isOrgUnitWithinScope(p, 'template.manage', b, env)).toBe(true);
      expect(await isOrgUnitWithinScope(p, 'template.manage', x, env)).toBe(false);
    }));

  it('a self-parent row terminates', () =>
    withFreshSchema(async (c, schema) => {
      const env = envFor(c, schema);
      const a = await unit(c, 'A');
      await c.query(`UPDATE org_units SET parent_uuid = uuid WHERE uuid = $1`, [a]);
      const other = manager([{ orgUnitUuid: UNKNOWN, includeDescendants: true }]);
      expect(await isOrgUnitWithinScope(other, 'template.manage', a, env)).toBe(false);
      expect([...(await orgSubtreeUuids([{ orgUnitUuid: a, includeDescendants: true }], env))]).toEqual([a]);
    }));

  it('handles a deep chain within the depth cap, and does not cover beyond it', () =>
    withFreshSchema(async (c, schema) => {
      const env = envFor(c, schema);
      const top = await unit(c, 'n0');
      let prev = top;
      const ids = [top];
      for (let i = 1; i <= 70; i++) {
        prev = await unit(c, `n${i}`, prev);
        ids.push(prev);
      }
      const p = manager([{ orgUnitUuid: top, includeDescendants: true }]);
      expect(await isOrgUnitWithinScope(p, 'template.manage', ids[50], env)).toBe(true);
      // Fail closed past the cap (MAX_ORG_DEPTH = 64 levels).
      expect(await isOrgUnitWithinScope(p, 'template.manage', ids[70], env)).toBe(false);
      const sub = await orgSubtreeUuids([{ orgUnitUuid: top, includeDescendants: true }], env);
      expect(sub.has(ids[50])).toBe(true);
      expect(sub.has(ids[70])).toBe(false);
    }));

  it('an unknown uuid is not in scope, nor is a root that does not exist', () =>
    withFreshSchema(async (c, schema) => {
      const env = envFor(c, schema);
      const a = await unit(c, 'A');
      expect(await isOrgUnitWithinScope(manager([{ orgUnitUuid: a, includeDescendants: true }]), 'template.manage', UNKNOWN, env)).toBe(false);
      expect(await isOrgUnitWithinScope(manager([{ orgUnitUuid: UNKNOWN, includeDescendants: false }]), 'template.manage', UNKNOWN, env)).toBe(false);
      expect((await orgSubtreeUuids([{ orgUnitUuid: UNKNOWN, includeDescendants: true }], env)).size).toBe(0);
    }));
});
