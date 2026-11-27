// Manager-side service layer for central (locked) templates. The only code that
// writes central_templates, central_template_targets and the changelog
// central_template_versions.
//
// Rules (docs/central-access/templates.md):
//  - A template belongs to the person who created it (created_by_user_id). A bygger
//    (template.manage) reads and manages the templates they created; an administrator
//    (template.manage_all) every template. Anybody else's template is NotFound (existence
//    is not revealed); a principal without template.manage gets the same, so the service
//    fails closed even if a route forgot the guard.
//  - Whoever manages a template chooses its audience freely: any existing org unit, and
//    roles/groups of the catalogue. Role/group targets can only be ADDED while
//    ACCESS_SOURCE=claims (that is the only mode in which anybody holds a role from a login
//    claim; elsewhere they would silently reach nobody); every one must be an ACTIVE
//    catalogue entry when it is added (one that is kept while the catalogue later
//    deactivates it just stops matching).
//  - Every write is ONE transaction: the template row (+ targets), a version
//    row with the mandatory change note, and the audit event (recordEvent with
//    `tx`, which throws, so everything rolls back together).
//  - Optimistic concurrency: writes carry baseVersion. The row is locked
//    FOR UPDATE first, so two concurrent writers with the same baseVersion are
//    serialised and the second sees the new version and gets a
//    VersionConflictError (409). The UPDATE also filters on current_version, as a
//    tripwire: if it matches no row the lock was violated, which is a bug (500), not a 409.
//
// Refusals are audited too: a manager who is refused (a bygger touching another person's template,
//    role/group targets outside claims mode, a stale baseVersion) leaves an `authz.denied` row
//    (required 'template.manage', a closed reason, the template as entity), written AFTER the
//    transaction has rolled back and never carrying a name, prompt or change note. The answer to the
//    caller is unchanged (another person's template is the same 404 as one that does not exist).
//
// Reading the prompt: every function here returns it, so they must only be
// called from manager-scoped routes. Ordinary users get the prompt-free
// CentralSkabelonSummary from the resolver instead.
//
// Inputs are the PARSED bodies (z.output of central-schemas.ts): the routes validate
// once, at the edge (http.ts parseBody), and the service does not parse again.
//
// Raw SQL through the SqlRunner seam with a configurable schema (default
// 'public'), so the *.pg.test.ts lane runs the same code in a throwaway schema.
import type { z } from 'zod';
import type { AuditEventOf, EventType } from '@/lib/audit/events';
import { recordAuthzDenied } from '@/lib/audit/authz-denied';
import { recordEvent } from '@/lib/audit/record';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, VersionConflictError } from '@/lib/authz/access-errors';
import { hasCapability } from '@/lib/authz/permissions';
import { defaultRunner, type SqlQueryable, type SqlRunner } from '@/lib/authz/pg-runner';
import { accessSource, claimsFreshnessSeconds, type AccessSource } from '@/lib/authz/config';
import type { Principal } from '@/lib/authz/types';
import { isUuid } from '@/lib/ids';
import { heldRoleSql, qualifyTable } from './audience-sql';
import type {
  centralStateChangeSchema,
  createCentralTemplateSchema,
  updateCentralTemplateSchema,
  CentralStatusFilter,
} from './central-schemas';
import {
  CENTRAL_CONTENT_FIELDS,
  principalKey,
  principalsEqual,
  sortPrincipal,
  type CentralChangeType,
  type CentralContentField,
  type CentralCatalogueEntry,
  type CentralPrincipalTarget,
  type CentralPrincipalTargetSnapshot,
  type CentralPrincipalTargetView,
  type CentralScopeOrgUnit,
  type CentralStatus,
  type CentralTarget,
  type CentralTemplateAdmin,
  type CentralTemplateContent,
  type CentralTemplateListItem,
  type CentralTemplateVersion,
} from './central-types';

export interface CentralEnv {
  /** Postgres schema holding the central tables; 'public' in production. A trusted constant, never request input. */
  schema: string;
  runner: SqlRunner;
  /** Test seam: the access mode. Omitted: ACCESS_SOURCE, read at call time. */
  accessSource?: AccessSource;
  /** Test seam: how old (seconds) a login's role claims may be to count as a holder; null = none count. Omitted: ROLE_CLAIMS_MAX_SECONDS in claims mode, else null. */
  claimsMaxSeconds?: number | null;
}

const sourceOf = (env: CentralEnv): AccessSource => env.accessSource ?? accessSource();

const claimsMaxOf = (env: CentralEnv): number | null => claimsFreshnessSeconds(env.claimsMaxSeconds, sourceOf(env));

/**
 * How many people hold the role/group `pt` (any alias with kind and identifier) from their latest
 * login, on the same terms as the recipient predicate in resolve.ts (heldRoleSql): a COUNT only,
 * never who. `param` is the placeholder carrying the freshness in seconds (null = nobody).
 */
const holdersSql = (env: CentralEnv, pt: string, param: string): string =>
  `(SELECT count(*)::int FROM ${tbl(env, 'user_external_roles')} ur
     WHERE ur.kind = ${pt}.kind AND ur.identifier = ${pt}.identifier
       AND ${heldRoleSql((table) => tbl(env, table), 'ur', param)})`;

function defaultCentralEnv(): CentralEnv {
  return { schema: 'public', runner: defaultRunner() };
}

const tbl = (env: CentralEnv, table: string): string => qualifyTable(env.schema, table);

const NOT_FOUND = 'Skabelonen findes ikke';

// DB column per content field. The only place column names meet field names.
const COLUMN: Record<CentralContentField, string> = {
  name: 'name',
  description: 'description',
  prompt: 'prompt',
  includeDeltagere: 'include_deltagere',
  includeBeslutningspunkter: 'include_beslutningspunkter',
  includeDagsorden: 'include_dagsorden',
  includeDato: 'include_dato',
  allowUserInstruction: 'allow_user_instruction',
  allowToggleOverrides: 'allow_toggle_overrides',
};

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * "Not found" for a template that EXISTS but belongs to another person. The answer is the same 404 as
 * for one that does not exist (same class family, message and code); the subclass only lets the service
 * tell the two apart for the audit log.
 */
class NotOwnerError extends NotFoundError {}

/** The refusals the log records, by the code the service answers with; everything else is a validation or state problem. */
const AUDITED_REFUSAL_CODES: ReadonlySet<string> = new Set(['principal_targets_need_claims', 'version_conflict']);

function refusalReason(err: unknown): string | null {
  if (err instanceof NotOwnerError) return 'not_owner';
  if ((err instanceof ForbiddenError || err instanceof ConflictError) && AUDITED_REFUSAL_CODES.has(err.code)) return err.code;
  return null;
}

/** Who was refused and for which template; never a name, prompt or note. */
interface RefusalAudit {
  principal: Principal;
  /** The template the call was about (only when it is a well-formed uuid). */
  entityId?: string;
}

async function inTx<T>(env: CentralEnv, fn: (tx: SqlQueryable) => Promise<T>, refusal?: RefusalAudit): Promise<T> {
  try {
    return await env.runner.transaction(fn);
  } catch (err) {
    // The transaction has rolled back; the denial is its own best-effort write (never throws).
    const reason = refusal ? refusalReason(err) : null;
    if (refusal && reason) {
      await recordAuthzDenied({
        actorUserId: refusal.principal.userId,
        required: 'template.manage',
        reason,
        ...(refusal.entityId && isUuid(refusal.entityId) ? { entityType: 'central_template', entityId: refusal.entityId.toLowerCase() } : {}),
      });
    }
    // A concurrent change tripped an FK / unique / check constraint after our own checks passed.
    const code = (err as { code?: unknown } | null)?.code;
    if (code === '23001' || code === '23503' || code === '23505') {
      throw new ConflictError('Ændringen kolliderede med en samtidig ændring. Prøv igen.', 'concurrent_change');
    }
    // 22021 / 22P05: U+0000 in a text parameter / jsonb snapshot; 22P02: a lone surrogate that
    // jsonb cannot hold. The schemas reject both first; this is defence in depth.
    if (code === '23514' || code === '22021' || code === '22P05' || code === '22P02') throw new ValidationError('Ugyldige værdier', 'invalid');
    throw err;
  }
}

const iso = (d: unknown): string => (d instanceof Date ? d.toISOString() : String(d));

const sortTargets = (targets: readonly CentralTarget[]): CentralTarget[] =>
  [...targets].sort((a, b) => (a.orgUnitUuid < b.orgUnitUuid ? -1 : a.orgUnitUuid > b.orgUnitUuid ? 1 : 0));

const sameTargets = (a: readonly CentralTarget[], b: readonly CentralTarget[]): boolean =>
  JSON.stringify(sortTargets(a)) === JSON.stringify(sortTargets(b));

const snapshotOf = (views: readonly CentralPrincipalTargetView[]): CentralPrincipalTargetSnapshot[] =>
  views.map((v) => ({ kind: v.kind, identifier: v.identifier, name: v.name }));

interface TemplateRow {
  id: string;
  created_by_user_id: string | null;
  name: string;
  description: string;
  prompt: string;
  include_deltagere: boolean;
  include_beslutningspunkter: boolean;
  include_dagsorden: boolean;
  include_dato: boolean;
  allow_user_instruction: boolean;
  allow_toggle_overrides: boolean;
  status: string;
  current_version: number;
  created_at: Date | string;
  updated_at: Date | string;
  created_by_name: string | null;
  last_edited_by_name: string | null;
  last_edited_at: Date | string | null;
}

const contentOf = (r: TemplateRow): CentralTemplateContent => ({
  name: r.name,
  description: r.description,
  prompt: r.prompt,
  includeDeltagere: r.include_deltagere,
  includeBeslutningspunkter: r.include_beslutningspunkter,
  includeDagsorden: r.include_dagsorden,
  includeDato: r.include_dato,
  allowUserInstruction: r.allow_user_instruction,
  allowToggleOverrides: r.allow_toggle_overrides,
});

function adminView(
  r: TemplateRow,
  targets: CentralTarget[],
  principalTargets: CentralPrincipalTargetView[],
): CentralTemplateAdmin {
  return {
    ...contentOf(r),
    id: r.id,
    status: r.status as CentralStatus,
    currentVersion: r.current_version,
    targets: sortTargets(targets),
    principalTargets,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    // The name as it was when version 1 was written, so it survives a rename or deletion of the user.
    createdByName: r.created_by_name ?? null,
    lastEditedByName: r.last_edited_by_name ?? null,
    // The version row of the current version always exists; fall back to updated_at defensively.
    lastEditedAt: iso(r.last_edited_at ?? r.updated_at),
  };
}

async function selectRow(env: CentralEnv, q: SqlQueryable, id: string, lock: boolean): Promise<TemplateRow | null> {
  const { rows } = await q.query<TemplateRow>(
    `SELECT ct.id, ct.created_by_user_id, ct.name, ct.description, ct.prompt,
            ct.include_deltagere, ct.include_beslutningspunkter, ct.include_dagsorden, ct.include_dato,
            ct.allow_user_instruction, ct.allow_toggle_overrides, ct.status, ct.current_version,
            ct.created_at, ct.updated_at,
            v1.changed_by_name AS created_by_name,
            vc.changed_by_name AS last_edited_by_name, vc.changed_at AS last_edited_at
       FROM ${tbl(env, 'central_templates')} ct
       LEFT JOIN ${tbl(env, 'central_template_versions')} v1 ON v1.template_id = ct.id AND v1.version = 1
       LEFT JOIN ${tbl(env, 'central_template_versions')} vc ON vc.template_id = ct.id AND vc.version = ct.current_version
      WHERE ct.id = $1::uuid${lock ? ' FOR UPDATE OF ct' : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

async function selectTargets(env: CentralEnv, q: SqlQueryable, id: string): Promise<CentralTarget[]> {
  const { rows } = await q.query<{ org_unit_uuid: string; include_descendants: boolean }>(
    `SELECT org_unit_uuid, include_descendants FROM ${tbl(env, 'central_template_targets')}
      WHERE template_id = $1::uuid ORDER BY org_unit_uuid`,
    [id],
  );
  return rows.map((r) => ({ orgUnitUuid: r.org_unit_uuid, includeDescendants: r.include_descendants }));
}

interface PrincipalRow {
  kind: string;
  identifier: string;
  name: string | null;
  active: boolean | null;
  holders?: number | null;
}

const principalView = (r: PrincipalRow): CentralPrincipalTargetView => ({
  kind: r.kind as CentralPrincipalTarget['kind'],
  identifier: r.identifier,
  // The FK keeps every row in the catalogue, so a missing name only happens for a hand-edited database.
  name: r.name ?? r.identifier,
  status: r.active === null ? 'unknown' : r.active ? 'active' : 'inactive',
  holders: Number(r.holders ?? 0),
});

/**
 * Role/group targets with the catalogue's CURRENT name and state. `withHolders` adds the holders
 * count (a correlated count per target): on for what a manager reads back (reload, get), off for
 * version snapshots and change detection, which never look at it (holders is then 0).
 */
async function selectPrincipalTargets(
  env: CentralEnv,
  q: SqlQueryable,
  id: string,
  withHolders: boolean,
): Promise<CentralPrincipalTargetView[]> {
  const { rows } = await q.query<PrincipalRow>(
    `SELECT pt.kind, pt.identifier, er.name, er.active${withHolders ? `, ${holdersSql(env, 'pt', '$2')} AS holders` : ''}
       FROM ${tbl(env, 'central_template_principal_targets')} pt
       LEFT JOIN ${tbl(env, 'external_roles')} er ON er.kind = pt.kind AND er.identifier = pt.identifier
      WHERE pt.template_id = $1::uuid
      ORDER BY pt.kind, pt.identifier`,
    withHolders ? [id, claimsMaxOf(env)] : [id],
  );
  return rows.map(principalView);
}

async function replacePrincipalTargets(
  env: CentralEnv,
  q: SqlQueryable,
  id: string,
  targets: readonly CentralPrincipalTarget[],
): Promise<void> {
  await q.query(`DELETE FROM ${tbl(env, 'central_template_principal_targets')} WHERE template_id = $1::uuid`, [id]);
  if (targets.length === 0) return;
  await q.query(
    `INSERT INTO ${tbl(env, 'central_template_principal_targets')} (template_id, kind, identifier)
     SELECT $1::uuid, x.k, x.i FROM unnest($2::text[], $3::text[]) AS x(k, i)`,
    [id, targets.map((t) => t.kind), targets.map((t) => t.identifier)],
  );
}

/**
 * A role/group target that is NEWLY added must be an active entry of the catalogue, and is only
 * possible in claims mode. A target that was already there may have been deactivated since; keeping
 * it is fine (it just stops matching anybody).
 */
async function assertPrincipalTargetsAllowed(
  env: CentralEnv,
  q: SqlQueryable,
  added: readonly CentralPrincipalTarget[],
): Promise<void> {
  if (added.length === 0) return;
  // Outside claims mode nobody holds a role or group from a login claim, so a target would be silent.
  if (sourceOf(env) !== 'claims') {
    throw new ConflictError(
      'Roller og grupper kan kun vælges, når rollerne kommer fra brugernes login (ACCESS_SOURCE=claims)',
      'principal_targets_need_claims',
    );
  }
  const { rows } = await q.query(
    `SELECT 1 FROM ${tbl(env, 'external_roles')} e
       JOIN unnest($1::text[], $2::text[]) AS x(k, i) ON x.k = e.kind AND x.i = e.identifier
      WHERE e.active`,
    [added.map((t) => t.kind), added.map((t) => t.identifier)],
  );
  if (rows.length !== added.length) {
    throw new ValidationError('En valgt rolle eller gruppe findes ikke i kataloget', 'principal_target_unknown');
  }
}

/** Every write needs template.manage; checked here too, so the service fails closed without the route guard. */
function assertManager(principal: Principal): void {
  if (!hasCapability(principal, 'template.manage')) throw new ForbiddenError('Du har ikke adgang til centrale skabeloner');
}

/**
 * Loads a template the principal may manage, or throws NotFound: unknown or ill-formed id, no
 * template.manage, or another person's template for a manager without template.manage_all.
 * With `lock` the row is locked FOR UPDATE (writers).
 */
async function loadManageable(
  env: CentralEnv,
  q: SqlQueryable,
  principal: Principal,
  id: string,
  lock: boolean,
): Promise<TemplateRow> {
  if (!isUuid(id) || !hasCapability(principal, 'template.manage')) throw new NotFoundError(NOT_FOUND);
  const row = await selectRow(env, q, id.toLowerCase(), lock);
  if (!row) throw new NotFoundError(NOT_FOUND);
  if (!hasCapability(principal, 'template.manage_all') && row.created_by_user_id !== principal.userId) {
    throw new NotOwnerError(NOT_FOUND);
  }
  return row;
}

/** Every target must be an existing org unit (any unit: whoever manages a template chooses its audience). */
async function assertTargetsExist(env: CentralEnv, q: SqlQueryable, targets: readonly CentralTarget[]): Promise<void> {
  if (targets.length === 0) return;
  // FOR SHARE: a concurrent deleteOrgUnit (FOR UPDATE) waits for us instead of racing the targets FK.
  const { rows } = await q.query(`SELECT uuid FROM ${tbl(env, 'org_units')} WHERE uuid = ANY($1::uuid[]) FOR SHARE`, [
    targets.map((t) => t.orgUnitUuid),
  ]);
  if (rows.length !== new Set(targets.map((t) => t.orgUnitUuid.toLowerCase())).size) {
    throw new ValidationError('En valgt enhed findes ikke', 'target_unknown');
  }
}

async function replaceTargets(env: CentralEnv, q: SqlQueryable, id: string, targets: readonly CentralTarget[]): Promise<void> {
  await q.query(`DELETE FROM ${tbl(env, 'central_template_targets')} WHERE template_id = $1::uuid`, [id]);
  if (targets.length === 0) return;
  await q.query(
    `INSERT INTO ${tbl(env, 'central_template_targets')} (template_id, org_unit_uuid, include_descendants)
     SELECT $1::uuid, x.u, x.d FROM unnest($2::uuid[], $3::boolean[]) AS x(u, d)`,
    [id, targets.map((t) => t.orgUnitUuid), targets.map((t) => t.includeDescendants)],
  );
}

async function actorName(env: CentralEnv, q: SqlQueryable, userId: string): Promise<string | null> {
  const { rows } = await q.query<{ name: string }>(`SELECT name FROM ${tbl(env, 'users')} WHERE id = $1`, [userId]);
  return rows[0]?.name ?? null;
}

interface VersionInsert {
  templateId: string;
  version: number;
  changeType: CentralChangeType;
  changeNote: string;
  actor: Principal;
  content: CentralTemplateContent;
  targets: readonly CentralTarget[];
  principalTargets: readonly CentralPrincipalTargetSnapshot[];
}

async function appendVersion(env: CentralEnv, q: SqlQueryable, v: VersionInsert): Promise<void> {
  const name = await actorName(env, q, v.actor.userId);
  await q.query(
    `INSERT INTO ${tbl(env, 'central_template_versions')}
       (template_id, version, change_type, change_note, changed_by_user_id, changed_by_name, content, targets, principal_targets)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb)`,
    [
      v.templateId,
      v.version,
      v.changeType,
      v.changeNote,
      v.actor.userId,
      name,
      JSON.stringify(v.content),
      JSON.stringify(sortTargets(v.targets)),
      JSON.stringify(sortPrincipal(v.principalTargets)),
    ],
  );
}

/** Audit row on the SAME transaction: throws on failure, so the whole change rolls back. */
async function audit<T extends EventType>(env: CentralEnv, tx: SqlQueryable, event: AuditEventOf<T>): Promise<void> {
  await recordEvent(event, { tx, table: tbl(env, 'audit_events') });
}

async function reload(env: CentralEnv, q: SqlQueryable, id: string): Promise<CentralTemplateAdmin> {
  const row = await selectRow(env, q, id, false);
  if (!row) throw new NotFoundError(NOT_FOUND);
  return adminView(row, await selectTargets(env, q, id), await selectPrincipalTargets(env, q, id, true));
}

// ─── Create ────────────────────────────────────────────────────────────────

export async function createCentralTemplate(
  principal: Principal,
  input: z.output<typeof createCentralTemplateSchema>,
  env: CentralEnv = defaultCentralEnv(),
): Promise<CentralTemplateAdmin> {
  const targets = sortTargets(input.targets);
  const principalTargets = sortPrincipal(input.principalTargets);
  const content: CentralTemplateContent = {
    name: input.name,
    description: input.description,
    prompt: input.prompt,
    includeDeltagere: input.includeDeltagere,
    includeBeslutningspunkter: input.includeBeslutningspunkter,
    includeDagsorden: input.includeDagsorden,
    includeDato: input.includeDato,
    allowUserInstruction: input.allowUserInstruction,
    allowToggleOverrides: input.allowToggleOverrides,
  };

  return inTx(env, async (tx) => {
    assertManager(principal);
    await assertTargetsExist(env, tx, targets);
    await assertPrincipalTargetsAllowed(env, tx, principalTargets);

    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO ${tbl(env, 'central_templates')}
         (created_by_user_id, name, description, prompt,
          include_deltagere, include_beslutningspunkter, include_dagsorden, include_dato,
          allow_user_instruction, allow_toggle_overrides, status, current_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', 1)
       RETURNING id`,
      [
        principal.userId,
        content.name,
        content.description,
        content.prompt,
        content.includeDeltagere,
        content.includeBeslutningspunkter,
        content.includeDagsorden,
        content.includeDato,
        content.allowUserInstruction,
        content.allowToggleOverrides,
      ],
    );
    const id = inserted.rows[0].id;

    await replaceTargets(env, tx, id, targets);
    await replacePrincipalTargets(env, tx, id, principalTargets);
    await appendVersion(env, tx, {
      templateId: id,
      version: 1,
      changeType: 'create',
      changeNote: input.changeNote,
      actor: principal,
      content,
      targets,
      principalTargets: snapshotOf(await selectPrincipalTargets(env, tx, id, false)),
    });
    await audit(env, tx, {
      type: 'central_template.create',
      actorUserId: principal.userId,
      entityId: id,
      details: { version: 1, targetCount: targets.length, principalTargetCount: principalTargets.length },
    });
    return reload(env, tx, id);
  }, { principal });
}

// ─── Update (content and/or targets) ───────────────────────────────────────

export async function updateCentralTemplate(
  principal: Principal,
  id: string,
  input: z.output<typeof updateCentralTemplateSchema>,
  env: CentralEnv = defaultCentralEnv(),
): Promise<CentralTemplateAdmin> {
  return inTx(env, async (tx) => {
    const row = await loadManageable(env, tx, principal, id, true);
    if (row.current_version !== input.baseVersion) throw new VersionConflictError(row.current_version);
    if (row.status !== 'active') {
      throw new ConflictError('Skabelonen er arkiveret. Genopret den, før den kan ændres.', 'template_archived');
    }

    const current = contentOf(row);
    const changedFields = CENTRAL_CONTENT_FIELDS.filter((f) => input[f] !== undefined && input[f] !== current[f]);
    const next: CentralTemplateContent = { ...current };
    for (const f of changedFields) (next as unknown as Record<string, unknown>)[f] = input[f];

    const currentTargets = await selectTargets(env, tx, row.id);
    const nextTargets = input.targets === undefined ? currentTargets : sortTargets(input.targets);
    const targetsChanged = input.targets !== undefined && !sameTargets(currentTargets, nextTargets);

    const currentPrincipal = await selectPrincipalTargets(env, tx, row.id, false);
    const nextPrincipal = input.principalTargets === undefined ? currentPrincipal : sortPrincipal(input.principalTargets);
    const principalChanged = input.principalTargets !== undefined && !principalsEqual(currentPrincipal, nextPrincipal);

    if (changedFields.length === 0 && !targetsChanged && !principalChanged) {
      throw new ValidationError('Der er ingen ændringer at gemme', 'no_changes');
    }
    if (targetsChanged) await assertTargetsExist(env, tx, nextTargets);
    if (principalChanged) {
      const had = new Set(currentPrincipal.map(principalKey));
      await assertPrincipalTargetsAllowed(env, tx, nextPrincipal.filter((t) => !had.has(principalKey(t))));
    }

    const newVersion = row.current_version + 1;
    const params: unknown[] = [row.id, row.current_version];
    const sets = changedFields.map((f) => {
      params.push(next[f]);
      return `${COLUMN[f]} = $${params.length}`;
    });
    // The row is locked, so the version filter always matches; a miss means the lock was violated.
    const updated = await tx.query<{ current_version: number }>(
      `UPDATE ${tbl(env, 'central_templates')}
          SET ${[...sets, 'current_version = current_version + 1', 'updated_at = now()'].join(', ')}
        WHERE id = $1::uuid AND current_version = $2
        RETURNING current_version`,
      params,
    );
    if (updated.rows.length !== 1) throw new Error('central template row lock violated');

    if (targetsChanged) await replaceTargets(env, tx, row.id, nextTargets);
    if (principalChanged) await replacePrincipalTargets(env, tx, row.id, nextPrincipal);
    const principalSnapshot = principalChanged ? snapshotOf(await selectPrincipalTargets(env, tx, row.id, false)) : snapshotOf(currentPrincipal);

    const retargetOnly = changedFields.length === 0;
    await appendVersion(env, tx, {
      templateId: row.id,
      version: newVersion,
      changeType: retargetOnly ? 'retarget' : 'update',
      changeNote: input.changeNote,
      actor: principal,
      content: next,
      targets: nextTargets,
      principalTargets: principalSnapshot,
    });
    await audit(
      env,
      tx,
      retargetOnly
        ? {
            type: 'central_template.retarget',
            actorUserId: principal.userId,
            entityId: row.id,
            details: { version: newVersion, targetCount: nextTargets.length, principalTargetCount: nextPrincipal.length },
          }
        : {
            type: 'central_template.update',
            actorUserId: principal.userId,
            entityId: row.id,
            details: {
              version: newVersion,
              changedFields: [
                ...changedFields,
                ...(targetsChanged ? (['targets'] as const) : []),
                ...(principalChanged ? (['principalTargets'] as const) : []),
              ],
            },
          },
    );
    return reload(env, tx, row.id);
  }, { principal, entityId: id });
}

// ─── Archive / restore ─────────────────────────────────────────────────────

async function changeStatus(
  principal: Principal,
  id: string,
  input: z.output<typeof centralStateChangeSchema>,
  to: CentralStatus,
  env: CentralEnv,
): Promise<CentralTemplateAdmin> {
  const archiving = to === 'archived';

  return inTx(env, async (tx) => {
    const row = await loadManageable(env, tx, principal, id, true);
    if (row.current_version !== input.baseVersion) throw new VersionConflictError(row.current_version);
    if (row.status === to) {
      throw archiving
        ? new ConflictError('Skabelonen er allerede arkiveret', 'already_archived')
        : new ConflictError('Skabelonen er ikke arkiveret', 'not_archived');
    }

    const newVersion = row.current_version + 1;
    const updated = await tx.query<{ current_version: number }>(
      `UPDATE ${tbl(env, 'central_templates')}
          SET status = $3, current_version = current_version + 1, updated_at = now()
        WHERE id = $1::uuid AND current_version = $2
        RETURNING current_version`,
      [row.id, row.current_version, to],
    );
    if (updated.rows.length !== 1) throw new Error('central template row lock violated');

    const targets = await selectTargets(env, tx, row.id);
    const principalTargets = await selectPrincipalTargets(env, tx, row.id, false);
    await appendVersion(env, tx, {
      templateId: row.id,
      version: newVersion,
      changeType: archiving ? 'archive' : 'restore',
      changeNote: input.changeNote,
      actor: principal,
      content: contentOf(row),
      targets,
      principalTargets: snapshotOf(principalTargets),
    });
    await audit(env, tx, {
      type: archiving ? 'central_template.archive' : 'central_template.restore',
      actorUserId: principal.userId,
      entityId: row.id,
      details: { version: newVersion },
    });
    return reload(env, tx, row.id);
  }, { principal, entityId: id });
}

export const archiveCentralTemplate = (
  principal: Principal,
  id: string,
  input: z.output<typeof centralStateChangeSchema>,
  env: CentralEnv = defaultCentralEnv(),
): Promise<CentralTemplateAdmin> => changeStatus(principal, id, input, 'archived', env);

export const restoreCentralTemplate = (
  principal: Principal,
  id: string,
  input: z.output<typeof centralStateChangeSchema>,
  env: CentralEnv = defaultCentralEnv(),
): Promise<CentralTemplateAdmin> => changeStatus(principal, id, input, 'active', env);

// ─── Reads ─────────────────────────────────────────────────────────────────

/**
 * The templates the caller manages: the ones they created, or every template with
 * template.manage_all. Default filter: active only.
 */
export async function listManageableTemplates(
  principal: Principal,
  opts: { status?: CentralStatusFilter } = {},
  env: CentralEnv = defaultCentralEnv(),
): Promise<CentralTemplateListItem[]> {
  const q = env.runner;
  if (!hasCapability(principal, 'template.manage')) return [];
  const all = hasCapability(principal, 'template.manage_all');

  const status = opts.status ?? 'active';
  const { rows } = await q.query<{
    id: string;
    name: string;
    description: string;
    status: string;
    current_version: number;
    updated_at: Date | string;
    created_by_name: string | null;
    last_edited_by_name: string | null;
    last_edited_at: Date | string | null;
  }>(
    `SELECT ct.id, ct.name, ct.description, ct.status, ct.current_version, ct.updated_at,
            v1.changed_by_name AS created_by_name,
            vc.changed_by_name AS last_edited_by_name, vc.changed_at AS last_edited_at
       FROM ${tbl(env, 'central_templates')} ct
       LEFT JOIN ${tbl(env, 'central_template_versions')} v1 ON v1.template_id = ct.id AND v1.version = 1
       LEFT JOIN ${tbl(env, 'central_template_versions')} vc ON vc.template_id = ct.id AND vc.version = ct.current_version
      WHERE ($1::text IS NULL OR ct.status = $1)
        AND ($2::text IS NULL OR ct.created_by_user_id = $2)
      ORDER BY ct.updated_at DESC, ct.id`,
    [status === 'all' ? null : status, all ? null : principal.userId],
  );
  // The audience of every listed template, two statements for the whole page.
  const ids = rows.map((r) => r.id);
  const orgTargets = new Map<string, CentralTarget[]>();
  const principalTargets = new Map<string, CentralPrincipalTargetView[]>();
  if (ids.length > 0) {
    const org = await q.query<{ template_id: string; org_unit_uuid: string; include_descendants: boolean }>(
      `SELECT template_id, org_unit_uuid, include_descendants FROM ${tbl(env, 'central_template_targets')}
        WHERE template_id = ANY($1::uuid[]) ORDER BY org_unit_uuid`,
      [ids],
    );
    for (const t of org.rows) {
      const list = orgTargets.get(t.template_id) ?? [];
      list.push({ orgUnitUuid: t.org_unit_uuid, includeDescendants: t.include_descendants });
      orgTargets.set(t.template_id, list);
    }
    const pr = await q.query<PrincipalRow & { template_id: string }>(
      `SELECT pt.template_id, pt.kind, pt.identifier, er.name, er.active, ${holdersSql(env, 'pt', '$2')} AS holders
         FROM ${tbl(env, 'central_template_principal_targets')} pt
         LEFT JOIN ${tbl(env, 'external_roles')} er ON er.kind = pt.kind AND er.identifier = pt.identifier
        WHERE pt.template_id = ANY($1::uuid[]) ORDER BY pt.kind, pt.identifier`,
      [ids, claimsMaxOf(env)],
    );
    for (const t of pr.rows) {
      const list = principalTargets.get(t.template_id) ?? [];
      list.push(principalView(t));
      principalTargets.set(t.template_id, list);
    }
  }
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    status: r.status as CentralStatus,
    currentVersion: r.current_version,
    targets: orgTargets.get(r.id) ?? [],
    principalTargets: principalTargets.get(r.id) ?? [],
    updatedAt: iso(r.updated_at),
    createdByName: r.created_by_name ?? null,
    lastEditedByName: r.last_edited_by_name ?? null,
    lastEditedAt: iso(r.last_edited_at ?? r.updated_at),
  }));
}

export async function getManageableTemplate(
  principal: Principal,
  id: string,
  env: CentralEnv = defaultCentralEnv(),
): Promise<CentralTemplateAdmin> {
  const row = await loadManageable(env, env.runner, principal, id, false);
  return adminView(
    row,
    await selectTargets(env, env.runner, row.id),
    await selectPrincipalTargets(env, env.runner, row.id, true),
  );
}

/** The changelog, newest first. Same rule as the template itself. */
export async function listVersions(
  principal: Principal,
  id: string,
  env: CentralEnv = defaultCentralEnv(),
): Promise<CentralTemplateVersion[]> {
  const row = await loadManageable(env, env.runner, principal, id, false);
  const { rows } = await env.runner.query<{
    version: number;
    change_type: string;
    change_note: string;
    changed_by_name: string | null;
    changed_at: Date | string;
    content: CentralTemplateContent;
    targets: CentralTarget[];
    principal_targets: CentralPrincipalTargetSnapshot[] | null;
  }>(
    `SELECT version, change_type, change_note, changed_by_name, changed_at, content, targets, principal_targets
       FROM ${tbl(env, 'central_template_versions')}
      WHERE template_id = $1::uuid
      ORDER BY version DESC`,
    [row.id],
  );
  return rows.map((r) => ({
    version: r.version,
    changeType: r.change_type as CentralChangeType,
    changeNote: r.change_note,
    changedByName: r.changed_by_name ?? null,
    changedAt: iso(r.changed_at),
    content: r.content,
    targets: r.targets,
    principalTargets: r.principal_targets ?? [],
  }));
}

/** Every org unit, for the audience picker: whoever manages a template may make it available to any unit. */
export async function listAudienceOrgUnits(
  principal: Principal,
  env: CentralEnv = defaultCentralEnv(),
): Promise<CentralScopeOrgUnit[]> {
  if (!hasCapability(principal, 'template.manage')) return [];
  const { rows } = await env.runner.query<{ uuid: string; name: string; parent_uuid: string | null }>(
    `SELECT uuid, name, parent_uuid FROM ${tbl(env, 'org_units')} ORDER BY lower(name), uuid`,
    [],
  );
  const known = new Set(rows.map((r) => r.uuid));
  return rows.map((r) => ({
    uuid: r.uuid,
    name: r.name,
    parentUuid: r.parent_uuid !== null && known.has(r.parent_uuid) ? r.parent_uuid : null,
  }));
}

/**
 * The role/group catalogue as the target picker needs it: every entry (inactive ones too, so a
 * target that was withdrawn from the catalogue can still be named), both sources merged. Names and
 * identifiers only. Callers must hold template.manage; whether the caller may actually USE it for
 * targeting (claims mode only) is the caller's `canTarget`.
 */
export async function listCatalogue(env: CentralEnv = defaultCentralEnv()): Promise<{
  entries: CentralCatalogueEntry[];
  lastRefreshedAt: string | null;
}> {
  const { rows } = await env.runner.query<{
    kind: string;
    identifier: string;
    name: string;
    source: string;
    active: boolean;
    synced_at: Date | string;
    holders: number;
  }>(
    // The holders of every entry in ONE grouped pass over the claim rows (not a count per entry).
    `WITH held AS (
       SELECT ur.kind, ur.identifier, count(*)::int AS holders
         FROM ${tbl(env, 'user_external_roles')} ur
        WHERE ${heldRoleSql((table) => tbl(env, table), 'ur', '$1')}
        GROUP BY ur.kind, ur.identifier
     )
     SELECT er.kind, er.identifier, er.name, er.source, er.active, er.synced_at, COALESCE(h.holders, 0) AS holders
       FROM ${tbl(env, 'external_roles')} er
       LEFT JOIN held h ON h.kind = er.kind AND h.identifier = er.identifier
      ORDER BY er.active DESC, er.kind, lower(er.name), er.identifier`,
    [claimsMaxOf(env)],
  );
  const refreshed = rows.filter((r) => r.source === 'rollekatalog').map((r) => iso(r.synced_at));
  return {
    entries: rows.map((r) => ({
      kind: r.kind as CentralCatalogueEntry['kind'],
      identifier: r.identifier,
      name: r.name,
      source: r.source as CentralCatalogueEntry['source'],
      active: r.active,
      holders: Number(r.holders ?? 0),
    })),
    lastRefreshedAt: refreshed.length > 0 ? refreshed.reduce((a, b) => (a > b ? a : b)) : null,
  };
}
