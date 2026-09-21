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

    // Microsoft Graph / Teams: a meeting is armed and waits for Teams to finish
    // recording + transcribing it. This replaced the removed bot's 'joining'.
    // That value stays in the enum because Postgres cannot drop one, and an
    // existing database already carries it. Nothing writes it any more.
    await client.query(`
      ALTER TYPE "${schema}".meeting_status ADD VALUE IF NOT EXISTS 'awaiting_teams'
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

    // teams_meetings — server-side record of a Teams meeting armed via Microsoft
    // Graph, so the poller knows what to fetch artifacts for.
    await client.query(`
      CREATE TABLE IF NOT EXISTS "${schema}".teams_meetings (
        id               TEXT PRIMARY KEY,
        graph_meeting_id TEXT NOT NULL,
        join_url         TEXT NOT NULL,
        subject          TEXT,
        organizer_id     TEXT,
        event_id         TEXT,
        is_organizer     BOOLEAN NOT NULL DEFAULT FALSE,
        armed            BOOLEAN NOT NULL DEFAULT FALSE,
        arm_result       TEXT NOT NULL DEFAULT 'not_organizer',
        scheduled_start  TIMESTAMPTZ,
        scheduled_end    TIMESTAMPTZ,
        state            TEXT NOT NULL DEFAULT 'awaiting_teams',
        last_polled_at   TIMESTAMPTZ,
        attempts         INTEGER NOT NULL DEFAULT 0,
        failure_reason   TEXT,
        transcript_id    TEXT,
        recording_id     TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      ALTER TABLE "${schema}".teams_meetings
        ADD COLUMN IF NOT EXISTS organizer_id  TEXT,
        ADD COLUMN IF NOT EXISTS is_organizer  BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS armed         BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS arm_result    TEXT NOT NULL DEFAULT 'not_organizer',
        ADD COLUMN IF NOT EXISTS event_id      TEXT,
        ADD COLUMN IF NOT EXISTS transcript_id TEXT,
        ADD COLUMN IF NOT EXISTS recording_id  TEXT,
        ADD COLUMN IF NOT EXISTS original_options JSONB,
        ADD COLUMN IF NOT EXISTS created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS teams_meetings_graph_meeting_id_idx
        ON "${schema}".teams_meetings (graph_meeting_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS teams_meetings_state_idx
        ON "${schema}".teams_meetings (state, scheduled_end)
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

    // onboarding_progress — which onboarding hints this user has seen/dismissed
    await client.query(`
      CREATE TABLE IF NOT EXISTS "${schema}".onboarding_progress (
        id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        step_id     TEXT NOT NULL,
        meeting_id  TEXT,
        status      TEXT NOT NULL DEFAULT 'seen',
        seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // meeting_id is a plain id, NOT a foreign key: meetings live in the browser's IndexedDB
    // and nothing inserts into this schema's meetings table, so a REFERENCES there rejects
    // every per-meeting hint. Databases that already created the table with the constraint
    // lose it here (idempotent).
    await client.query(`
      ALTER TABLE "${schema}".onboarding_progress
        DROP CONSTRAINT IF EXISTS onboarding_progress_meeting_id_fkey
    `);

    await client.query(`
      DO $body$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint c
          JOIN pg_class cl ON cl.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = cl.relnamespace
          WHERE c.conname = 'onboarding_progress_step_meeting_unique'
            AND n.nspname = '${schema}'
        ) THEN
          ALTER TABLE "${schema}".onboarding_progress
            ADD CONSTRAINT onboarding_progress_step_meeting_unique UNIQUE (step_id, meeting_id);
        END IF;
      END
      $body$
    `);

    // Postgres treats every NULL as distinct under a plain UNIQUE constraint, so
    // the constraint above only dedupes per-meeting rows. Global steps (no
    // meeting_id) need a separate partial index to stay idempotent on upsert.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS onboarding_progress_global_step_unique
        ON "${schema}".onboarding_progress (step_id)
        WHERE meeting_id IS NULL
    `);

    // onboarding_state — single-row per-user flags for the guided tour as a whole
    await client.query(`
      CREATE TABLE IF NOT EXISTS "${schema}".onboarding_state (
        id                 TEXT PRIMARY KEY DEFAULT 'singleton',
        tour_skipped_at    TIMESTAMPTZ,
        tour_completed_at  TIMESTAMPTZ,
        last_step_id       TEXT,
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
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

const globalForSchema = globalThis as unknown as {
  initializedSchemas: Set<string> | undefined;
  ensuringSchemas: Map<string, Promise<void>> | undefined;
};
if (!globalForSchema.initializedSchemas) globalForSchema.initializedSchemas = new Set<string>();
if (!globalForSchema.ensuringSchemas) globalForSchema.ensuringSchemas = new Map<string, Promise<void>>();
const initializedSchemas = globalForSchema.initializedSchemas;
// Tracks in-flight ensureUserSchema() calls per user so concurrent callers
// (e.g. two queryUserSchema calls fired in the same Promise.all) await the
// SAME run instead of each racing their own — two racing CREATE TYPE ...
// IF NOT EXISTS statements can both pass the "not exists" check before
// either commits, and the second one's CREATE then fails with a unique
// constraint violation.
const ensuringSchemas = globalForSchema.ensuringSchemas;

export async function queryUserSchema<T = Record<string, unknown>>(
  userId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  if (!initializedSchemas.has(userId)) {
    let ensuring = ensuringSchemas.get(userId);
    if (!ensuring) {
      ensuring = ensureUserSchema(userId).finally(() => ensuringSchemas.delete(userId));
      ensuringSchemas.set(userId, ensuring);
    }
    await ensuring;
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
