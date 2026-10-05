// Service layer of the LOCAL access provider: the only code that mutates the
// central access tables on behalf of an admin. Every mutation runs in one
// transaction together with its audit-seam call, so Phase 2 can make the audit
// row commit or roll back with the change.
//
// Raw, public.-qualified SQL through the SqlRunner seam (same as bootstrap.ts),
// not Drizzle builders: the guard logic below depends on FOR UPDATE / FOR SHARE
// and advisory locks, and the unit tests fake the runner while the *.pg.test.ts
// lane runs the same code against a real Postgres.
import { recordAdminAction } from '@/lib/audit/seam';
import { USABLE_LOCAL_ADMIN_SQL, activeSql } from './admin-sql';
import { ConflictError, NotFoundError, ReadOnlyModeError, ValidationError } from './access-errors';
import { isRoleKey } from './capabilities';
import { roleScopeRule } from './role-rules';
import { accessSource } from './config';
import { defaultRunner, type SqlQueryable, type SqlRunner } from './pg-runner';
import type { RoleKey } from './types';

// Same name as bootstrap.ts on purpose: bootstrap grants and revokes serialise
// on one lock, so "the last administrator" is decided against one consistent view.
const ADMIN_LOCK = 'referat:bootstrap-admin';
// Serialises tree moves: two concurrent "A under B" / "B under A" must not both pass the cycle check.
const ORG_TREE_LOCK = 'referat:org-tree';
const ADMIN_ROLE: RoleKey = 'tt-administrator';

const MAX_MEMBERS = 1000;
const MAX_NAME_LENGTH = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const ACTIVE_SQL = activeSql;

// ─── Views (the only shapes that leave this module) ────────────────────────

export interface AssignmentView {
  id: string;
  roleKey: string;
  scopeOrgUnitUuid: string | null;
  scopeOrgUnitName: string | null;
  includeDescendants: boolean;
  startDate: string | null;
  stopDate: string | null;
  source: string;
  active: boolean;
}

export interface AppUserView {
  id: string;
  name: string;
  email: string;
  directoryUserUuid: string | null;
  disabled: boolean;
  roles: AssignmentView[];
}

export interface OrgUnitView {
  uuid: string;
  name: string;
  parentUuid: string | null;
  source: string;
  memberCount: number;
}

export interface OrgUnitMemberView {
  directoryUserUuid: string;
  appUserId: string | null;
  name: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Defence in depth: the routes check this first, but the service must not rely on its callers. */
export function assertLocalMode(): void {
  if (accessSource() !== 'local') throw new ReadOnlyModeError();
}

const iso = (d: unknown): string | null => (d instanceof Date ? d.toISOString() : d == null ? null : String(d));

async function inTx<T>(runner: SqlRunner, fn: (tx: SqlQueryable) => Promise<T>): Promise<T> {
  try {
    return await runner.transaction(fn);
  } catch (err) {
    // A concurrent change tripped an FK / unique / check constraint after our own checks passed.
    const code = (err as { code?: unknown } | null)?.code;
    if (code === '23503' || code === '23505') {
      throw new ConflictError('Ændringen kolliderede med en samtidig ændring. Prøv igen.', 'concurrent_change');
    }
    if (code === '23514') throw new ValidationError('Ugyldige værdier', 'invalid');
    throw err;
  }
}

const advisoryLock = (tx: SqlQueryable, name: string) =>
  tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [name]);

/** Local rows only: a row that Rollekatalog synced is never edited here, whatever the current mode. */
function assertLocalRow(source: unknown, message: string): void {
  if (source !== 'local') throw new ConflictError(message, 'not_local');
}

// ─── Pure validation ───────────────────────────────────────────────────────

export interface GrantShape {
  roleKey: string;
  scopeOrgUnitUuid: string | null;
  startDate: Date | null;
  stopDate: Date | null;
}

/**
 * Role/scope/date rules, derived from the role matrix (capabilities.ts) via
 * roleScopeRule so they cannot drift from it: a role with no scoped capability
 * or with administrative power takes no scope (global only); a role with scoped
 * capabilities that may not be global needs one; the rest may have one.
 */
export function validateGrantShape(input: GrantShape): RoleKey {
  const { roleKey, scopeOrgUnitUuid, startDate, stopDate } = input;
  if (!isRoleKey(roleKey)) throw new ValidationError('Ukendt rolle', 'unknown_role');

  const rule = roleScopeRule(roleKey);
  if (scopeOrgUnitUuid !== null) {
    if (rule === 'forbidden') {
      throw new ValidationError('Rollen kan ikke begrænses til en organisationsenhed', 'scope_forbidden');
    }
    if (!isUuid(scopeOrgUnitUuid)) throw new ValidationError('Ugyldig organisationsenhed', 'invalid_scope');
  } else if (rule === 'required') {
    throw new ValidationError('Rollen kræver en organisationsenhed', 'scope_required');
  }

  for (const d of [startDate, stopDate]) {
    if (d !== null && Number.isNaN(d.getTime())) throw new ValidationError('Ugyldig dato', 'invalid_date');
  }
  if (startDate && stopDate && stopDate.getTime() <= startDate.getTime()) {
    throw new ValidationError('Slutdato skal ligge efter startdato', 'invalid_date_range');
  }
  return roleKey;
}

// ─── Users and roles ───────────────────────────────────────────────────────

export interface ListUsersOptions {
  /** Case-insensitive substring of name or email. */
  q?: string;
  limit?: number;
}

const DEFAULT_USER_LIMIT = 200;
const MAX_USER_LIMIT = 500;

const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, '\\$&')}%`;

export async function listAppUsersWithRoles(
  opts: ListUsersOptions = {},
  runner: SqlRunner = defaultRunner(),
): Promise<AppUserView[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_USER_LIMIT), 1), MAX_USER_LIMIT);
  const q = opts.q?.trim();
  // LIMIT must cap users, not joined rows, hence the CTE.
  const { rows } = await runner.query<Record<string, unknown>>(
    `WITH page AS (
       SELECT u.id, u.name, u.email FROM public.users u
        WHERE ($1::text IS NULL OR u.name ILIKE $1 OR u.email ILIKE $1)
        ORDER BY lower(u.name), u.id
        LIMIT $2::int
     )
     SELECT p.id, p.name, p.email,
            du.uuid AS directory_user_uuid, du.disabled,
            ra.id AS assignment_id, ra.role_key, ra.scope_org_unit_uuid, ou.name AS scope_name,
            ra.include_descendants, ra.start_date, ra.stop_date, ra.source AS assignment_source,
            (ra.id IS NOT NULL AND ${ACTIVE_SQL('ra')}) AS active
       FROM page p
       LEFT JOIN public.directory_users du ON du.app_user_id = p.id
       LEFT JOIN public.role_assignments ra ON ra.directory_user_uuid = du.uuid
       LEFT JOIN public.org_units ou ON ou.uuid = ra.scope_org_unit_uuid
      ORDER BY lower(p.name), p.id, ra.role_key, ra.id`,
    [q ? likePattern(q) : null, limit],
  );

  const byId = new Map<string, AppUserView>();
  for (const r of rows) {
    const id = String(r.id);
    let user = byId.get(id);
    if (!user) {
      user = {
        id,
        name: String(r.name),
        email: String(r.email),
        directoryUserUuid: (r.directory_user_uuid as string | null) ?? null,
        disabled: r.disabled === true,
        roles: [],
      };
      byId.set(id, user);
    }
    if (r.assignment_id) {
      user.roles.push({
        id: String(r.assignment_id),
        roleKey: String(r.role_key),
        scopeOrgUnitUuid: (r.scope_org_unit_uuid as string | null) ?? null,
        scopeOrgUnitName: (r.scope_name as string | null) ?? null,
        includeDescendants: r.include_descendants === true,
        startDate: iso(r.start_date),
        stopDate: iso(r.stop_date),
        source: String(r.assignment_source),
        active: r.active === true,
      });
    }
  }
  return [...byId.values()];
}

async function assignmentView(tx: SqlQueryable, id: string): Promise<AssignmentView> {
  const { rows } = await tx.query<Record<string, unknown>>(
    `SELECT ra.id, ra.role_key, ra.scope_org_unit_uuid, ou.name AS scope_name, ra.include_descendants,
            ra.start_date, ra.stop_date, ra.source, (${ACTIVE_SQL('ra')}) AS active
       FROM public.role_assignments ra
       LEFT JOIN public.org_units ou ON ou.uuid = ra.scope_org_unit_uuid
      WHERE ra.id = $1::uuid`,
    [id],
  );
  const r = rows[0];
  if (!r) throw new NotFoundError('Rolletildelingen findes ikke');
  return {
    id: String(r.id),
    roleKey: String(r.role_key),
    scopeOrgUnitUuid: (r.scope_org_unit_uuid as string | null) ?? null,
    scopeOrgUnitName: (r.scope_name as string | null) ?? null,
    includeDescendants: r.include_descendants === true,
    startDate: iso(r.start_date),
    stopDate: iso(r.stop_date),
    source: String(r.source),
    active: r.active === true,
  };
}

/**
 * Directory rows for app users, created (source 'local') where missing. This is
 * the ONLY way local mode ties a role to a person: directly via app_user_id,
 * never by matching on email.
 */
async function ensureDirectoryUsers(
  tx: SqlQueryable,
  appUserIds: string[],
  actorUserId: string,
): Promise<Map<string, { uuid: string; disabled: boolean }>> {
  const out = new Map<string, { uuid: string; disabled: boolean }>();
  if (appUserIds.length === 0) return out;

  const created = await tx.query<{ uuid: string }>(
    `INSERT INTO public.directory_users (name, email, source, app_user_id)
     SELECT name, email, 'local', id FROM public.users WHERE id = ANY($1::text[])
     ON CONFLICT (app_user_id) DO NOTHING
     RETURNING uuid`,
    [appUserIds],
  );
  for (const c of created.rows) {
    await recordAdminAction(tx, {
      type: 'access.user_create',
      actorUserId,
      entityType: 'directory_user',
      entityId: c.uuid,
      details: { source: 'local' },
    });
  }

  const all = await tx.query<{ uuid: string; app_user_id: string; disabled: boolean }>(
    'SELECT uuid, app_user_id, disabled FROM public.directory_users WHERE app_user_id = ANY($1::text[])',
    [appUserIds],
  );
  for (const r of all.rows) out.set(r.app_user_id, { uuid: r.uuid, disabled: r.disabled });
  return out;
}

export interface GrantRoleInput {
  appUserId: string;
  roleKey: string;
  scopeOrgUnitUuid?: string | null;
  includeDescendants?: boolean;
  startDate?: Date | null;
  stopDate?: Date | null;
  actorUserId: string;
}

export async function grantRole(input: GrantRoleInput, runner: SqlRunner = defaultRunner()): Promise<AssignmentView> {
  assertLocalMode();
  const scope = input.scopeOrgUnitUuid ? input.scopeOrgUnitUuid.toLowerCase() : null;
  const startDate = input.startDate ?? null;
  const stopDate = input.stopDate ?? null;
  const roleKey = validateGrantShape({ roleKey: input.roleKey, scopeOrgUnitUuid: scope, startDate, stopDate });
  // Without a scope the flag has no meaning; store the column default.
  const includeDescendants = scope === null ? true : (input.includeDescendants ?? true);

  return inTx(runner, async (tx) => {
    const user = await tx.query('SELECT 1 FROM public.users WHERE id = $1', [input.appUserId]);
    if (user.rows.length === 0) throw new NotFoundError('Brugeren findes ikke', 'user_not_found');

    if (scope !== null) {
      // FOR SHARE: a concurrent deleteOrgUnit (FOR UPDATE) waits for us, so it
      // cannot cascade-delete the assignment we are about to insert.
      const unit = await tx.query('SELECT 1 FROM public.org_units WHERE uuid = $1::uuid FOR SHARE', [scope]);
      if (unit.rows.length === 0) throw new NotFoundError('Organisationsenheden findes ikke', 'org_unit_not_found');
    }

    const dir = (await ensureDirectoryUsers(tx, [input.appUserId], input.actorUserId)).get(input.appUserId);
    if (!dir) throw new NotFoundError('Brugeren findes ikke', 'user_not_found');
    if (dir.disabled) throw new ConflictError('Brugeren er deaktiveret', 'user_disabled');

    // DO NOTHING covers the NULLS NOT DISTINCT key, so a repeated global grant conflicts too.
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO public.role_assignments
         (directory_user_uuid, role_key, scope_org_unit_uuid, include_descendants, source, start_date, stop_date, created_by_user_id)
       VALUES ($1::uuid, $2, $3::uuid, $4, 'local', $5, $6, $7)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [dir.uuid, roleKey, scope, includeDescendants, startDate, stopDate, input.actorUserId],
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new ConflictError('Rollen er allerede tildelt', 'already_assigned');

    await recordAdminAction(tx, {
      type: 'access.role_assign',
      actorUserId: input.actorUserId,
      entityType: 'role_assignment',
      entityId: id,
      secondaryEntityType: 'directory_user',
      secondaryEntityId: dir.uuid,
      details: { roleKey, scopeOrgUnitUuid: scope, includeDescendants },
    });
    return assignmentView(tx, id);
  });
}

export async function revokeAssignment(
  id: string,
  actorUserId: string,
  runner: SqlRunner = defaultRunner(),
): Promise<void> {
  assertLocalMode();
  if (!isUuid(id)) throw new NotFoundError('Rolletildelingen findes ikke');
  const assignmentId = id.toLowerCase();

  await inTx(runner, async (tx) => {
    // The lock comes first, so every later statement (fresh READ COMMITTED
    // snapshot) sees the other revoke's committed delete. Without it two admins
    // revoking each other both count "one other admin left" and both succeed.
    await advisoryLock(tx, ADMIN_LOCK);

    const found = await tx.query<Record<string, unknown>>(
      `SELECT ra.id, ra.role_key, ra.source, ra.directory_user_uuid, ra.scope_org_unit_uuid,
              du.app_user_id, (${ACTIVE_SQL('ra')}) AS active
         FROM public.role_assignments ra
         JOIN public.directory_users du ON du.uuid = ra.directory_user_uuid
        WHERE ra.id = $1::uuid
          FOR UPDATE OF ra`,
      [assignmentId],
    );
    const row = found.rows[0];
    if (!row) throw new NotFoundError('Rolletildelingen findes ikke');
    assertLocalRow(row.source, 'Rolletildelingen styres af Rollekatalog og kan ikke fjernes her');

    // A scoped admin row (legacy or synced) grants no access.manage, so removing it cannot lock anyone out.
    if (row.role_key === ADMIN_ROLE && row.active === true && row.scope_org_unit_uuid === null) {
      // Same definition of "usable administrator" as the bootstrap check
      // (admin-sql.ts): that is the set that can still reach this UI after the
      // revoke. A synced admin may vanish with the next sync, so it does not
      // make the last local one expendable.
      const others = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM public.role_assignments ra
           JOIN public.directory_users du ON du.uuid = ra.directory_user_uuid
          WHERE ${USABLE_LOCAL_ADMIN_SQL} AND ra.id <> $1::uuid`,
        [assignmentId],
      );
      if ((others.rows[0]?.n ?? 0) === 0) {
        const own = row.app_user_id === actorUserId;
        throw new ConflictError(
          own
            ? 'Du kan ikke fjerne din egen administratorrolle, når du er den sidste administrator'
            : 'Den sidste administrator kan ikke fjernes',
          'last_administrator',
        );
      }
    }

    await tx.query('DELETE FROM public.role_assignments WHERE id = $1::uuid', [assignmentId]);
    await recordAdminAction(tx, {
      type: 'access.role_revoke',
      actorUserId,
      entityType: 'role_assignment',
      entityId: assignmentId,
      secondaryEntityType: 'directory_user',
      secondaryEntityId: String(row.directory_user_uuid),
      details: { roleKey: String(row.role_key), scopeOrgUnitUuid: (row.scope_org_unit_uuid as string | null) ?? null },
    });
  });
}

// ─── Organisation ──────────────────────────────────────────────────────────

function cleanName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new ValidationError('Navn er påkrævet', 'name_required');
  if (trimmed.length > MAX_NAME_LENGTH) throw new ValidationError('Navnet er for langt', 'name_too_long');
  return trimmed;
}

function orgUnitView(r: Record<string, unknown>, memberCount = 0): OrgUnitView {
  return {
    uuid: String(r.uuid),
    name: String(r.name),
    parentUuid: (r.parent_uuid as string | null) ?? null,
    source: String(r.source),
    memberCount: typeof r.member_count === 'number' ? r.member_count : memberCount,
  };
}

/**
 * Flat list, tree-friendly (each row names its parent). With `uuids` only those
 * units are returned and a parent outside that set is hidden (parentUuid null),
 * so a scoped reader learns nothing about units above its scope.
 */
export async function listOrgUnits(
  opts: { uuids?: readonly string[] } = {},
  runner: SqlRunner = defaultRunner(),
): Promise<OrgUnitView[]> {
  if (opts.uuids && opts.uuids.length === 0) return [];
  const restrict = opts.uuids ? 'WHERE o.uuid = ANY($1::uuid[])' : '';
  const { rows } = await runner.query<Record<string, unknown>>(
    `SELECT o.uuid, o.name, o.parent_uuid, o.source,
            (SELECT count(*)::int FROM public.org_unit_members m WHERE m.org_unit_uuid = o.uuid) AS member_count
       FROM public.org_units o ${restrict}
      ORDER BY lower(o.name), o.uuid`,
    opts.uuids ? [[...opts.uuids].filter(isUuid)] : [],
  );
  const visible = new Set(rows.map((r) => String(r.uuid)));
  return rows.map((r) => {
    const view = orgUnitView(r);
    if (opts.uuids && view.parentUuid !== null && !visible.has(view.parentUuid)) view.parentUuid = null;
    return view;
  });
}

export async function createOrgUnit(
  input: { name: string; parentUuid?: string | null; actorUserId: string },
  runner: SqlRunner = defaultRunner(),
): Promise<OrgUnitView> {
  assertLocalMode();
  const name = cleanName(input.name);
  const parent = input.parentUuid ? input.parentUuid.toLowerCase() : null;
  if (parent !== null && !isUuid(parent)) throw new ValidationError('Ugyldig overordnet enhed', 'invalid_parent');

  return inTx(runner, async (tx) => {
    if (parent !== null) {
      // FOR SHARE: a concurrent delete of the parent waits instead of orphaning us.
      const p = await tx.query('SELECT 1 FROM public.org_units WHERE uuid = $1::uuid FOR SHARE', [parent]);
      if (p.rows.length === 0) throw new NotFoundError('Den overordnede enhed findes ikke', 'parent_not_found');
    }
    const { rows } = await tx.query<Record<string, unknown>>(
      `INSERT INTO public.org_units (name, parent_uuid, source) VALUES ($1, $2::uuid, 'local')
       RETURNING uuid, name, parent_uuid, source`,
      [name, parent],
    );
    const view = orgUnitView(rows[0]);
    await recordAdminAction(tx, {
      type: 'access.org_unit_create',
      actorUserId: input.actorUserId,
      entityType: 'org_unit',
      entityId: view.uuid,
      ...(parent ? { secondaryEntityType: 'org_unit' as const, secondaryEntityId: parent } : {}),
    });
    return view;
  });
}

export async function updateOrgUnit(
  uuid: string,
  patch: { name?: string; parentUuid?: string | null },
  actorUserId: string,
  runner: SqlRunner = defaultRunner(),
): Promise<OrgUnitView> {
  assertLocalMode();
  if (!isUuid(uuid)) throw new NotFoundError('Enheden findes ikke');
  const id = uuid.toLowerCase();
  const name = patch.name === undefined ? undefined : cleanName(patch.name);
  const parent = patch.parentUuid === undefined ? undefined : patch.parentUuid ? patch.parentUuid.toLowerCase() : null;
  if (parent && !isUuid(parent)) throw new ValidationError('Ugyldig overordnet enhed', 'invalid_parent');
  if (name === undefined && parent === undefined) throw new ValidationError('Ingen ændringer angivet', 'empty_patch');
  if (parent === id) throw new ValidationError('En enhed kan ikke være sin egen overordnede', 'self_parent');

  return inTx(runner, async (tx) => {
    if (parent !== undefined) await advisoryLock(tx, ORG_TREE_LOCK);

    const cur = await tx.query<Record<string, unknown>>(
      'SELECT uuid, name, parent_uuid, source FROM public.org_units WHERE uuid = $1::uuid FOR UPDATE',
      [id],
    );
    const unit = cur.rows[0];
    if (!unit) throw new NotFoundError('Enheden findes ikke');
    assertLocalRow(unit.source, 'Enheden styres af Rollekatalog og kan ikke ændres her');

    const nameChanged = name !== undefined && name !== unit.name;
    const parentChanged = parent !== undefined && parent !== ((unit.parent_uuid as string | null) ?? null);

    if (parentChanged && parent !== null && parent !== undefined) {
      const p = await tx.query('SELECT 1 FROM public.org_units WHERE uuid = $1::uuid FOR SHARE', [parent]);
      if (p.rows.length === 0) throw new NotFoundError('Den overordnede enhed findes ikke', 'parent_not_found');
      // Cycle prevention: walk UP from the new parent; if this unit is on that
      // path, the move would close a loop. Deliberately NOT the depth-capped
      // subtree walk used for scope reads: a cap that is fail-closed there
      // would be fail-open here (a parent deeper than the cap looks "outside").
      // UNION (not ALL) over (uuid, parent_uuid) pairs ends the walk even on
      // data that already contains a cycle.
      const cyclic = await tx.query(
        `WITH RECURSIVE ancestors(uuid, parent_uuid) AS (
           SELECT uuid, parent_uuid FROM public.org_units WHERE uuid = $1::uuid
           UNION
           SELECT p.uuid, p.parent_uuid FROM public.org_units p JOIN ancestors a ON p.uuid = a.parent_uuid
         )
         SELECT 1 FROM ancestors WHERE uuid = $2::uuid LIMIT 1`,
        [parent, id],
      );
      if (cyclic.rows.length > 0) {
        throw new ConflictError('Enheden kan ikke flyttes ind under sig selv eller en af sine underenheder', 'cycle');
      }
    }

    if (!nameChanged && !parentChanged) return orgUnitView(unit);

    const sets: string[] = [];
    const params: unknown[] = [id];
    if (nameChanged) {
      params.push(name);
      sets.push(`name = $${params.length}`);
    }
    if (parentChanged) {
      params.push(parent);
      sets.push(`parent_uuid = $${params.length}::uuid`);
    }
    const updated = await tx.query<Record<string, unknown>>(
      `UPDATE public.org_units SET ${sets.join(', ')}, updated_at = now() WHERE uuid = $1::uuid
       RETURNING uuid, name, parent_uuid, source`,
      params,
    );
    await recordAdminAction(tx, {
      type: 'access.org_unit_update',
      actorUserId,
      entityType: 'org_unit',
      entityId: id,
      ...(parentChanged && parent ? { secondaryEntityType: 'org_unit' as const, secondaryEntityId: parent } : {}),
      details: { nameChanged, parentChanged },
    });
    return orgUnitView(updated.rows[0]);
  });
}

export async function deleteOrgUnit(
  uuid: string,
  actorUserId: string,
  runner: SqlRunner = defaultRunner(),
): Promise<void> {
  assertLocalMode();
  if (!isUuid(uuid)) throw new NotFoundError('Enheden findes ikke');
  const id = uuid.toLowerCase();

  await inTx(runner, async (tx) => {
    // FOR UPDATE first: concurrent grants/creates under this unit take FOR SHARE
    // and wait, so the two checks below cannot be invalidated before the DELETE.
    const cur = await tx.query<{ source: string }>(
      'SELECT source FROM public.org_units WHERE uuid = $1::uuid FOR UPDATE',
      [id],
    );
    if (!cur.rows[0]) throw new NotFoundError('Enheden findes ikke');
    assertLocalRow(cur.rows[0].source, 'Enheden styres af Rollekatalog og kan ikke slettes her');

    const children = await tx.query('SELECT 1 FROM public.org_units WHERE parent_uuid = $1::uuid LIMIT 1', [id]);
    if (children.rows.length > 0) throw new ConflictError('Enheden har underenheder', 'has_children');
    // The FK would cascade-delete these (possibly an administrator's own scope), so refuse instead.
    const assigned = await tx.query(
      'SELECT 1 FROM public.role_assignments WHERE scope_org_unit_uuid = $1::uuid LIMIT 1',
      [id],
    );
    if (assigned.rows.length > 0) {
      throw new ConflictError('Enheden har rolletildelinger. Fjern dem først.', 'has_role_assignments');
    }

    await tx.query('DELETE FROM public.org_units WHERE uuid = $1::uuid', [id]);
    await recordAdminAction(tx, {
      type: 'access.org_unit_delete',
      actorUserId,
      entityType: 'org_unit',
      entityId: id,
    });
  });
}

export async function listOrgUnitMembers(
  uuid: string,
  runner: SqlRunner = defaultRunner(),
): Promise<OrgUnitMemberView[]> {
  if (!isUuid(uuid)) throw new NotFoundError('Enheden findes ikke');
  const unit = await runner.query('SELECT 1 FROM public.org_units WHERE uuid = $1::uuid', [uuid.toLowerCase()]);
  if (unit.rows.length === 0) throw new NotFoundError('Enheden findes ikke');
  return membersOf(runner, uuid.toLowerCase());
}

async function membersOf(q: SqlQueryable, unitUuid: string): Promise<OrgUnitMemberView[]> {
  const { rows } = await q.query<{ uuid: string; app_user_id: string | null; name: string }>(
    `SELECT du.uuid, du.app_user_id, du.name
       FROM public.org_unit_members m
       JOIN public.directory_users du ON du.uuid = m.directory_user_uuid
      WHERE m.org_unit_uuid = $1::uuid
      ORDER BY lower(du.name), du.uuid`,
    [unitUuid],
  );
  return rows.map((r) => ({ directoryUserUuid: r.uuid, appUserId: r.app_user_id, name: r.name }));
}

/** Replaces the membership of a local unit with exactly these app users. */
export async function setOrgUnitMembers(
  uuid: string,
  appUserIds: readonly string[],
  actorUserId: string,
  runner: SqlRunner = defaultRunner(),
): Promise<OrgUnitMemberView[]> {
  assertLocalMode();
  if (!isUuid(uuid)) throw new NotFoundError('Enheden findes ikke');
  const unitUuid = uuid.toLowerCase();
  const wanted = [...new Set(appUserIds)];
  if (wanted.length > MAX_MEMBERS) throw new ValidationError('For mange medlemmer', 'too_many_members');

  return inTx(runner, async (tx) => {
    const unit = await tx.query<{ source: string }>(
      'SELECT source FROM public.org_units WHERE uuid = $1::uuid FOR UPDATE',
      [unitUuid],
    );
    if (!unit.rows[0]) throw new NotFoundError('Enheden findes ikke');
    assertLocalRow(unit.rows[0].source, 'Enheden styres af Rollekatalog og kan ikke ændres her');

    if (wanted.length > 0) {
      const known = await tx.query<{ id: string }>('SELECT id FROM public.users WHERE id = ANY($1::text[])', [wanted]);
      if (known.rows.length !== wanted.length) throw new NotFoundError('En bruger findes ikke', 'user_not_found');
    }

    const dir = await ensureDirectoryUsers(tx, wanted, actorUserId);
    const desired = new Set<string>();
    for (const id of wanted) {
      const d = dir.get(id);
      if (!d) throw new NotFoundError('En bruger findes ikke', 'user_not_found');
      desired.add(d.uuid);
    }

    const current = await tx.query<{ directory_user_uuid: string }>(
      'SELECT directory_user_uuid FROM public.org_unit_members WHERE org_unit_uuid = $1::uuid',
      [unitUuid],
    );
    const existing = new Set(current.rows.map((r) => r.directory_user_uuid));
    const toRemove = [...existing].filter((d) => !desired.has(d));
    const toAdd = [...desired].filter((d) => !existing.has(d));

    if (toRemove.length > 0) {
      await tx.query(
        'DELETE FROM public.org_unit_members WHERE org_unit_uuid = $1::uuid AND directory_user_uuid = ANY($2::uuid[])',
        [unitUuid, toRemove],
      );
    }
    if (toAdd.length > 0) {
      await tx.query(
        `INSERT INTO public.org_unit_members (directory_user_uuid, org_unit_uuid)
         SELECT unnest($2::uuid[]), $1::uuid
         ON CONFLICT DO NOTHING`,
        [unitUuid, toAdd],
      );
    }

    for (const [type, list] of [
      ['access.member_remove', toRemove],
      ['access.member_add', toAdd],
    ] as const) {
      for (const directoryUuid of list) {
        await recordAdminAction(tx, {
          type,
          actorUserId,
          entityType: 'org_unit_member',
          entityId: unitUuid,
          secondaryEntityType: 'directory_user',
          secondaryEntityId: directoryUuid,
        });
      }
    }
    return membersOf(tx, unitUuid);
  });
}
