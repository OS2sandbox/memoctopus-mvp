// User-side resolution of central (locked) templates: which ones a user
// RECEIVES, and the one the server uses for generation.
//
// Recipient rule: a user receives a template iff they are linked to a
// NON-disabled directory user (directory_users.app_user_id) AND EITHER
//  - ORG UNITS (dormant unless the directory is in use): they are a member of a target
//    unit, or of a DESCENDANT of a target unit when that target has include_descendants; or
//  - ROLES/GROUPS (claims mode): they hold, from their latest IdP login, a catalogue role or
//    group the template targets (public.user_external_roles). The row must be younger than
//    ROLE_CLAIMS_MAX_SECONDS (the same freshness the claims roles have) and the catalogue entry
//    must still be active; the branch is off outside ACCESS_SOURCE=claims.
// Unlinked or disabled users receive nothing (fail closed), archived templates are never
// returned. resolveCentralTemplate uses the very same predicate, so a non-recipient gets
// the identical "not found".
//
// The membership is computed with ONE query: a cycle-safe, depth-capped upward
// walk from the user's own units (UNION + depth cap, like scope.ts), so cost
// follows the user's ancestry chain, not the size of the org tree. Bad data
// (a cycle) terminates; anything deeper than MAX_ORG_DEPTH is not covered.
//
// Owner subtree, re-checked at READ time: a (template, target) pair counts only
// while the target is the template's owner unit or a descendant of it RIGHT NOW
// (a second capped upward walk from each matching target to the owner). Targets
// are validated on write, but a re-org or a local move can drift them out of the
// owner's scope afterwards; such a target silently stops delivering (fail closed),
// and so does restoring an archived template with stale targets. A template WITHOUT an
// owner is organisation-wide (only global managers write those): its unit targets count
// as they are.
//
// Prompt confidentiality is structural:
//  - listCentralForUser returns the prompt-free CentralSkabelonSummary and its
//    SQL does not even select the prompt column.
//  - Only resolveCentralTemplate (one id, server-side generation) reads the
//    prompt, and returns the separate internal ResolvedCentralTemplate type.
//    That value must never be serialised to a response, a log or an audit event.
import { pool } from '@/lib/db';
import { accessSource, roleClaimsMaxSeconds } from '@/lib/authz/config';
import { MAX_ORG_DEPTH } from '@/lib/authz/scope';
import type { CentralSkabelonSummary } from './central-types';

export interface ResolveEnv {
  /** Postgres schema holding the central/directory tables; 'public' in production. A trusted constant, never request input. */
  schema: string;
  query: (text: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  /**
   * How old (seconds) a user's role/group claims may be to count; null switches the role/group
   * branch off. Omitted: ROLE_CLAIMS_MAX_SECONDS in claims mode, else off. Test seam.
   */
  claimsMaxSeconds?: number | null;
}

function claimsMaxOf(env: ResolveEnv): number | null {
  if (env.claimsMaxSeconds !== undefined) return env.claimsMaxSeconds;
  return accessSource() === 'claims' ? roleClaimsMaxSeconds() : null;
}

export function defaultResolveEnv(): ResolveEnv {
  return { schema: 'public', query: (text, params) => pool.query(text, params) };
}

/** Server-internal: carries the prompt. Distinct from CentralSkabelonSummary on purpose. */
export interface ResolvedCentralTemplate {
  id: string;
  version: number;
  prompt: string;
  includeDeltagere: boolean;
  includeBeslutningspunkter: boolean;
  includeDagsorden: boolean;
  includeDato: boolean;
  allowUserInstruction: boolean;
  allowToggleOverrides: boolean;
}

const SCHEMA_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function qualified(env: ResolveEnv): (table: string) => string {
  if (!SCHEMA_RE.test(env.schema)) throw new Error('invalid schema name');
  return (table) => `"${env.schema}".${table}`;
}

// Columns shared by both reads. `prompt` is deliberately NOT in this list.
const SUMMARY_COLUMNS = `ct.id, ct.name, ct.description, ct.include_deltagere, ct.include_beslutningspunkter,
       ct.include_dagsorden, ct.include_dato, ct.allow_user_instruction, ct.allow_toggle_overrides,
       ct.current_version`;

/**
 * The recipient predicate; `$1` is the app user id, `$2` the depth cap, `$3` the claims freshness in
 * seconds (null = no role/group branch) and `$4` the template id when `byId`. Prefixed with a WITH
 * clause by the callers.
 *
 * Org-unit branch, four steps in one statement:
 *  - mine:  the user's own units (non-disabled linked directory user).
 *  - chain: those units plus their ancestors (capped upward walk).
 *  - cand:  (template, target) pairs of ACTIVE templates that match the user by membership. Only these
 *           are validated below, so the cost follows the user's ancestry, not the size of the target table.
 *  - walk:  from each candidate target upward through parent_uuid until it reaches the template's owner
 *           unit. A target counts only if the owner is reached within the cap (target = owner is depth 0),
 *           so a unit re-organised out of the owner's subtree stops delivering at READ time. Not reaching
 *           the owner (moved away, cycle, deeper than the cap, unknown) fails closed.
 */
function audienceSql(t: (table: string) => string, byId: boolean): { cte: string; where: string } {
  return {
    cte: `WITH RECURSIVE mine(uuid) AS (
         SELECT DISTINCT m.org_unit_uuid
           FROM ${t('directory_users')} d
           JOIN ${t('org_unit_members')} m ON m.directory_user_uuid = d.uuid
          WHERE d.app_user_id = $1 AND d.disabled = false
       ),
       chain(uuid, parent_uuid, depth) AS (
         SELECT u.uuid, u.parent_uuid, 0
           FROM ${t('org_units')} u
          WHERE u.uuid IN (SELECT uuid FROM mine)
         UNION
         SELECT p.uuid, p.parent_uuid, c.depth + 1
           FROM ${t('org_units')} p
           JOIN chain c ON p.uuid = c.parent_uuid
          WHERE c.depth < $2::int
       ),
       cand(template_id, target_uuid, owner_uuid) AS (
         SELECT DISTINCT tg.template_id, tg.org_unit_uuid, ct.owner_org_unit_uuid
           FROM ${t('central_template_targets')} tg
           JOIN ${t('central_templates')} ct ON ct.id = tg.template_id
          WHERE ct.status = 'active'${byId ? ' AND ct.id = $4::uuid' : ''}
            AND (tg.org_unit_uuid IN (SELECT uuid FROM mine)
                 OR (tg.include_descendants AND tg.org_unit_uuid IN (SELECT uuid FROM chain)))
       ),
       walk(template_id, target_uuid, owner_uuid, cur_uuid, depth) AS (
         SELECT c.template_id, c.target_uuid, c.owner_uuid, c.target_uuid, 0
           FROM cand c
         UNION
         SELECT w.template_id, w.target_uuid, w.owner_uuid, u.parent_uuid, w.depth + 1
           FROM walk w
           JOIN ${t('org_units')} u ON u.uuid = w.cur_uuid
          WHERE w.cur_uuid <> w.owner_uuid AND w.depth < $2::int
       )`,
    // Role/group branch: the user's claim row is fresh, the catalogue entry still active, and the
    // user is a linked, non-disabled directory user (same gate as the org-unit branch).
    where: `ct.status = 'active'
        AND (
          ct.id IN (SELECT w.template_id FROM walk w WHERE w.cur_uuid = w.owner_uuid)
          OR ct.id IN (SELECT c.template_id FROM cand c WHERE c.owner_uuid IS NULL)
          OR ct.id IN (
            SELECT pt.template_id
              FROM ${t('central_template_principal_targets')} pt
              JOIN ${t('user_external_roles')} ur ON ur.kind = pt.kind AND ur.identifier = pt.identifier
              JOIN ${t('external_roles')} er ON er.kind = pt.kind AND er.identifier = pt.identifier AND er.active
             WHERE $3::int IS NOT NULL
               AND ur.user_id = $1
               AND ur.seen_at > now() - make_interval(secs => $3::int)
               AND EXISTS (SELECT 1 FROM ${t('directory_users')} d WHERE d.app_user_id = $1 AND d.disabled = false)
          )
        )`,
  };
}

function summaryOf(r: Record<string, unknown>): CentralSkabelonSummary {
  return {
    id: String(r.id),
    source: 'central',
    name: String(r.name),
    description: String(r.description ?? ''),
    includeDeltagere: r.include_deltagere === true,
    includeBeslutningspunkter: r.include_beslutningspunkter === true,
    includeDagsorden: r.include_dagsorden === true,
    includeDato: r.include_dato === true,
    locked: true,
    version: Number(r.current_version),
    allowUserInstruction: r.allow_user_instruction === true,
    allowToggleOverrides: r.allow_toggle_overrides === true,
  };
}

export async function listCentralForUser(
  userId: string,
  env: ResolveEnv = defaultResolveEnv(),
): Promise<CentralSkabelonSummary[]> {
  if (!userId) return [];
  const t = qualified(env);
  const { cte, where } = audienceSql(t, false);
  const { rows } = await env.query(
    `${cte}
     SELECT ${SUMMARY_COLUMNS}
       FROM ${t('central_templates')} ct
      WHERE ${where}
      ORDER BY lower(ct.name), ct.id`,
    [userId, MAX_ORG_DEPTH, claimsMaxOf(env)],
  );
  return rows.map(summaryOf);
}

/**
 * The template the server generates with, or null when the id is not a uuid,
 * unknown, archived or the user is not a recipient (callers must answer all
 * four identically so existence does not leak).
 */
export async function resolveCentralTemplate(
  userId: string,
  id: string,
  env: ResolveEnv = defaultResolveEnv(),
): Promise<ResolvedCentralTemplate | null> {
  if (!userId || typeof id !== 'string' || !UUID_RE.test(id)) return null;
  const t = qualified(env);
  const { cte, where } = audienceSql(t, true);
  const { rows } = await env.query(
    `${cte}
     SELECT ${SUMMARY_COLUMNS}, ct.prompt
       FROM ${t('central_templates')} ct
      WHERE ct.id = $4::uuid AND ${where}`,
    [userId, MAX_ORG_DEPTH, claimsMaxOf(env), id.toLowerCase()],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: String(r.id),
    version: Number(r.current_version),
    prompt: String(r.prompt ?? ''),
    includeDeltagere: r.include_deltagere === true,
    includeBeslutningspunkter: r.include_beslutningspunkter === true,
    includeDagsorden: r.include_dagsorden === true,
    includeDato: r.include_dato === true,
    allowUserInstruction: r.allow_user_instruction === true,
    allowToggleOverrides: r.allow_toggle_overrides === true,
  };
}
