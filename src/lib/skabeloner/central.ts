// Manager-side service layer for central (locked) templates. The only code that
// writes central_templates, central_template_targets and the changelog
// central_template_versions.
//
// Rules (docs/central-access/templates.md):
//  - A manager may touch a template iff template.manage covers its OWNER org
//    unit. Anything outside that scope is NotFound (existence is not revealed);
//    a principal without the capability gets the same, so the service fails
//    closed even if a route forgot the guard.
//  - A template with NO owner unit is ORGANISATION-WIDE (claims mode has no org
//    units): only a manager with a GLOBAL template.manage may create or touch
//    it; to a scoped manager it does not exist.
//  - Targets (recipient units) must lie inside the owner unit's subtree: no
//    sideways or upward delegation. An ownerless template may target any existing unit.
//  - Role/group targets (recipients by catalogue role or group) are for global
//    managers only, and can only be ADDED while ACCESS_SOURCE=claims (that is the only mode
//    in which anybody holds a role from a login claim; elsewhere they would silently reach
//    nobody); every one must be an ACTIVE catalogue entry when it is added (one that is
//    kept while the catalogue later deactivates it just stops matching).
//  - A scoped manager may not change, archive or restore a template that has role/group
//    targets (it reaches people outside their scope); reading it stays allowed.
//  - Every write is ONE transaction: the template row (+ targets), a version
//    row with the mandatory change note, and the audit event (recordEvent with
//    `tx`, which throws, so everything rolls back together).
//  - Optimistic concurrency: writes carry baseVersion. The row is locked
//    FOR UPDATE first, so two concurrent writers with the same baseVersion are
//    serialised and the second sees the new version and gets a
//    VersionConflictError (409); the UPDATE also filters on current_version.
//
// Reading the prompt: every function here returns it, so they must only be
// called from manager-scoped routes. Ordinary users get the prompt-free
// CentralSkabelonSummary from the resolver instead.
//
// Raw SQL through the SqlRunner seam with a configurable schema (default
// 'public'), so the *.pg.test.ts lane runs the same code in a throwaway schema.
import { z } from 'zod';
import type { AuditEventOf, EventType } from '@/lib/audit/events';
import { recordEvent } from '@/lib/audit/record';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, VersionConflictError } from '@/lib/authz/access-errors';
import { defaultRunner, type SqlQueryable, type SqlRunner } from '@/lib/authz/pg-runner';
import { accessSource, claimsFreshnessSeconds, type AccessSource } from '@/lib/authz/config';
import { hasGlobalScope, isOrgUnitWithinScope, orgSubtreeUuids, orgUnitsInScope, type ScopeEnv } from '@/lib/authz/scope';
import type { Principal } from '@/lib/authz/types';
import { UUID_RE, heldRoleSql, qualifyTable } from './audience-sql';
import {
  centralStateChangeSchema,
  createCentralTemplateSchema,
  dedupePrincipalTargets,
  dedupeTargets,
  updateCentralTemplateSchema,
  type CentralStatusFilter,
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

export function defaultCentralEnv(): CentralEnv {
  return { schema: 'public', runner: defaultRunner() };
}

const tbl = (env: CentralEnv, table: string): string => qualifyTable(env.schema, table);

const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

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

async function inTx<T>(env: CentralEnv, fn: (tx: SqlQueryable) => Promise<T>): Promise<T> {
  try {
    return await env.runner.transaction(fn);
  } catch (err) {
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

function scopeEnv(env: CentralEnv, q: SqlQueryable): ScopeEnv {
  return { query: (text, params) => q.query(text, params), orgUnitsTable: tbl(env, 'org_units') };
}

/**
 * The routes parse bodies with the same schemas; parsing again here keeps the
 * service safe for any other caller. Issue messages are only passed on where
 * the schemas set a Danish one (never zod's English defaults).
 */
function parseInput<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const isNote = issue.path[0] === 'changeNote';
  const danish = isNote || issue.code === 'too_small' || issue.code === 'too_big' || issue.code === 'custom';
  throw new ValidationError(danish ? issue.message : 'Ugyldigt input', isNote ? 'change_note_invalid' : 'invalid');
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
  owner_org_unit_uuid: string | null;
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
    ownerOrgUnitUuid: r.owner_org_unit_uuid,
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
    `SELECT ct.id, ct.owner_org_unit_uuid, ct.name, ct.description, ct.prompt,
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
 * Role/group targets are for GLOBAL managers (the owner-subtree rule has no meaning for them), and a
 * target that is NEWLY added must be an active entry of the catalogue. A target that was already
 * there may have been deactivated since; keeping it is fine (it just stops matching anybody).
 */
async function assertPrincipalTargetsAllowed(
  env: CentralEnv,
  q: SqlQueryable,
  principal: Principal,
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
  if (!hasGlobalScope(principal, 'template.manage')) {
    throw new ForbiddenError(
      'Kun en bygger med tilladelse for hele organisationen kan gøre en skabelon tilgængelig for roller og grupper',
      'principal_targets_need_global',
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

/**
 * A template that reaches roles/groups reaches people outside any unit scope, so only a GLOBAL
 * manager may change, archive or restore it. Reading it stays allowed. Called with the row locked.
 */
async function assertNoPrincipalTargetsUnlessGlobal(
  env: CentralEnv,
  q: SqlQueryable,
  principal: Principal,
  templateId: string,
): Promise<void> {
  if (hasGlobalScope(principal, 'template.manage')) return;
  const { rows } = await q.query(
    `SELECT 1 FROM ${tbl(env, 'central_template_principal_targets')} WHERE template_id = $1::uuid LIMIT 1`,
    [templateId],
  );
  if (rows.length > 0) {
    throw new ForbiddenError(
      'Skabelonen er gjort tilgængelig for roller eller grupper. Kun en bygger med tilladelse for hele organisationen kan ændre, arkivere eller genoprette den',
      'principal_targets_need_global',
    );
  }
}

/** Every owner-less (organisation-wide) write needs a GLOBAL template.manage. */
function assertGlobalForOrgWide(principal: Principal): void {
  if (!hasGlobalScope(principal, 'template.manage')) {
    throw new ForbiddenError(
      'Kun en bygger med tilladelse for hele organisationen kan oprette en skabelon uden ejerenhed',
      'org_wide_needs_global',
    );
  }
}

/**
 * Loads a template the principal may manage, or throws NotFound: unknown,
 * ill-formed id, owner unit outside template.manage scope, or no capability.
 * With `lock` the row is locked FOR UPDATE (writers).
 */
async function loadManageable(
  env: CentralEnv,
  q: SqlQueryable,
  principal: Principal,
  id: string,
  lock: boolean,
): Promise<TemplateRow> {
  if (!isUuid(id)) throw new NotFoundError(NOT_FOUND);
  const row = await selectRow(env, q, id.toLowerCase(), lock);
  if (!row) throw new NotFoundError(NOT_FOUND);
  // An organisation-wide template (no owner unit) belongs to the global managers only.
  const inScope =
    row.owner_org_unit_uuid === null
      ? hasGlobalScope(principal, 'template.manage')
      : await isOrgUnitWithinScope(principal, 'template.manage', row.owner_org_unit_uuid, scopeEnv(env, q));
  if (!inScope) throw new NotFoundError(NOT_FOUND);
  return row;
}

/**
 * Targets must be inside the owner's subtree (the owner itself included). Unknown units are not in it.
 * An organisation-wide template (no owner) may target any EXISTING unit (its manager is global).
 */
async function assertTargetsInOwnerSubtree(
  env: CentralEnv,
  q: SqlQueryable,
  ownerUuid: string | null,
  targets: readonly CentralTarget[],
): Promise<void> {
  if (targets.length === 0) return;
  if (ownerUuid === null) {
    const { rows } = await q.query(`SELECT uuid FROM ${tbl(env, 'org_units')} WHERE uuid = ANY($1::uuid[])`, [
      targets.map((t) => t.orgUnitUuid),
    ]);
    if (rows.length !== targets.length) {
      throw new ValidationError('En valgt enhed findes ikke', 'target_outside_owner');
    }
    return;
  }
  const subtree = await orgSubtreeUuids([{ orgUnitUuid: ownerUuid, includeDescendants: true }], scopeEnv(env, q));
  for (const t of targets) {
    if (!subtree.has(t.orgUnitUuid.toLowerCase())) {
      throw new ValidationError(
        'En valgt enhed findes ikke eller ligger uden for skabelonens ejerenhed',
        'target_outside_owner',
      );
    }
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

/** The owner unit as the audit event's secondary entity; an organisation-wide template has none. */
const ownerRef = (row: TemplateRow): { secondaryEntityId?: string } =>
  row.owner_org_unit_uuid ? { secondaryEntityId: row.owner_org_unit_uuid } : {};

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
  rawInput: z.input<typeof createCentralTemplateSchema>,
  env: CentralEnv = defaultCentralEnv(),
): Promise<CentralTemplateAdmin> {
  const input = parseInput(createCentralTemplateSchema, rawInput);
  const owner = input.ownerOrgUnitUuid;
  const targets = sortTargets(dedupeTargets(input.targets));
  const principalTargets = sortPrincipal(dedupePrincipalTargets(input.principalTargets));
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
    if (owner === null) {
      assertGlobalForOrgWide(principal);
    } else {
      // FOR SHARE: a concurrent deleteOrgUnit (FOR UPDATE) waits for us instead of racing the RESTRICT FK.
      const unit = await tx.query(`SELECT 1 FROM ${tbl(env, 'org_units')} WHERE uuid = $1::uuid FOR SHARE`, [owner]);
      const inScope =
        unit.rows.length > 0 && (await isOrgUnitWithinScope(principal, 'template.manage', owner, scopeEnv(env, tx)));
      if (!inScope) throw new NotFoundError('Organisationsenheden findes ikke', 'org_unit_not_found');
    }

    await assertTargetsInOwnerSubtree(env, tx, owner, targets);
    await assertPrincipalTargetsAllowed(env, tx, principal, principalTargets);

    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO ${tbl(env, 'central_templates')}
         (owner_org_unit_uuid, name, description, prompt,
          include_deltagere, include_beslutningspunkter, include_dagsorden, include_dato,
          allow_user_instruction, allow_toggle_overrides, status, current_version)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', 1)
       RETURNING id`,
      [
        owner,
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
      ...(owner ? { secondaryEntityId: owner } : {}),
      details: { version: 1, targetCount: targets.length, principalTargetCount: principalTargets.length },
    });
    return reload(env, tx, id);
  });
}

// ─── Update (content and/or targets) ───────────────────────────────────────

export async function updateCentralTemplate(
  principal: Principal,
  id: string,
  rawInput: z.input<typeof updateCentralTemplateSchema>,
  env: CentralEnv = defaultCentralEnv(),
): Promise<CentralTemplateAdmin> {
  const input = parseInput(updateCentralTemplateSchema, rawInput);

  return inTx(env, async (tx) => {
    const row = await loadManageable(env, tx, principal, id, true);
    await assertNoPrincipalTargetsUnlessGlobal(env, tx, principal, row.id);
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
    if (targetsChanged) await assertTargetsInOwnerSubtree(env, tx, row.owner_org_unit_uuid, nextTargets);
    if (principalChanged) {
      const had = new Set(currentPrincipal.map(principalKey));
      await assertPrincipalTargetsAllowed(
        env,
        tx,
        principal,
        nextPrincipal.filter((t) => !had.has(principalKey(t))),
      );
    }

    const newVersion = row.current_version + 1;
    const params: unknown[] = [row.id, row.current_version];
    const sets = changedFields.map((f) => {
      params.push(next[f]);
      return `${COLUMN[f]} = $${params.length}`;
    });
    // The version filter is a second line of defence behind the row lock.
    const updated = await tx.query<{ current_version: number }>(
      `UPDATE ${tbl(env, 'central_templates')}
          SET ${[...sets, 'current_version = current_version + 1', 'updated_at = now()'].join(', ')}
        WHERE id = $1::uuid AND current_version = $2
        RETURNING current_version`,
      params,
    );
    if (updated.rows.length === 0) {
      const now = await selectRow(env, tx, row.id, false);
      throw new VersionConflictError(now?.current_version ?? row.current_version);
    }

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
            ...ownerRef(row),
            details: { version: newVersion, targetCount: nextTargets.length, principalTargetCount: nextPrincipal.length },
          }
        : {
            type: 'central_template.update',
            actorUserId: principal.userId,
            entityId: row.id,
            ...ownerRef(row),
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
  });
}

// ─── Archive / restore ─────────────────────────────────────────────────────

async function changeStatus(
  principal: Principal,
  id: string,
  rawInput: z.input<typeof centralStateChangeSchema>,
  to: CentralStatus,
  env: CentralEnv,
): Promise<CentralTemplateAdmin> {
  const input = parseInput(centralStateChangeSchema, rawInput);
  const archiving = to === 'archived';

  return inTx(env, async (tx) => {
    const row = await loadManageable(env, tx, principal, id, true);
    await assertNoPrincipalTargetsUnlessGlobal(env, tx, principal, row.id);
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
    if (updated.rows.length === 0) {
      const now = await selectRow(env, tx, row.id, false);
      throw new VersionConflictError(now?.current_version ?? row.current_version);
    }

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
      ...ownerRef(row),
      details: { version: newVersion },
    });
    return reload(env, tx, row.id);
  });
}

export const archiveCentralTemplate = (
  principal: Principal,
  id: string,
  input: z.input<typeof centralStateChangeSchema>,
  env: CentralEnv = defaultCentralEnv(),
): Promise<CentralTemplateAdmin> => changeStatus(principal, id, input, 'archived', env);

export const restoreCentralTemplate = (
  principal: Principal,
  id: string,
  input: z.input<typeof centralStateChangeSchema>,
  env: CentralEnv = defaultCentralEnv(),
): Promise<CentralTemplateAdmin> => changeStatus(principal, id, input, 'active', env);

// ─── Reads ─────────────────────────────────────────────────────────────────

/**
 * Templates whose OWNER unit is inside the caller's template.manage scope; organisation-wide ones
 * (no owner) only for a global manager. Default filter: active only.
 */
export async function listManageableTemplates(
  principal: Principal,
  opts: { status?: CentralStatusFilter } = {},
  env: CentralEnv = defaultCentralEnv(),
): Promise<CentralTemplateListItem[]> {
  const q = env.runner;
  const scope = await orgUnitsInScope(principal, 'template.manage', scopeEnv(env, q));
  if (!scope.all && scope.uuids.length === 0) return [];

  const status = opts.status ?? 'active';
  const { rows } = await q.query<{
    id: string;
    name: string;
    description: string;
    owner_org_unit_uuid: string | null;
    status: string;
    current_version: number;
    target_count: number;
    updated_at: Date | string;
    created_by_name: string | null;
    last_edited_by_name: string | null;
    last_edited_at: Date | string | null;
  }>(
    `SELECT ct.id, ct.name, ct.description, ct.owner_org_unit_uuid, ct.status, ct.current_version, ct.updated_at,
            (SELECT count(*)::int FROM ${tbl(env, 'central_template_targets')} t WHERE t.template_id = ct.id) AS target_count,
            v1.changed_by_name AS created_by_name,
            vc.changed_by_name AS last_edited_by_name, vc.changed_at AS last_edited_at
       FROM ${tbl(env, 'central_templates')} ct
       LEFT JOIN ${tbl(env, 'central_template_versions')} v1 ON v1.template_id = ct.id AND v1.version = 1
       LEFT JOIN ${tbl(env, 'central_template_versions')} vc ON vc.template_id = ct.id AND vc.version = ct.current_version
      WHERE ($1::text IS NULL OR ct.status = $1)
        AND ($2::uuid[] IS NULL OR ct.owner_org_unit_uuid = ANY($2::uuid[]))
      ORDER BY ct.updated_at DESC, ct.id`,
    [status === 'all' ? null : status, scope.all ? null : scope.uuids],
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
    ownerOrgUnitUuid: r.owner_org_unit_uuid,
    status: r.status as CentralStatus,
    currentVersion: r.current_version,
    targetCount: r.target_count,
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

/** The changelog, newest first. Same scope rule as the template itself. */
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

/**
 * Org units the caller may use as owner or target: those inside the
 * template.manage scope (a global scope offers all). A parent outside the set
 * is hidden (parentUuid null), so a scoped manager learns nothing about the
 * units above its scope.
 */
export async function listScopeOrgUnits(
  principal: Principal,
  env: CentralEnv = defaultCentralEnv(),
): Promise<CentralScopeOrgUnit[]> {
  const scope = await orgUnitsInScope(principal, 'template.manage', scopeEnv(env, env.runner));
  if (!scope.all && scope.uuids.length === 0) return [];

  const { rows } = await env.runner.query<{ uuid: string; name: string; parent_uuid: string | null }>(
    `SELECT uuid, name, parent_uuid FROM ${tbl(env, 'org_units')}
      WHERE ($1::uuid[] IS NULL OR uuid = ANY($1::uuid[]))
      ORDER BY lower(name), uuid`,
    [scope.all ? null : scope.uuids],
  );
  const visible = new Set(rows.map((r) => r.uuid));
  return rows.map((r) => ({
    uuid: r.uuid,
    name: r.name,
    parentUuid: r.parent_uuid !== null && visible.has(r.parent_uuid) ? r.parent_uuid : null,
  }));
}

/**
 * The role/group catalogue as the target picker needs it: every entry (inactive ones too, so a
 * target that was withdrawn from the catalogue can still be named), both sources merged. Names and
 * identifiers only. Callers must hold template.manage; whether the caller may actually USE it for
 * targeting (global managers only) is the caller's `canTarget`.
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
