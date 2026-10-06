// Pure mapping from the parsed (whitelisted) Rollekatalog payloads to the row sets
// the sync writes into the mirror tables. No I/O and no env: the scope settings
// come in as arguments. Everything that can be wrong in fetched data (unknown
// parents, cycles, duplicate ids, assignments for unknown users) is resolved here
// the FAIL-CLOSED way and counted, so sync.ts can apply the result blindly.
import { ROLE_KEYS, type RoleKey } from '@/lib/authz/types';
import type { RkOrganisation, RkUserAssignments } from './schemas';
import { deriveScope } from './scope';
import type { ScopeConstraint, SyncCounts } from './types';

export interface MirrorUser {
  uuid: string;
  extUuid: string | null;
  extUserId: string | null;
  name: string;
  email: string | null;
  disabled: boolean;
}

export interface MirrorOrgUnit {
  uuid: string;
  name: string;
  parentUuid: string | null;
}

/** is_primary is always false (Rollekatalog has no such flag) and title NULL (job titles are not whitelisted). */
export interface MirrorMember {
  directoryUserUuid: string;
  orgUnitUuid: string;
}

export interface MirrorAssignment {
  directoryUserUuid: string;
  roleKey: RoleKey;
  /** NULL = no org unit (global, or tt-bruger). */
  scopeOrgUnitUuid: string | null;
  includeDescendants: boolean;
}

type MapperStats = Pick<
  SyncCounts,
  | 'orgUnitsOrphaned'
  | 'orgUnitCyclesBroken'
  | 'assignmentsIgnoredRole'
  | 'assignmentsSkippedUnknownUser'
  | 'assignmentsWithoutScope'
>;

export interface MirrorSet {
  users: MirrorUser[];
  /** Parents before children, so a chunked insert never references a row that is not there yet. */
  orgUnits: MirrorOrgUnit[];
  members: MirrorMember[];
  assignments: MirrorAssignment[];
  stats: MapperStats;
}

export interface MapperConfig {
  includeDescendants: boolean;
  globalRoles: readonly RoleKey[];
}

export interface MapperInput {
  organisation: RkOrganisation;
  assignments: RkUserAssignments[];
}

const OUR_ROLES: ReadonlySet<string> = new Set(ROLE_KEYS);

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function mapUsers(org: RkOrganisation): MirrorUser[] {
  const users: MirrorUser[] = [];
  const seen = new Set<string>();
  const seenExt = new Set<string>();
  for (const u of org.users) {
    if (seen.has(u.uuid)) continue; // first one wins, deterministically
    seen.add(u.uuid);
    // ext_uuid is UNIQUE: a repeated one would abort the whole sync, so only the first user keeps it.
    const extUuid = u.extUuid && !seenExt.has(u.extUuid) ? u.extUuid : null;
    if (extUuid) seenExt.add(extUuid);
    users.push({
      uuid: u.uuid,
      extUuid,
      extUserId: u.userId,
      name: u.name,
      email: u.email,
      disabled: u.disabled,
    });
  }
  return users;
}

/**
 * Units in parents-first order. A parent that was not fetched becomes NULL
 * (counted as orphaned); every cycle is broken at its smallest uuid (counted), so
 * the stored tree is always a forest.
 */
function mapOrgUnits(org: RkOrganisation): { units: MirrorOrgUnit[]; orphaned: number; cycles: number } {
  const byUuid = new Map<string, MirrorOrgUnit>();
  let orphaned = 0;

  const raw = new Map<string, (typeof org.orgUnits)[number]>();
  for (const u of org.orgUnits) if (!raw.has(u.uuid)) raw.set(u.uuid, u);

  for (const u of [...raw.values()].sort((a, b) => cmp(a.uuid, b.uuid))) {
    let parent = u.parentOrgUnitUuid;
    if (parent && !raw.has(parent)) {
      parent = null;
      orphaned++;
    }
    byUuid.set(u.uuid, {
      uuid: u.uuid,
      name: u.name,
      parentUuid: parent,
    });
  }

  // Cycle breaking: walk up from each unit; a node met again on the same walk closes a cycle.
  let cycles = 0;
  const done = new Set<string>();
  for (const start of [...byUuid.keys()].sort(cmp)) {
    if (done.has(start)) continue;
    const path: string[] = [];
    const onPath = new Set<string>();
    let cur: string | null = start;
    while (cur && !done.has(cur) && !onPath.has(cur)) {
      onPath.add(cur);
      path.push(cur);
      cur = byUuid.get(cur)!.parentUuid;
    }
    if (cur && onPath.has(cur)) {
      const cycle = path.slice(path.indexOf(cur));
      const cut = [...cycle].sort(cmp)[0];
      byUuid.get(cut)!.parentUuid = null;
      cycles++;
    }
    for (const p of path) done.add(p);
  }

  // Parents-first: breadth-first from the roots, siblings in uuid order.
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const u of [...byUuid.values()].sort((a, b) => cmp(a.uuid, b.uuid))) {
    if (u.parentUuid === null) roots.push(u.uuid);
    else (children.get(u.parentUuid) ?? children.set(u.parentUuid, []).get(u.parentUuid)!).push(u.uuid);
  }
  const ordered: MirrorOrgUnit[] = [];
  let level = roots;
  while (level.length > 0) {
    const next: string[] = [];
    for (const id of level) {
      ordered.push(byUuid.get(id)!);
      next.push(...(children.get(id) ?? []));
    }
    level = next;
  }
  return { units: ordered, orphaned, cycles };
}

function mapMembers(org: RkOrganisation, userUuids: ReadonlySet<string>, unitUuids: ReadonlySet<string>): MirrorMember[] {
  const out = new Map<string, MirrorMember>();
  for (const u of org.users) {
    if (!userUuids.has(u.uuid)) continue;
    for (const p of u.positions) {
      if (!unitUuids.has(p.orgUnitUuid)) continue;
      out.set(`${u.uuid}|${p.orgUnitUuid}`, { directoryUserUuid: u.uuid, orgUnitUuid: p.orgUnitUuid });
    }
  }
  return [...out.values()];
}

function mapAssignments(
  input: MapperInput,
  config: MapperConfig,
  users: MirrorUser[],
  unitUuids: ReadonlySet<string>,
): { rows: MirrorAssignment[]; ignoredRole: number; skippedUnknownUser: number; withoutScope: number } {
  const byExt = new Map<string, string>();
  const byUserId = new Map<string, string[]>();
  for (const u of users) {
    if (u.extUuid) byExt.set(u.extUuid, u.uuid);
    if (u.extUserId) {
      const k = u.extUserId.toLowerCase();
      (byUserId.get(k) ?? byUserId.set(k, []).get(k)!).push(u.uuid);
    }
  }
  // An ambiguous userId is never guessed: it counts as an unknown user.
  const resolve = (e: RkUserAssignments): string | null => {
    if (e.extUuid) return byExt.get(e.extUuid) ?? null;
    // userId is only a fallback for entries that carry no extUuid at all. An entry whose
    // extUuid is unknown to the mirror is a DIFFERENT person who merely shares a userId.
    const candidates = e.userId ? byUserId.get(e.userId.toLowerCase()) : undefined;
    return candidates && candidates.length === 1 ? candidates[0] : null;
  };

  let ignoredRole = 0;
  let skippedUnknownUser = 0;
  // One group per (user, role): duplicate entries are unioned (never "unconstrained wins": that could widen a scope).
  const groups = new Map<string, { user: string; role: RoleKey; constraints: ScopeConstraint[] }>();

  for (const entry of input.assignments) {
    const user = resolve(entry);
    for (const a of entry.assignments) {
      const identifier = a.roleIdentifier.trim();
      if (!OUR_ROLES.has(identifier)) {
        ignoredRole++;
        continue;
      }
      if (!user) {
        skippedUnknownUser++;
        continue;
      }
      const role = identifier as RoleKey;
      const key = `${user}|${role}`;
      const group = groups.get(key) ?? groups.set(key, { user, role, constraints: [] }).get(key)!;
      group.constraints.push(...a.roleConstraintValues);
    }
  }

  const rows: MirrorAssignment[] = [];
  let withoutScope = 0;
  for (const g of [...groups.values()].sort((a, b) => cmp(`${a.user}|${a.role}`, `${b.user}|${b.role}`))) {
    const scope = deriveScope({
      roleKey: g.role,
      constraints: g.constraints,
      knownOrgUnitUuids: unitUuids,
      globalRoles: config.globalRoles,
      includeDescendants: config.includeDescendants,
    });
    if (scope.kind === 'none') {
      withoutScope++;
    } else if (scope.kind === 'global') {
      rows.push({ directoryUserUuid: g.user, roleKey: g.role, scopeOrgUnitUuid: null, includeDescendants: true });
    } else {
      for (const unit of scope.orgUnitUuids) {
        rows.push({
          directoryUserUuid: g.user,
          roleKey: g.role,
          scopeOrgUnitUuid: unit,
          includeDescendants: scope.includeDescendants,
        });
      }
    }
  }
  return { rows, ignoredRole, skippedUnknownUser, withoutScope };
}

export function mapToMirror(input: MapperInput, config: MapperConfig): MirrorSet {
  const users = mapUsers(input.organisation);
  const userUuids = new Set(users.map((u) => u.uuid));
  const { units, orphaned, cycles } = mapOrgUnits(input.organisation);
  const unitUuids = new Set(units.map((u) => u.uuid));
  const assignments = mapAssignments(input, config, users, unitUuids);

  return {
    users,
    orgUnits: units,
    members: mapMembers(input.organisation, userUuids, unitUuids),
    assignments: assignments.rows,
    stats: {
      orgUnitsOrphaned: orphaned,
      orgUnitCyclesBroken: cycles,
      assignmentsIgnoredRole: assignments.ignoredRole,
      assignmentsSkippedUnknownUser: assignments.skippedUnknownUser,
      assignmentsWithoutScope: assignments.withoutScope,
    },
  };
}
