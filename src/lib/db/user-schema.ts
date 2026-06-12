import { pool } from './index';

function schemaName(userId: string): string {
  return `u_${userId.replace(/-/g, '_')}`;
}

export async function ensureUserSchema(userId: string): Promise<void> {
  const schema = schemaName(userId);
  const client = await pool.connect();

  try {
    // Create schema and enum outside of any transaction — ALTER TYPE ADD VALUE
    // cannot run inside a transaction block on PostgreSQL < 12.
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname = 'meeting_status'
            AND n.nspname = '${schema}'
        ) THEN
          CREATE TYPE "${schema}".meeting_status
            AS ENUM ('joining','recording','processing','review','minutes','done','redacted');
        END IF;
      END
      $$
    `);

    // Ensure values added after initial schema creation exist.
    // Must run outside a transaction block.
    await client.query(`
      ALTER TYPE "${schema}".meeting_status ADD VALUE IF NOT EXISTS 'redacted'
    `);

    await client.query(`
      ALTER TYPE "${schema}".meeting_status ADD VALUE IF NOT EXISTS 'joining'
    `);

    await client.query(`
      ALTER TYPE "${schema}".meeting_status ADD VALUE IF NOT EXISTS 'cancelled'
    `);

    await client.query('BEGIN');

    // templates
    await client.query(`
      CREATE TABLE IF NOT EXISTS "${schema}".templates (
        id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        structure   JSONB NOT NULL DEFAULT '{"sections":[]}',
        is_default  BOOLEAN NOT NULL DEFAULT FALSE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // meetings
    await client.query(`
      CREATE TABLE IF NOT EXISTS "${schema}".meetings (
        id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        title        TEXT NOT NULL,
        participants TEXT[] NOT NULL DEFAULT '{}',
        status       "${schema}".meeting_status NOT NULL DEFAULT 'recording',
        redacted_at  TIMESTAMPTZ,
        redacted_by  TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      ALTER TABLE "${schema}".meetings
        ADD COLUMN IF NOT EXISTS redacted_at  TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS redacted_by  TEXT,
        ADD COLUMN IF NOT EXISTS source       TEXT NOT NULL DEFAULT 'local',
        ADD COLUMN IF NOT EXISTS meeting_url  TEXT,
        ADD COLUMN IF NOT EXISTS bot_session  TEXT
    `);

    // audio_files
    await client.query(`
      CREATE TABLE IF NOT EXISTS "${schema}".audio_files (
        id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        meeting_id       TEXT NOT NULL REFERENCES "${schema}".meetings(id) ON DELETE CASCADE,
        filename         TEXT NOT NULL,
        size_bytes       BIGINT NOT NULL DEFAULT 0,
        duration_seconds NUMERIC,
        deleted_at       TIMESTAMPTZ
      )
    `);

    // transcripts
    await client.query(`
      CREATE TABLE IF NOT EXISTS "${schema}".transcripts (
        id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        meeting_id       TEXT NOT NULL REFERENCES "${schema}".meetings(id) ON DELETE CASCADE,
        raw_text         TEXT NOT NULL DEFAULT '',
        segments         JSONB NOT NULL DEFAULT '[]',
        pii_removed_at   TIMESTAMPTZ,
        pii_replacements JSONB NOT NULL DEFAULT '[]'
      )
    `);

    await client.query(`
      ALTER TABLE "${schema}".transcripts
      ADD COLUMN IF NOT EXISTS pii_replacements JSONB NOT NULL DEFAULT '[]'
    `);

    await client.query(`
      ALTER TABLE "${schema}".transcripts
      ADD COLUMN IF NOT EXISTS chapters JSONB NOT NULL DEFAULT '[]'
    `);

    await client.query(`
      ALTER TABLE "${schema}".transcripts
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    `);

    // Remove duplicate transcript rows (keep the one with the largest id per meeting),
    // then enforce uniqueness so each meeting has at most one transcript.
    await client.query(`
      DELETE FROM "${schema}".transcripts
      WHERE id NOT IN (
        SELECT DISTINCT ON (meeting_id) id
        FROM "${schema}".transcripts
        ORDER BY meeting_id, id DESC
      )
    `);

    await client.query(`
      DO $body$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint c
          JOIN pg_class cl ON cl.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = cl.relnamespace
          WHERE c.conname = 'transcripts_meeting_id_unique'
            AND n.nspname = '${schema}'
        ) THEN
          ALTER TABLE "${schema}".transcripts
            ADD CONSTRAINT transcripts_meeting_id_unique UNIQUE (meeting_id);
        END IF;
      END
      $body$
    `);

    // minutes
    await client.query(`
      CREATE TABLE IF NOT EXISTS "${schema}".minutes (
        id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        meeting_id  TEXT NOT NULL REFERENCES "${schema}".meetings(id) ON DELETE CASCADE,
        template_id TEXT REFERENCES "${schema}".templates(id) ON DELETE SET NULL,
        content     JSONB NOT NULL DEFAULT '{"sections":[]}',
        version     INTEGER NOT NULL DEFAULT 1,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // minute_versions
    await client.query(`
      CREATE TABLE IF NOT EXISTS "${schema}".minute_versions (
        id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        meeting_id TEXT NOT NULL REFERENCES "${schema}".meetings(id) ON DELETE CASCADE,
        minutes_id TEXT NOT NULL REFERENCES "${schema}".minutes(id) ON DELETE CASCADE,
        content    JSONB NOT NULL DEFAULT '{"sections":[]}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Auto-prune versions older than 7 days (best-effort function)
    await client.query(`
      CREATE OR REPLACE FUNCTION "${schema}".prune_old_versions()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        DELETE FROM "${schema}".minute_versions
        WHERE created_at < NOW() - INTERVAL '7 days';
        RETURN NEW;
      END;
      $$
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE t.tgname = 'prune_versions_trigger'
            AND n.nspname = '${schema}'
            AND c.relname = 'minute_versions'
        ) THEN
          CREATE TRIGGER prune_versions_trigger
          AFTER INSERT ON "${schema}".minute_versions
          FOR EACH STATEMENT EXECUTE FUNCTION "${schema}".prune_old_versions();
        END IF;
      END
      $$
    `);

    // Seed default templates if none exist
    await client.query(`
      INSERT INTO "${schema}".templates (name, description, structure, is_default)
      SELECT * FROM (VALUES
        (
          'Bestyrelsesmøde',
          'Til formelle bestyrelsesmøder med dagsorden og beslutningspunkter',
          '{"sections":[
            {"key":"deltagere","label":"Deltagere","description":"Navne og roller på mødedeltagere","required":true},
            {"key":"dagsorden","label":"Dagsorden","description":"Punkter til behandling","required":true},
            {"key":"beslutninger","label":"Beslutninger","description":"Trufne beslutninger med ansvarlige og deadlines","required":true},
            {"key":"handlinger","label":"Handlingspunkter","description":"Hvem gør hvad hvornår","required":true},
            {"key":"naeste_mode","label":"Næste møde","description":"Dato, tid og sted for næste møde","required":false}
          ]}'::jsonb,
          TRUE
        ),
        (
          'Personalemøde',
          'Til interne personalemøder og teamopdateringer',
          '{"sections":[
            {"key":"deltagere","label":"Deltagere","required":true},
            {"key":"status","label":"Statusopdateringer","description":"Nyheder fra teamet","required":true},
            {"key":"udfordringer","label":"Udfordringer og løsninger","required":false},
            {"key":"handlinger","label":"Handlingspunkter","required":true},
            {"key":"naeste_mode","label":"Næste møde","required":false}
          ]}'::jsonb,
          FALSE
        ),
        (
          'Forældresamtale',
          'Til skole-hjem samtaler og forældremøder',
          '{"sections":[
            {"key":"deltagere","label":"Deltagere","required":true},
            {"key":"trivsel","label":"Trivsel og velvære","description":"Barnets trivsel i skolen","required":true},
            {"key":"fagligt","label":"Faglig udvikling","required":true},
            {"key":"aftaler","label":"Aftaler","description":"Hvad er vi blevet enige om","required":true},
            {"key":"opfoelgning","label":"Opfølgning","required":false}
          ]}'::jsonb,
          FALSE
        ),
        (
          'Projektmøde',
          'Til projektstyring og koordineringsmøder',
          '{"sections":[
            {"key":"deltagere","label":"Deltagere","required":true},
            {"key":"status","label":"Projektstatus","description":"Fremdrift siden sidst","required":true},
            {"key":"risici","label":"Risici og blokeringer","required":false},
            {"key":"beslutninger","label":"Beslutninger","required":true},
            {"key":"handlinger","label":"Handlingspunkter","required":true},
            {"key":"naeste_mode","label":"Næste møde","required":false}
          ]}'::jsonb,
          FALSE
        )
      ) AS t(name, description, structure, is_default)
      WHERE NOT EXISTS (SELECT 1 FROM "${schema}".templates LIMIT 1)
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
  try {
    const schema = schemaName(userId);
    await client.query(`SET search_path TO "${schema}", public`);
    const result = await client.query(sql, params);
    return result.rows as T[];
  } finally {
    client.release();
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
