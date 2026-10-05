import { pool } from '@/lib/db';
import type { Capability, CapabilityScope, Principal } from './types';

// Org-tree traversal for scoped capabilities. The tree comes from synced or
// hand-entered data, so it can contain cycles. Every walk therefore uses
// UNION (not UNION ALL) and a hard depth cap: bad data terminates, and
// anything deeper than the cap is treated as NOT covered (fail closed).
export const MAX_ORG_DEPTH = 64;

type Root = CapabilityScope['roots'][number];

export interface ScopeEnv {
  query: (text: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  /** Schema-qualified, trusted constant. Overridden only by the Postgres test lane, which runs in a throwaway schema. */
  orgUnitsTable: string;
}

function defaultEnv(): ScopeEnv {
  return { query: (text, params) => pool.query(text, params), orgUnitsTable: 'public.org_units' };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Ids can come from request bodies. Reject malformed ones here instead of
// letting Postgres raise on the ::uuid cast (which would surface as a 500).
function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function normalise(uuid: string): string {
  return uuid.toLowerCase();
}

function validRoots(roots: Root[]): Root[] {
  return roots.filter((r) => isUuid(r.orgUnitUuid)).map((r) => ({ ...r, orgUnitUuid: normalise(r.orgUnitUuid) }));
}

/**
 * Every org unit covered by the given roots (a root itself, plus its subtree
 * when includeDescendants). Roots that do not exist in org_units contribute nothing.
 */
export async function orgSubtreeUuids(roots: Root[], env: ScopeEnv = defaultEnv()): Promise<Set<string>> {
  const valid = validRoots(roots);
  const out = new Set<string>();
  const withDescendants = [...new Set(valid.filter((r) => r.includeDescendants).map((r) => r.orgUnitUuid))];
  const exactOnly = [...new Set(valid.filter((r) => !r.includeDescendants).map((r) => r.orgUnitUuid))];

  if (withDescendants.length > 0) {
    const { rows } = await env.query(
      `WITH RECURSIVE subtree(uuid, depth) AS (
         SELECT uuid, 0 FROM ${env.orgUnitsTable} WHERE uuid = ANY($1::uuid[])
         UNION
         SELECT c.uuid, s.depth + 1
           FROM ${env.orgUnitsTable} c
           JOIN subtree s ON c.parent_uuid = s.uuid
          WHERE s.depth < $2::int
       )
       SELECT DISTINCT uuid FROM subtree`,
      [withDescendants, MAX_ORG_DEPTH],
    );
    for (const r of rows) out.add(normalise(String(r.uuid)));
  }

  if (exactOnly.length > 0) {
    // Existence check, so an id that is not in the tree is "not in scope".
    const { rows } = await env.query(`SELECT uuid FROM ${env.orgUnitsTable} WHERE uuid = ANY($1::uuid[])`, [
      exactOnly,
    ]);
    for (const r of rows) out.add(normalise(String(r.uuid)));
  }

  return out;
}

/** The scope a principal holds for a capability, or null when it holds nothing (disabled, capability missing, no scope entry). */
function scopeOf(principal: Principal, capability: Capability): CapabilityScope | null {
  if (principal.disabled) return null;
  if (!principal.capabilities.includes(capability)) return null;
  return principal.scopes[capability] ?? null;
}

/**
 * Is this org unit inside the caller's scope for the capability? Walks UP from
 * the unit (one short chain) instead of expanding the roots' whole subtrees.
 */
export async function isOrgUnitWithinScope(
  principal: Principal,
  capability: Capability,
  orgUnitUuid: string,
  env: ScopeEnv = defaultEnv(),
): Promise<boolean> {
  const scope = scopeOf(principal, capability);
  if (!scope) return false;
  if (scope.global) return true;
  if (!isUuid(orgUnitUuid)) return false;

  const roots = validRoots(scope.roots);
  if (roots.length === 0) return false;
  const target = normalise(orgUnitUuid);
  const exactRoots = new Set(roots.map((r) => r.orgUnitUuid));
  const descendantRoots = new Set(roots.filter((r) => r.includeDescendants).map((r) => r.orgUnitUuid));

  const { rows } = await env.query(
    `WITH RECURSIVE chain(uuid, parent_uuid, depth) AS (
       SELECT uuid, parent_uuid, 0 FROM ${env.orgUnitsTable} WHERE uuid = $1::uuid
       UNION
       SELECT p.uuid, p.parent_uuid, c.depth + 1
         FROM ${env.orgUnitsTable} p
         JOIN chain c ON p.uuid = c.parent_uuid
        WHERE c.depth < $2::int
     )
     SELECT DISTINCT uuid FROM chain`,
    [target, MAX_ORG_DEPTH],
  );
  // No rows: the unit does not exist.
  const chain = rows.map((r) => normalise(String(r.uuid)));
  if (chain.length === 0) return false;
  if (exactRoots.has(target)) return true;
  return chain.some((u) => u !== target && descendantRoots.has(u));
}

export type OrgUnitsInScope = { all: true } | { all: false; uuids: string[] };

/** Every org unit the caller may act on for the capability; `{ all: true }` for a global scope (no enumeration). */
export async function orgUnitsInScope(
  principal: Principal,
  capability: Capability,
  env: ScopeEnv = defaultEnv(),
): Promise<OrgUnitsInScope> {
  const scope = scopeOf(principal, capability);
  if (!scope) return { all: false, uuids: [] };
  if (scope.global) return { all: true };
  if (scope.roots.length === 0) return { all: false, uuids: [] };
  return { all: false, uuids: [...(await orgSubtreeUuids(scope.roots, env))] };
}
