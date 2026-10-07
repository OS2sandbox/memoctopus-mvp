import { queryUserSchema, queryUserSchemaOne } from '@/lib/db/user-schema';
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

const snapshotOf = (s: Skabelon) => ({
  name: s.name,
  description: s.description,
  prompt: s.prompt,
  includeDeltagere: s.includeDeltagere,
  includeBeslutningspunkter: s.includeBeslutningspunkter,
  includeDagsorden: s.includeDagsorden,
  includeDato: s.includeDato,
});

/** Appends the next version row (own schema only). The note is optional and never leaves the user's schema. */
export async function recordSkabelonVersion(
  userId: string,
  skabelon: Skabelon,
  changedFields: readonly string[],
  changeNote: string | null,
): Promise<void> {
  await queryUserSchema(
    userId,
    `INSERT INTO skabelon_versions (skabelon_id, version, change_note, changed_fields, snapshot)
     SELECT $1, COALESCE(MAX(version), 0) + 1, $2, $3::text[], $4::jsonb
       FROM skabelon_versions WHERE skabelon_id = $1`,
    [skabelon.id, changeNote, [...changedFields], JSON.stringify(snapshotOf(skabelon))],
  );
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
  const row = await queryUserSchemaOne<SkabelonRow>(
    userId,
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
  const created = mapSkabelon(row!);
  await recordSkabelonVersion(userId, created, [], null);
  return created;
}

export async function updateSkabelon(
  userId: string,
  id: string,
  input: SkabelonInput,
): Promise<Skabelon | null> {
  const row = await queryUserSchemaOne<SkabelonRow>(
    userId,
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
  return row ? mapSkabelon(row) : null;
}

export async function deleteSkabelon(userId: string, id: string): Promise<boolean> {
  const rows = await queryUserSchema<{ id: string }>(
    userId,
    `DELETE FROM skabeloner WHERE id = $1 RETURNING id`,
    [id],
  );
  return rows.length > 0;
}
