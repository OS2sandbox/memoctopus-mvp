import { pool } from './index';

function schemaName(userId: string): string {
  return `u_${userId.replace(/-/g, '_')}`;
}

export async function ensureUserSchema(userId: string): Promise<void> {
  const schema = schemaName(userId);
  const client = await pool.connect();

  try {
    // A person's schema holds skabeloner, skabelon_versions, the Microsoft Teams tables
    // (teams_meetings, teams_meeting_snapshots) and the onboarding tables. Schemas created by older versions
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
        ADD COLUMN IF NOT EXISTS recording_cleanup TEXT,
        ADD COLUMN IF NOT EXISTS recording_bytes   BIGINT,
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

    // teams_meeting_snapshots — the organizer's meeting options as they were
    // before we ever armed the meeting, one row per Graph meeting (not per local
    // id). A recurring series shares ONE onlineMeeting but mints a new local id
    // per pasted link, so the snapshot cannot live on teams_meetings without a
    // multi-row "which sibling holds the real one?" lookup; keying it on
    // graph_meeting_id directly makes there only ever be one to find.
    await client.query(`
      CREATE TABLE IF NOT EXISTS "${schema}".teams_meeting_snapshots (
        graph_meeting_id TEXT PRIMARY KEY,
        original_options JSONB,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

    // onboarding_progress — which onboarding hints this user has seen/dismissed.
    // meeting_id is NOT NULL with '' standing in for "global, not tied to a
    // meeting" (store.ts converts null <-> '' at the boundary): Postgres treats
    // every NULL as distinct under a UNIQUE constraint, which would otherwise
    // need a second partial index just to dedupe the global steps.
    await client.query(`
      CREATE TABLE IF NOT EXISTS "${schema}".onboarding_progress (
        id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        step_id     TEXT NOT NULL,
        meeting_id  TEXT NOT NULL DEFAULT '',
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

    // Legacy rows may carry duplicate (step_id, COALESCE(meeting_id, '')) pairs
    // (real NULLs alongside an existing '' row, or duplicate NULLs themselves).
    // Collapse each group to its most recently seen row before folding NULLs
    // into the sentinel, or the UPDATE/constraint below fails on the dupes.
    await client.query(`
      DELETE FROM "${schema}".onboarding_progress a
      USING "${schema}".onboarding_progress b
      WHERE a.step_id = b.step_id
        AND COALESCE(a.meeting_id, '') = COALESCE(b.meeting_id, '')
        AND (a.seen_at, a.id) < (b.seen_at, b.id)
    `);

    // A database created before meeting_id became NOT NULL still has real NULLs;
    // fold them into the sentinel so the unique constraint below covers every row.
    await client.query(`
      UPDATE "${schema}".onboarding_progress SET meeting_id = '' WHERE meeting_id IS NULL
    `);
    await client.query(`
      ALTER TABLE "${schema}".onboarding_progress
        ALTER COLUMN meeting_id SET DEFAULT '',
        ALTER COLUMN meeting_id SET NOT NULL
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

    // Databases from before the sentinel change may still carry the old partial
    // index; it is redundant now that the constraint above covers every row.
    await client.query(`
      DROP INDEX IF EXISTS "${schema}".onboarding_progress_global_step_unique
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
