// User-side resolution of central (locked) templates: which ones a user
// RECEIVES, and the one the server uses for generation.
//
// Recipient rule: a user receives a template iff they are linked to a
// NON-disabled directory user (directory_users.app_user_id) who is a member of
// a target unit, or of a DESCENDANT of a target unit when that target has
// include_descendants. Unlinked or disabled users receive nothing (fail closed),
// archived templates are never returned.
//
// The membership is computed with ONE query: a cycle-safe, depth-capped upward
// walk from the user's own units (UNION + depth cap, like scope.ts), so cost
// follows the user's ancestry chain, not the size of the org tree. Bad data
// (a cycle) terminates; anything deeper than MAX_ORG_DEPTH is not covered.
//
// Prompt confidentiality is structural:
//  - listCentralForUser returns the prompt-free CentralSkabelonSummary and its
//    SQL does not even select the prompt column.
//  - Only resolveCentralTemplate (one id, server-side generation) reads the
//    prompt, and returns the separate internal ResolvedCentralTemplate type.
//    That value must never be serialised to a response, a log or an audit event.
import { pool } from '@/lib/db';
import { MAX_ORG_DEPTH } from '@/lib/authz/scope';
import type { CentralSkabelonSummary } from './central-types';

export interface ResolveEnv {
  /** Postgres schema holding the central/directory tables; 'public' in production. A trusted constant, never request input. */
  schema: string;
  query: (text: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
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

/** The recipient predicate; `$1` is the app user id, `$2` the depth cap. Prefixed with a WITH clause by the callers. */
function audienceSql(t: (table: string) => string): { cte: string; where: string } {
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
       )`,
    // A target matches the user's own unit exactly, or any ancestor of it when the target includes descendants.
    where: `ct.status = 'active'
        AND EXISTS (
          SELECT 1 FROM ${t('central_template_targets')} tg
           WHERE tg.template_id = ct.id
             AND (tg.org_unit_uuid IN (SELECT uuid FROM mine)
                  OR (tg.include_descendants AND tg.org_unit_uuid IN (SELECT uuid FROM chain)))
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
  const { cte, where } = audienceSql(t);
  const { rows } = await env.query(
    `${cte}
     SELECT ${SUMMARY_COLUMNS}
       FROM ${t('central_templates')} ct
      WHERE ${where}
      ORDER BY lower(ct.name), ct.id`,
    [userId, MAX_ORG_DEPTH],
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
  const { cte, where } = audienceSql(t);
  const { rows } = await env.query(
    `${cte}
     SELECT ${SUMMARY_COLUMNS}, ct.prompt
       FROM ${t('central_templates')} ct
      WHERE ct.id = $3::uuid AND ${where}`,
    [userId, MAX_ORG_DEPTH, id.toLowerCase()],
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
