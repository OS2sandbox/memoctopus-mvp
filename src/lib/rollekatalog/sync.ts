// Full sync from Rollekatalog into the central mirror tables.
//
// Rollekatalog is a READ-ONLY authority here: everything is fetched first (so a
// failed or partial fetch can never touch the mirror), then applied in ONE
// transaction (any failure rolls back, the mirror stays as it was). Only rows with
// source='rollekatalog' are ever written or deleted; source='local' rows and the
// app_user_id link (owned by login matching) are never touched.
//
// A linked user (directory_users.app_user_id) that is left DISABLED has their
// better-auth sessions deleted in the same transaction, so existing cookies die at
// once. The delete is idempotent and runs every time (it also catches a user who was
// disabled earlier and got a session anyway); only source='rollekatalog' rows count.
//
// Safety nets, all fail-closed:
//   - a non-blocking advisory lock: a concurrent run answers 'already_running'
//   - empty-response guard: no users or no org units aborts ('empty_response')
//   - too many invalid rows: more than max(3, 5 %) bad rows in one array fails the fetch
//     ('invalid_response', see schemas.ts) before anything is written. Fewer bad rows are
//     dropped and counted; a dropped user is simply absent, so it goes through the removal
//     threshold like any other missing user.
//   - removal threshold: disabling or deleting too much aborts ('removal_threshold')
//     unless the admin forces it. Three ratios are checked: enabled users disabled, all
//     mirrored assignments removed, and (separately, because tt-bruger rows dominate the
//     total) ELEVATED assignments (every role but tt-bruger) removed.
//
// Every run leaves a sync_runs row and a content-free directory.sync audit event.
// Failures surface as short codes, never as messages (they could echo data).
import { recordEvent } from '@/lib/audit/record';
import { createRunner, errorLabel, type SqlQueryable } from '@/lib/authz/pg-runner';
import { createRollekatalogClient, type RollekatalogClient } from './client';
import {
  rollekatalogConfigIssue,
  scopeDescendants,
  globalRoles,
  syncMaxRemovalPercent,
} from './config';
import { errorCodeOf } from './errors';
import { mapToMirror, type MirrorAssignment, type MirrorOrgUnit, type MirrorSet, type MirrorMember, type MirrorUser } from './mapper';
import type { RkOrganisation, RkRoleAssignments } from './schemas';
import {
  abandonStaleRuns,
  defaultSyncEnv,
  finishRun,
  queryOnce,
  recordFailedRun,
  startRun,
  tbl,
  type SyncEnv,
} from './sync-run';
import { emptySyncCounts, type RunSyncOptions, type SyncCounts, type SyncResult } from './types';

// ─── Planning (pure) ───────────────────────────────────────────────────────

interface ExistingUser {
  uuid: string;
  extUuid: string | null;
  extUserId: string | null;
  name: string;
  email: string | null;
  disabled: boolean;
}
interface ExistingOrgUnit {
  uuid: string;
  name: string;
  parentUuid: string | null;
}
interface ExistingAssignment {
  id: string;
  directoryUserUuid: string;
  roleKey: string;
  scopeOrgUnitUuid: string | null;
  includeDescendants: boolean;
}
/** A directory row (any source) that holds the ext_uuid of a user in this fetch. */
interface ExtHolder {
  uuid: string;
  extUuid: string;
  source: string;
}

/** What is in the mirror now, restricted to source='rollekatalog' data. */
export interface ExistingMirror {
  users: ExistingUser[];
  orgUnits: ExistingOrgUnit[];
  assignments: ExistingAssignment[];
  members: MirrorMember[];
  extHolders: ExtHolder[];
}

interface MirrorPlan {
  users: { insert: MirrorUser[]; update: MirrorUser[]; disable: string[]; releaseExt: string[] };
  orgUnits: { insert: MirrorOrgUnit[]; update: MirrorOrgUnit[] };
  members: { insert: MirrorMember[]; remove: MirrorMember[] };
  assignments: {
    insert: MirrorAssignment[];
    updateIncludeDescendants: Array<{ id: string; includeDescendants: boolean }>;
    remove: string[];
  };
  counts: SyncCounts;
  /** What a guard compares against the percentage: how much would be taken away, out of how much there is. */
  removal: {
    users: { removed: number; base: number };
    assignments: { removed: number; base: number };
    /**
     * Assignments of every role except the baseline tt-bruger. The total above is dominated by
     * one tt-bruger row per user, so losing most administrators would hide in it.
     */
    elevatedAssignments: { removed: number; base: number };
  };
}

/** The baseline role every enabled user holds; every other role is "elevated" for the removal guard. */
const BASELINE_ROLE = 'tt-bruger';
const isElevated = (roleKey: string): boolean => roleKey !== BASELINE_ROLE;

const pairKey = (...parts: Array<string | null>): string => parts.map((p) => p ?? '\u0000').join('|');

/** removed / base > percent, in integers. An empty base can lose nothing. */
export function exceedsRemovalThreshold(removed: number, base: number, percent: number): boolean {
  // Integer form of removed > floor(base * percent / 100) with base >= 1: on a small base
  // (1-2 elevated rows) any removal beyond the allowance trips, so an admin has to force it.
  return base > 0 && removed * 100 > percent * base;
}

export function planMirror(existing: ExistingMirror, mirror: MirrorSet): MirrorPlan {
  const counts = emptySyncCounts();
  counts.orgUnitsOrphaned = mirror.stats.orgUnitsOrphaned;
  counts.orgUnitCyclesBroken = mirror.stats.orgUnitCyclesBroken;
  counts.assignmentsIgnoredRole = mirror.stats.assignmentsIgnoredRole;
  counts.assignmentsSkippedUnknownUser = mirror.stats.assignmentsSkippedUnknownUser;
  counts.assignmentsWithoutScope = mirror.stats.assignmentsWithoutScope;
  counts.usersSkippedInvalid = mirror.stats.usersSkippedInvalid;
  counts.orgUnitsSkippedInvalid = mirror.stats.orgUnitsSkippedInvalid;
  counts.assignmentRowsSkippedInvalid = mirror.stats.assignmentRowsSkippedInvalid;
  counts.membershipsSkippedInvalid = mirror.stats.membershipsSkippedInvalid;

  // ── users ──
  const fetchedUsers = new Set(mirror.users.map((u) => u.uuid));
  const claimant = new Map<string, string>();
  for (const u of mirror.users) if (u.extUuid) claimant.set(u.extUuid, u.uuid);

  // ext_uuid is UNIQUE. A different row that holds the value would abort the whole
  // sync forever: a local row keeps it (the fetched user then has none), a
  // rollekatalog row (renamed or gone upstream) is released.
  const blocked = new Set<string>();
  const releaseExt: string[] = [];
  for (const h of existing.extHolders) {
    const owner = claimant.get(h.extUuid);
    if (!owner || owner === h.uuid) continue;
    if (h.source === 'rollekatalog') releaseExt.push(h.uuid);
    else blocked.add(h.extUuid);
  }
  const users = mirror.users.map((u) => (u.extUuid && blocked.has(u.extUuid) ? { ...u, extUuid: null } : u));

  const existingUsers = new Map(existing.users.map((u) => [u.uuid, u]));
  const userInsert: MirrorUser[] = [];
  const userUpdate: MirrorUser[] = [];
  for (const u of users) {
    const old = existingUsers.get(u.uuid);
    if (!old) {
      userInsert.push(u);
    } else if (
      old.extUuid !== u.extUuid ||
      old.extUserId !== u.extUserId ||
      old.name !== u.name ||
      old.email !== u.email ||
      old.disabled !== u.disabled
    ) {
      userUpdate.push(u);
      if (!old.disabled && u.disabled) counts.usersDisabled++;
    }
  }
  // 'Removed from Rollekatalog' and 'disabled in Rollekatalog' are deliberately not told apart.
  const disable = existing.users.filter((u) => !u.disabled && !fetchedUsers.has(u.uuid)).map((u) => u.uuid);
  counts.usersDisabled += disable.length;
  counts.usersUpserted = userInsert.length + userUpdate.length;

  // ── org units (never deleted: the schema has no stale flag and templates may refer to them) ──
  const existingUnits = new Map(existing.orgUnits.map((u) => [u.uuid, u]));
  const unitInsert: MirrorOrgUnit[] = [];
  const unitUpdate: MirrorOrgUnit[] = [];
  for (const u of mirror.orgUnits) {
    const old = existingUnits.get(u.uuid);
    if (!old) unitInsert.push(u);
    else if (old.name !== u.name || old.parentUuid !== u.parentUuid) unitUpdate.push(u);
  }
  counts.orgUnitsUpserted = unitInsert.length + unitUpdate.length;

  // ── members (derived data: the fetch is the truth) ──
  const memberKey = (m: MirrorMember) => pairKey(m.directoryUserUuid, m.orgUnitUuid);
  const newMembers = new Set(mirror.members.map(memberKey));
  const oldMembers = new Set(existing.members.map(memberKey));

  // ── role assignments ──
  const aKey = (userUuid: string, role: string, scope: string | null) => pairKey(userUuid, role, scope);
  const existingAssignments = new Map(existing.assignments.map((a) => [aKey(a.directoryUserUuid, a.roleKey, a.scopeOrgUnitUuid), a]));
  const newKeys = new Set<string>();
  const aInsert: MirrorAssignment[] = [];
  const aUpdate: Array<{ id: string; includeDescendants: boolean }> = [];
  for (const a of mirror.assignments) {
    const key = aKey(a.directoryUserUuid, a.roleKey, a.scopeOrgUnitUuid);
    newKeys.add(key);
    const old = existingAssignments.get(key);
    if (!old) aInsert.push(a);
    else if (old.includeDescendants !== a.includeDescendants) aUpdate.push({ id: old.id, includeDescendants: a.includeDescendants });
  }
  const aRemove = existing.assignments
    .filter((a) => !newKeys.has(aKey(a.directoryUserUuid, a.roleKey, a.scopeOrgUnitUuid)))
    .map((a) => a.id);
  const removeIds = new Set(aRemove);
  counts.assignmentsUpserted = aInsert.length + aUpdate.length;
  counts.assignmentsRemoved = aRemove.length;

  return {
    users: { insert: userInsert, update: userUpdate, disable, releaseExt },
    orgUnits: { insert: unitInsert, update: unitUpdate },
    members: {
      insert: mirror.members.filter((m) => !oldMembers.has(memberKey(m))),
      remove: existing.members.filter((m) => !newMembers.has(memberKey(m))),
    },
    assignments: { insert: aInsert, updateIncludeDescendants: aUpdate, remove: aRemove },
    counts,
    removal: {
      users: {
        // Everything that goes from enabled to disabled, whichever way it got there.
        removed: disable.length + userUpdate.filter((u) => u.disabled && existingUsers.get(u.uuid)?.disabled === false).length,
        // Only enabled users can be taken away, so only they are the base (stricter than counting already disabled ones).
        base: existing.users.filter((u) => !u.disabled).length,
      },
      assignments: { removed: aRemove.length, base: existing.assignments.length },
      elevatedAssignments: {
        // Rows skipped as invalid are never in the fetch, so they already count as removals here.
        removed: existing.assignments.filter((a) => isElevated(a.roleKey) && removeIds.has(a.id)).length,
        base: existing.assignments.filter((a) => isElevated(a.roleKey)).length,
      },
    },
  };
}

// ─── Applying (SQL) ────────────────────────────────────────────────────────

/** A safety guard stopped the run before anything was written. */
class SyncAbort extends Error {
  constructor(readonly code: 'empty_response' | 'removal_threshold') {
    super(`sync aborted: ${code}`);
    this.name = 'SyncAbort';
  }
}

/** The apply transaction failed (rolled back). Carries a short code only. */
class SyncFailure extends Error {
  constructor(readonly code: string) {
    super(`sync failed: ${code}`);
    this.name = 'SyncFailure';
  }
}

const ORG_UNIT_CHUNK = 1000;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function loadExisting(tx: SqlQueryable, env: SyncEnv, fetchedExtUuids: string[]): Promise<ExistingMirror> {
  const t = (name: string) => tbl(env, name);
  // One statement at a time: a pg client does not support overlapping queries.
  const users = await tx.query<{
    uuid: string;
    ext_uuid: string | null;
    ext_user_id: string | null;
    name: string;
    email: string | null;
    disabled: boolean;
  }>(
    `SELECT uuid::text AS uuid, ext_uuid::text AS ext_uuid, ext_user_id, name, email, disabled
       FROM ${t('directory_users')} WHERE source = 'rollekatalog'`,
  );
  const units = await tx.query<{ uuid: string; name: string; parent_uuid: string | null }>(
    `SELECT uuid::text AS uuid, name, parent_uuid::text AS parent_uuid
       FROM ${t('org_units')} WHERE source = 'rollekatalog'`,
  );
  const assignments = await tx.query<{
    id: string;
    user_uuid: string;
    role_key: string;
    scope: string | null;
    include_descendants: boolean;
  }>(
    `SELECT id::text AS id, directory_user_uuid::text AS user_uuid, role_key,
            scope_org_unit_uuid::text AS scope, include_descendants
       FROM ${t('role_assignments')} WHERE source = 'rollekatalog'`,
  );
  // org_unit_members has no source column: a row is ours when its user is.
  const members = await tx.query<{ u: string; o: string }>(
    `SELECT m.directory_user_uuid::text AS u, m.org_unit_uuid::text AS o
       FROM ${t('org_unit_members')} m
       JOIN ${t('directory_users')} d ON d.uuid = m.directory_user_uuid
      WHERE d.source = 'rollekatalog'`,
  );
  const holders = await tx.query<{ uuid: string; ext_uuid: string; source: string }>(
    `SELECT uuid::text AS uuid, ext_uuid::text AS ext_uuid, source
       FROM ${t('directory_users')} WHERE ext_uuid = ANY($1::uuid[])`,
    [fetchedExtUuids],
  );
  return {
    users: users.rows.map((r) => ({
      uuid: r.uuid,
      extUuid: r.ext_uuid,
      extUserId: r.ext_user_id,
      name: r.name,
      email: r.email,
      disabled: r.disabled,
    })),
    orgUnits: units.rows.map((r) => ({
      uuid: r.uuid,
      name: r.name,
      parentUuid: r.parent_uuid,
    })),
    assignments: assignments.rows.map((r) => ({
      id: r.id,
      directoryUserUuid: r.user_uuid,
      roleKey: r.role_key,
      scopeOrgUnitUuid: r.scope,
      includeDescendants: r.include_descendants,
    })),
    members: members.rows.map((r) => ({ directoryUserUuid: r.u, orgUnitUuid: r.o })),
    extHolders: holders.rows.map((r) => ({ uuid: r.uuid, extUuid: r.ext_uuid, source: r.source })),
  };
}

/** Returns how many sessions were deleted. */
async function writePlan(tx: SqlQueryable, env: SyncEnv, plan: MirrorPlan, mirror: MirrorSet, now: Date): Promise<number> {
  const t = (name: string) => tbl(env, name);
  const userCols = (rows: MirrorUser[]) => [
    rows.map((u) => u.uuid),
    rows.map((u) => u.extUuid),
    rows.map((u) => u.extUserId),
    rows.map((u) => u.name),
    rows.map((u) => u.email),
    rows.map((u) => u.disabled),
  ];
  const UNNEST_USERS = `unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::text[], $6::boolean[]) AS v(uuid, ext_uuid, ext_user_id, name, email, disabled)`;

  // Users. A rollekatalog row that held an ext_uuid someone else now owns lets go of it first.
  if (plan.users.releaseExt.length > 0) {
    await tx.query(
      `UPDATE ${t('directory_users')} SET ext_uuid = NULL, updated_at = $2::timestamptz
        WHERE source = 'rollekatalog' AND uuid = ANY($1::uuid[])`,
      [plan.users.releaseExt, now],
    );
  }
  if (plan.users.disable.length > 0) {
    await tx.query(
      `UPDATE ${t('directory_users')} SET disabled = true, updated_at = $2::timestamptz
        WHERE source = 'rollekatalog' AND uuid = ANY($1::uuid[])`,
      [plan.users.disable, now],
    );
  }
  if (plan.users.insert.length > 0) {
    // DO NOTHING (not UPDATE): a uuid that already belongs to a local row is never ours to write.
    await tx.query(
      `INSERT INTO ${t('directory_users')} (uuid, ext_uuid, ext_user_id, name, email, disabled, source, synced_at)
       SELECT v.uuid, v.ext_uuid, v.ext_user_id, v.name, v.email, v.disabled, 'rollekatalog', $7::timestamptz
         FROM ${UNNEST_USERS}
       ON CONFLICT (uuid) DO NOTHING`,
      [...userCols(plan.users.insert), now],
    );
  }
  if (plan.users.update.length > 0) {
    // app_user_id is not in the SET list on purpose: links belong to login matching.
    await tx.query(
      `UPDATE ${t('directory_users')} d
          SET ext_uuid = v.ext_uuid, ext_user_id = v.ext_user_id, name = v.name,
              email = v.email, disabled = v.disabled, updated_at = $7::timestamptz
         FROM ${UNNEST_USERS}
        WHERE d.uuid = v.uuid AND d.source = 'rollekatalog'`,
      [...userCols(plan.users.update), now],
    );
  }
  await tx.query(
    `UPDATE ${t('directory_users')} SET synced_at = $2::timestamptz
      WHERE source = 'rollekatalog' AND uuid = ANY($1::uuid[])`,
    [mirror.users.map((u) => u.uuid), now],
  );

  // Org units, parents first (the plan keeps the mapper's order), so a chunk never points at a later one.
  const unitCols = (rows: MirrorOrgUnit[]) => [
    rows.map((u) => u.uuid),
    rows.map((u) => u.name),
    rows.map((u) => u.parentUuid),
  ];
  for (const rows of chunk(plan.orgUnits.insert, ORG_UNIT_CHUNK)) {
    await tx.query(
      `INSERT INTO ${t('org_units')} (uuid, name, parent_uuid, source, synced_at)
       SELECT v.uuid, v.name, v.parent_uuid, 'rollekatalog', $4::timestamptz
         FROM unnest($1::uuid[], $2::text[], $3::uuid[]) AS v(uuid, name, parent_uuid)
       ON CONFLICT (uuid) DO NOTHING`,
      [...unitCols(rows), now],
    );
  }
  for (const rows of chunk(plan.orgUnits.update, ORG_UNIT_CHUNK)) {
    await tx.query(
      `UPDATE ${t('org_units')} o
          SET name = v.name, parent_uuid = v.parent_uuid, updated_at = $4::timestamptz
         FROM unnest($1::uuid[], $2::text[], $3::uuid[]) AS v(uuid, name, parent_uuid)
        WHERE o.uuid = v.uuid AND o.source = 'rollekatalog'`,
      [...unitCols(rows), now],
    );
  }
  await tx.query(
    `UPDATE ${t('org_units')} SET synced_at = $2::timestamptz WHERE source = 'rollekatalog' AND uuid = ANY($1::uuid[])`,
    [mirror.orgUnits.map((u) => u.uuid), now],
  );

  // Members (is_primary stays false: Rollekatalog has no such flag; title stays NULL).
  if (plan.members.remove.length > 0) {
    await tx.query(
      `DELETE FROM ${t('org_unit_members')} m
        USING unnest($1::uuid[], $2::uuid[]) AS v(u, o)
        WHERE m.directory_user_uuid = v.u AND m.org_unit_uuid = v.o`,
      [plan.members.remove.map((m) => m.directoryUserUuid), plan.members.remove.map((m) => m.orgUnitUuid)],
    );
  }
  if (plan.members.insert.length > 0) {
    await tx.query(
      `INSERT INTO ${t('org_unit_members')} (directory_user_uuid, org_unit_uuid, is_primary, title)
       SELECT v.u, v.o, false, NULL FROM unnest($1::uuid[], $2::uuid[]) AS v(u, o)
       ON CONFLICT DO NOTHING`,
      [plan.members.insert.map((m) => m.directoryUserUuid), plan.members.insert.map((m) => m.orgUnitUuid)],
    );
  }

  // Role assignments.
  if (plan.assignments.remove.length > 0) {
    await tx.query(`DELETE FROM ${t('role_assignments')} WHERE source = 'rollekatalog' AND id = ANY($1::uuid[])`, [
      plan.assignments.remove,
    ]);
  }
  if (plan.assignments.updateIncludeDescendants.length > 0) {
    await tx.query(
      `UPDATE ${t('role_assignments')} r SET include_descendants = v.inc
         FROM unnest($1::uuid[], $2::boolean[]) AS v(id, inc)
        WHERE r.id = v.id AND r.source = 'rollekatalog'`,
      [
        plan.assignments.updateIncludeDescendants.map((a) => a.id),
        plan.assignments.updateIncludeDescendants.map((a) => a.includeDescendants),
      ],
    );
  }
  if (plan.assignments.insert.length > 0) {
    await tx.query(
      `INSERT INTO ${t('role_assignments')}
         (directory_user_uuid, role_key, scope_org_unit_uuid, include_descendants, source, synced_at)
       SELECT v.u, v.r, v.s, v.inc, 'rollekatalog', $5::timestamptz
         FROM unnest($1::uuid[], $2::text[], $3::uuid[], $4::boolean[]) AS v(u, r, s, inc)
       ON CONFLICT ON CONSTRAINT role_assignments_user_role_scope_source_unique DO NOTHING`,
      [
        plan.assignments.insert.map((a) => a.directoryUserUuid),
        plan.assignments.insert.map((a) => a.roleKey),
        plan.assignments.insert.map((a) => a.scopeOrgUnitUuid),
        plan.assignments.insert.map((a) => a.includeDescendants),
        now,
      ],
    );
  }
  // Every rollekatalog row left now is in this fetch, so all of them are fresh. The
  // staleness rule (ROLE_STALE_MAX_SECONDS) reads this column, so it must advance on
  // every successful run even when nothing changed.
  await tx.query(`UPDATE ${t('role_assignments')} SET synced_at = $1::timestamptz WHERE source = 'rollekatalog'`, [now]);

  // Last, after the users are final: whoever is linked to an app account and disabled loses every session.
  const revoked = await tx.query(
    `DELETE FROM ${t('sessions')}
      WHERE user_id IN (
        SELECT app_user_id FROM ${t('directory_users')}
         WHERE source = 'rollekatalog' AND disabled = true AND app_user_id IS NOT NULL
      )`,
  );
  return revoked.rowCount ?? 0;
}

interface ApplyOptions {
  force: boolean;
  maxRemovalPercent: number;
  now: Date;
}

/** Reads, plans, applies the guards and writes, all in one transaction. Throws SyncAbort (nothing written) or SyncFailure. */
async function applyMirror(env: SyncEnv, mirror: MirrorSet, opts: ApplyOptions): Promise<SyncCounts> {
  const runner = createRunner({ query: (text, params) => queryOnce(env, text, params) }, () => env.connect());
  try {
    return await runner.transaction(async (tx) => {
      const existing = await loadExisting(tx, env, mirror.users.flatMap((u) => (u.extUuid ? [u.extUuid] : [])));
      const plan = planMirror(existing, mirror);

      if (!opts.force) {
        const { users, assignments, elevatedAssignments: elevated } = plan.removal;
        if (
          exceedsRemovalThreshold(users.removed, users.base, opts.maxRemovalPercent) ||
          exceedsRemovalThreshold(assignments.removed, assignments.base, opts.maxRemovalPercent) ||
          exceedsRemovalThreshold(elevated.removed, elevated.base, opts.maxRemovalPercent)
        ) {
          // Numbers only; the admin decides about force from the Rollekatalog side.
          console.warn(
            `[rollekatalog] sync aborted code=removal_threshold users=${users.removed}/${users.base} assignments=${assignments.removed}/${assignments.base} elevated=${elevated.removed}/${elevated.base}`,
          );
          throw new SyncAbort('removal_threshold');
        }
      }
      plan.counts.sessionsRevoked = await writePlan(tx, env, plan, mirror, opts.now);
      return plan.counts;
    });
  } catch (err) {
    if (err instanceof SyncAbort) throw err;
    console.warn(`[rollekatalog] sync apply failed (${errorLabel(err)})`);
    throw new SyncFailure('db_error');
  }
}

// ─── Fetching ──────────────────────────────────────────────────────────────

type SyncClient = Pick<RollekatalogClient, 'getOrganisation' | 'getRoleAssignments'>;

interface Fetched {
  organisation: RkOrganisation;
  assignments: RkRoleAssignments;
}

/** Sequential on purpose: organisation v3 is a heavy, synchronized call on the Rollekatalog side. */
async function fetchAll(client: SyncClient): Promise<Fetched> {
  const organisation = await client.getOrganisation();
  // Checked before the other calls: an empty answer must never become "everybody left".
  if (organisation.users.length === 0 || organisation.orgUnits.length === 0) throw new SyncAbort('empty_response');

  const assignments = await client.getRoleAssignments();
  return { organisation, assignments };
}

// ─── Advisory lock ─────────────────────────────────────────────────────────

interface Lock {
  release(): Promise<void>;
}

// One lock per schema, so the throwaway schemas of the Postgres test lane never block each other.
const lockKey = (env: SyncEnv): string => `os2taletiltekst.rollekatalog.sync:${env.schema}`;

/** Non-blocking. The lock lives on one dedicated connection that is held for the whole run. */
async function tryLock(env: SyncEnv): Promise<Lock | null> {
  const client = await env.connect();
  let ok: boolean;
  try {
    const res = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS ok', [lockKey(env)]);
    ok = res.rows[0]?.ok === true;
  } catch (err) {
    client.release(true);
    throw err;
  }
  if (!ok) {
    client.release();
    return null;
  }
  return {
    async release() {
      let destroy = false;
      try {
        const res = await client.query<{ ok: boolean }>('SELECT pg_advisory_unlock(hashtext($1)::bigint) AS ok', [lockKey(env)]);
        if (res.rows[0]?.ok !== true) destroy = true;
      } catch {
        destroy = true;
      } finally {
        // Destroying the connection ends the session, which drops the lock as a last resort.
        client.release(destroy || undefined);
      }
    },
  };
}

// ─── Audit ─────────────────────────────────────────────────────────────────

async function defaultAudit(opts: RunSyncOptions, result: SyncResult): Promise<void> {
  const c = result.counts;
  await recordEvent({
    type: 'directory.sync',
    source: opts.trigger === 'cron' ? 'system' : 'server',
    // Losing the advisory lock is not a failure: the other run does the work.
    outcome: result.status === 'success' ? 'success' : result.status === 'already_running' ? 'denied' : 'error',
    ...(opts.actorUserId ? { actorUserId: opts.actorUserId } : {}),
    entityType: 'sync_run',
    ...(result.runId ? { entityId: result.runId } : {}),
    details: {
      trigger: opts.trigger,
      status: result.status,
      forced: opts.force === true,
      ...c,
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    },
  });
}

// ─── Entry point ───────────────────────────────────────────────────────────

export interface SyncDeps {
  /** Test seam: the database (schema and connections). Production uses the app pool and `public`. */
  env?: SyncEnv;
  /** Test seam: the Rollekatalog client. Production reads URL, keys and limits from the environment. */
  client?: SyncClient;
  now?: () => Date;
  /** Test seam: the audit writer. Production records directory.sync best-effort. */
  audit?: (opts: RunSyncOptions, result: SyncResult) => Promise<void>;
}

function classify(err: unknown): { status: 'aborted' | 'error'; code: string } {
  if (err instanceof SyncAbort) return { status: 'aborted', code: err.code };
  if (err instanceof SyncFailure) return { status: 'error', code: err.code };
  return { status: 'error', code: errorCodeOf(err) };
}

/**
 * Runs one full sync. Never throws: every outcome is a SyncResult. Counts are
 * those of the applied run; a run that aborted or failed changed nothing, so its
 * counts stay zero.
 */
export async function runSync(opts: RunSyncOptions, deps: SyncDeps = {}): Promise<SyncResult> {
  const env = deps.env ?? defaultSyncEnv();
  const now = deps.now ?? (() => new Date());
  const audit = deps.audit ?? defaultAudit;
  const finish = async (result: SyncResult): Promise<SyncResult> => {
    try {
      await audit(opts, result);
    } catch {
      // The audit write is best-effort (recordEvent already reports a content-free warning).
    }
    return result;
  };

  let lock: Lock | null = null;
  let runId: string | null = null;
  try {
    const issue = rollekatalogConfigIssue();
    if (issue) {
      runId = await recordFailedRun(env, issue, now()).catch(() => null);
      return await finish({ status: 'error', runId, counts: emptySyncCounts(), errorCode: issue });
    }

    lock = await tryLock(env);
    if (!lock) {
      return await finish({ status: 'already_running', runId: null, counts: emptySyncCounts(), errorCode: 'already_running' });
    }

    await abandonStaleRuns(env, now());
    runId = await startRun(env, now());

    const client = deps.client ?? createRollekatalogClient();
    const fetched = await fetchAll(client);
    const mirror = mapToMirror(fetched, {
      includeDescendants: scopeDescendants(),
      globalRoles: globalRoles(),
    });
    const counts = await applyMirror(env, mirror, {
      force: opts.force === true,
      maxRemovalPercent: syncMaxRemovalPercent(),
      now: now(),
    });

    // The data is committed: a failure to close the row must not turn the run into an error.
    await finishRun(env, runId, 'success', counts, null, now()).catch(() => {});
    return await finish({ status: 'success', runId, counts, errorCode: null });
  } catch (err) {
    const { status, code } = classify(err);
    console.warn(`[rollekatalog] sync ${status} code=${code}`);
    if (runId) await finishRun(env, runId, 'failed', emptySyncCounts(), code, now()).catch(() => {});
    return await finish({ status, runId, counts: emptySyncCounts(), errorCode: code });
  } finally {
    if (lock) await lock.release().catch(() => {});
  }
}
