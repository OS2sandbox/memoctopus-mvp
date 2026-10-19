import { pool } from './index';

function schemaName(userId: string): string {
  return `u_${userId.replace(/-/g, '_')}`;
}

export async function ensureUserSchema(userId: string): Promise<void> {
  const schema = schemaName(userId);
  const client = await pool.connect();

  try {
    // A person's schema holds only skabeloner and skabelon_versions. Schemas created by older versions
    // still carry unused meetings/transcripts/minutes/minute_versions/audio_files/templates tables and a
    // meeting_status enum; they are deliberately left in place (never created, never dropped here).
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);

    await client.query('BEGIN');

    // skabeloner — reusable, shareable prompts for generating a referat
    await client.query(`
      CREATE TABLE IF NOT EXISTS "${schema}".skabeloner (
        id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        name         TEXT NOT NULL,
        description  TEXT NOT NULL DEFAULT '',
        prompt       TEXT NOT NULL DEFAULT '',
        include_deltagere          BOOLEAN NOT NULL DEFAULT FALSE,
        include_beslutningspunkter BOOLEAN NOT NULL DEFAULT FALSE,
        include_dagsorden          BOOLEAN NOT NULL DEFAULT FALSE,
        include_dato               BOOLEAN NOT NULL DEFAULT FALSE,
        is_default   BOOLEAN NOT NULL DEFAULT FALSE,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Backfill the Dato flag onto skabeloner tables created before it existed.
    await client.query(`
      ALTER TABLE "${schema}".skabeloner
        ADD COLUMN IF NOT EXISTS include_dato BOOLEAN NOT NULL DEFAULT FALSE
    `);

    // skabelon_versions — the person's own changelog of a personal skabelon. Own data in own
    // schema: the optional note they wrote lives ONLY here, never in the audit log.
    await client.query(`
      CREATE TABLE IF NOT EXISTS "${schema}".skabelon_versions (
        id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        skabelon_id    TEXT NOT NULL REFERENCES "${schema}".skabeloner(id) ON DELETE CASCADE,
        version        INTEGER NOT NULL,
        change_note    TEXT,
        changed_fields TEXT[] NOT NULL DEFAULT '{}',
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (skabelon_id, version)
      )
    `);

    // Earlier versions of the app also stored a (never read) JSONB copy of the prompt per version. It is
    // no longer written; relax a NOT NULL on schemas that still have the column, and keep its data.
    const legacySnapshot = await client.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'skabelon_versions'
          AND column_name = 'snapshot' AND is_nullable = 'NO'`,
      [schema],
    );
    if (legacySnapshot?.rows?.length) {
      await client.query(`ALTER TABLE "${schema}".skabelon_versions ALTER COLUMN snapshot DROP NOT NULL`);
    }

    // Seed default skabeloner (prompt-based) if none exist
    await client.query(`
      INSERT INTO "${schema}".skabeloner
        (name, description, prompt, include_deltagere, include_beslutningspunkter, include_dagsorden, is_default)
      SELECT * FROM (VALUES
        (
          'Bestyrelsesmøde',
          'Til formelle bestyrelsesmøder med dagsorden og beslutningspunkter',
          'Udarbejd et formelt mødereferat for et bestyrelsesmøde. Skriv i et professionelt, klart sprog. Fremhæv beslutninger, ansvarlige og deadlines, og afslut med eventuelle handlingspunkter og næste møde.',
          TRUE, TRUE, TRUE, TRUE
        ),
        (
          'Personalemøde',
          'Til interne personalemøder og teamopdateringer',
          'Udarbejd et referat for et personalemøde. Opsummer statusopdateringer, drøftede punkter samt aftaler og opfølgning. Hold tonen uformel men præcis.',
          TRUE, FALSE, FALSE, FALSE
        ),
        (
          'Forældresamtale',
          'Til skole-hjem samtaler og forældremøder',
          'Udarbejd et kort referat for en forældresamtale. Beskriv barnets trivsel og faglige udvikling, samt de aftaler der blev indgået. Vær konkret og respektfuld.',
          TRUE, FALSE, FALSE, FALSE
        ),
        (
          'Projektmøde',
          'Til projektstyring og koordineringsmøder',
          'Udarbejd et referat for et projektmøde. Beskriv projektstatus og fremdrift, risici og blokeringer, beslutninger samt handlingspunkter med ansvarlige.',
          TRUE, TRUE, FALSE, FALSE
        )
      ) AS s(name, description, prompt, include_deltagere, include_beslutningspunkter, include_dagsorden, is_default)
      WHERE NOT EXISTS (SELECT 1 FROM "${schema}".skabeloner LIMIT 1)
    `);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export function getUserSchemaName(userId: string): string {
  return schemaName(userId);
}

// ─── Per-user query helpers ─────────────────────────────────────────────────

const globalForSchema = globalThis as unknown as { initializedSchemas: Set<string> | undefined };
if (!globalForSchema.initializedSchemas) globalForSchema.initializedSchemas = new Set<string>();
const initializedSchemas = globalForSchema.initializedSchemas;

export async function queryUserSchema<T = Record<string, unknown>>(
  userId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  if (!initializedSchemas.has(userId)) {
    await ensureUserSchema(userId);
    initializedSchemas.add(userId);
  }
  const client = await pool.connect();
  let discard = false;
  try {
    const schema = schemaName(userId);
    await client.query(`SET search_path TO "${schema}", public`);
    const result = await client.query(sql, params);
    return result.rows as T[];
  } finally {
    // The pooled connection would otherwise keep this user's search_path for the
    // next borrower. If the reset fails its state is unknown, so destroy it.
    try {
      await client.query('RESET search_path');
    } catch {
      discard = true;
    }
    client.release(discard);
  }
}

export async function queryUserSchemaOne<T = Record<string, unknown>>(
  userId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await queryUserSchema<T>(userId, sql, params);
  return rows[0] ?? null;
}

/** The query function handed to a `withUserSchemaTx` callback: same search_path, same transaction. */
export type UserSchemaTxQuery = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;

/**
 * Runs `fn` in ONE transaction on one connection with the user's search_path (BEGIN ... COMMIT, ROLLBACK
 * when `fn` throws). For changes that must be atomic (a template row and its changelog row) or
 * serialised by a row lock (SELECT ... FOR UPDATE).
 */
export async function withUserSchemaTx<T>(userId: string, fn: (query: UserSchemaTxQuery) => Promise<T>): Promise<T> {
  if (!initializedSchemas.has(userId)) {
    await ensureUserSchema(userId);
    initializedSchemas.add(userId);
  }
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    try {
      // LOCAL: the setting ends with the transaction (COMMIT or ROLLBACK), so nothing leaks to the next
      // borrower of the pooled connection and no RESET is needed.
      await client.query(`SET LOCAL search_path TO "${schemaName(userId)}", public`);
      const out = await fn(async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
        const result = await client.query(sql, params);
        return result.rows as R[];
      });
      await client.query('COMMIT');
      return out;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
      throw err;
    }
  } finally {
    // A failed ROLLBACK leaves the connection in an unknown state: destroy it.
    client.release(discard);
  }
}
