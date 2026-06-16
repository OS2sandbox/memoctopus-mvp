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
  return mapSkabelon(row!);
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
