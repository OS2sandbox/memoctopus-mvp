import { safeLogError } from '@/lib/audit/safe-log';
import { queryUserSchema, queryUserSchemaOne, withUserSchemaTx, type UserSchemaTxQuery } from '@/lib/db/user-schema';
import type { Skabelon } from '@/types';

// Raw row shape from the per-user `skabeloner` table.
export interface SkabelonRow {
  id: string;
  name: string;
  description: string;
  prompt: string;
  include_deltagere: boolean;
  include_beslutningspunkter: boolean;
  include_dagsorden: boolean;
  include_dato: boolean;
  is_default: boolean;
  created_at: string | Date;
  updated_at: string | Date;
}

function iso(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : v;
}

export function mapSkabelon(row: SkabelonRow): Skabelon {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    prompt: row.prompt,
    includeDeltagere: row.include_deltagere,
    includeBeslutningspunkter: row.include_beslutningspunkter,
    includeDagsorden: row.include_dagsorden,
    includeDato: row.include_dato,
    isDefault: row.is_default,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export interface SkabelonInput {
  name: string;
  description?: string;
  prompt?: string;
  includeDeltagere?: boolean;
  includeBeslutningspunkter?: boolean;
  includeDagsorden?: boolean;
  includeDato?: boolean;
}

export async function listSkabeloner(userId: string): Promise<Skabelon[]> {
  const rows = await queryUserSchema<SkabelonRow>(
    userId,
    `SELECT * FROM skabeloner ORDER BY is_default DESC, updated_at DESC`,
  );
  return rows.map(mapSkabelon);
}

export async function getSkabelon(userId: string, id: string): Promise<Skabelon | null> {
  const row = await queryUserSchemaOne<SkabelonRow>(
    userId,
    `SELECT * FROM skabeloner WHERE id = $1`,
    [id],
  );
  return row ? mapSkabelon(row) : null;
}

export async function getDefaultSkabelon(userId: string): Promise<Skabelon | null> {
  const row = await queryUserSchemaOne<SkabelonRow>(
    userId,
    `SELECT * FROM skabeloner ORDER BY is_default DESC, created_at ASC LIMIT 1`,
  );
  return row ? mapSkabelon(row) : null;
}

// Make one skabelon the user's default. Enforces the single-default invariant in
// a single statement: every row's flag becomes (id = chosen), so the chosen row
// turns true and all others turn false. Returns null if the id doesn't exist.
export async function setDefaultSkabelon(userId: string, id: string): Promise<Skabelon | null> {
  const existing = await getSkabelon(userId, id);
  if (!existing) return null;
  await queryUserSchema(userId, `UPDATE skabeloner SET is_default = (id = $1)`, [id]);
  return getSkabelon(userId, id);
}

// ─── Own changelog (skabelon_versions, per-user schema) ─────────────────────────

export interface SkabelonVersion {
  version: number;
  changeNote: string | null;
  /** Field NAMES that changed in this version (empty for the first one). */
  changedFields: string[];
  createdAt: string;
}

interface VersionRow {
  version: number;
  change_note: string | null;
  changed_fields: string[];
  created_at: string | Date;
}

/** The content fields a version tracks. Field NAMES only ever reach the audit log. */
export const TRACKED_FIELDS = [
  'name',
  'description',
  'prompt',
  'includeDeltagere',
  'includeBeslutningspunkter',
  'includeDagsorden',
  'includeDato',
] as const;

export function changedSkabelonFields(prev: Skabelon, next: Skabelon) {
  return TRACKED_FIELDS.filter((f) => prev[f] !== next[f]);
}

// Versions are never pruned: older audit events name (template, version) and the viewer looks the note
// up by it, so deleting a row would silently lose a note an event still points at.
const INSERT_VERSION_SQL = `INSERT INTO skabelon_versions (skabelon_id, version, change_note, changed_fields)
     SELECT $1, COALESCE(MAX(version), 0) + 1, $2, $3::text[]
       FROM skabelon_versions WHERE skabelon_id = $1`;

const versionParams = (skabelon: Skabelon, changedFields: readonly string[], changeNote: string | null) => [
  skabelon.id,
  changeNote,
  [...changedFields],
];

// Inside a transaction: the changelog is a convenience for the person, so a failure to write it must
// never undo or hide the edit itself. It runs under a savepoint (a failed statement would otherwise
// poison the transaction), and the failure is logged without content.
async function bestEffortVersion(q: UserSchemaTxQuery, write: () => Promise<void>): Promise<void> {
  await q('SAVEPOINT skabelon_version');
  try {
    await write();
    await q('RELEASE SAVEPOINT skabelon_version');
  } catch (err) {
    safeLogError('skabeloner version', err);
    await q('ROLLBACK TO SAVEPOINT skabelon_version');
  }
}

/** Newest first. null when the template does not exist in the user's schema. */
export async function listSkabelonVersions(userId: string, id: string): Promise<SkabelonVersion[] | null> {
  if (!(await getSkabelon(userId, id))) return null;
  const rows = await queryUserSchema<VersionRow>(
    userId,
    `SELECT version, change_note, changed_fields, created_at
       FROM skabelon_versions WHERE skabelon_id = $1 ORDER BY version DESC LIMIT 200`,
    [id],
  );
  return rows.map((r) => ({
    version: r.version,
    changeNote: r.change_note,
    changedFields: r.changed_fields ?? [],
    createdAt: iso(r.created_at),
  }));
}

export async function createSkabelon(userId: string, input: SkabelonInput): Promise<Skabelon> {
  // The row and its version 1 in one transaction: a template never exists without its changelog start
  // because of a failed second write (and a failed changelog write cannot lose the template either).
  return withUserSchemaTx(userId, async (q) => {
    const [row] = await q<SkabelonRow>(
      `INSERT INTO skabeloner
         (name, description, prompt, include_deltagere, include_beslutningspunkter, include_dagsorden, include_dato)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.name,
        input.description ?? '',
        input.prompt ?? '',
        input.includeDeltagere ?? false,
        input.includeBeslutningspunkter ?? false,
        input.includeDagsorden ?? false,
        input.includeDato ?? false,
      ],
    );
    const created = mapSkabelon(row);
    await bestEffortVersion(q, async () => void (await q(INSERT_VERSION_SQL, versionParams(created, [], null))));
    return created;
  });
}

export interface SkabelonUpdateResult {
  skabelon: Skabelon;
  /** Field names whose value changed (empty when only a note was written, or nothing changed). */
  changedFields: Array<(typeof TRACKED_FIELDS)[number]>;
  /** The history version this edit wrote (the audit event names it so the note can be looked up); null when none was written. */
  version: number | null;
}

/**
 * Updates a template and writes its changelog entry in ONE transaction, with the row locked first, so
 * concurrent edits are applied one after the other and number their versions without collisions.
 *  - an entry is written when a field changed OR the person typed a note (a note alone is kept);
 *  - a template that predates the changelog gets its version 1 (the state before this edit) lazily.
 * Returns null when the template does not exist.
 */
export async function updateSkabelonWithHistory(
  userId: string,
  id: string,
  input: SkabelonInput,
  changeNote: string | null,
): Promise<SkabelonUpdateResult | null> {
  return withUserSchemaTx(userId, async (q) => {
    const [before] = await q<SkabelonRow>(`SELECT * FROM skabeloner WHERE id = $1 FOR UPDATE`, [id]);
    if (!before) return null;
    const prev = mapSkabelon(before);
    const [row] = await q<SkabelonRow>(
      `UPDATE skabeloner SET
         name = $2,
         description = $3,
         prompt = $4,
         include_deltagere = $5,
         include_beslutningspunkter = $6,
         include_dagsorden = $7,
         include_dato = $8,
         updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        input.name,
        input.description ?? '',
        input.prompt ?? '',
        input.includeDeltagere ?? false,
        input.includeBeslutningspunkter ?? false,
        input.includeDagsorden ?? false,
        input.includeDato ?? false,
      ],
    );
    const skabelon = mapSkabelon(row);
    const changed = changedSkabelonFields(prev, skabelon);
    let version: number | null = null;
    if (changed.length > 0 || changeNote !== null) {
      await bestEffortVersion(q, async () => {
        // A template that predates the changelog gets its version 1 (the state before this edit) first.
        await q(
          `INSERT INTO skabelon_versions (skabelon_id, version, change_note, changed_fields)
           SELECT $1, 1, NULL, '{}'::text[]
            WHERE NOT EXISTS (SELECT 1 FROM skabelon_versions WHERE skabelon_id = $1)`,
          [id],
        );
        const [written] = await q<{ version: number }>(
          `${INSERT_VERSION_SQL} RETURNING version`,
          versionParams(skabelon, changed, changeNote),
        );
        version = written?.version ?? null;
      });
    }
    return { skabelon, changedFields: changed, version };
  });
}

export async function deleteSkabelon(userId: string, id: string): Promise<boolean> {
  const rows = await queryUserSchema<{ id: string }>(
    userId,
    `DELETE FROM skabeloner WHERE id = $1 RETURNING id`,
    [id],
  );
  return rows.length > 0;
}
