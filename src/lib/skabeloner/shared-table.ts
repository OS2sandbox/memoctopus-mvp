import { pool } from '@/lib/db';

// The shared_skabeloner table lives in the public schema and backs link-based
// sharing. It is created idempotently on first use — mirroring the
// CREATE TABLE IF NOT EXISTS approach in ensureUserSchema — so link sharing works
// without a separate migration step. The FK to users is intentionally omitted
// here to avoid coupling table creation to better-auth's table being present;
// the canonical Drizzle definition (db/schema.ts) still declares it for db:push.
// Memoised so it runs at most once per process.
let ensured: Promise<void> | null = null;

export function ensureSharedSkabelonerTable(): Promise<void> {
  if (!ensured) {
    ensured = pool
      .query(`
        CREATE TABLE IF NOT EXISTS public.shared_skabeloner (
          token                      TEXT PRIMARY KEY,
          owner_user_id              TEXT NOT NULL,
          name                       TEXT NOT NULL,
          description                TEXT NOT NULL DEFAULT '',
          prompt                     TEXT NOT NULL DEFAULT '',
          include_deltagere          BOOLEAN NOT NULL DEFAULT FALSE,
          include_beslutningspunkter BOOLEAN NOT NULL DEFAULT FALSE,
          include_dagsorden          BOOLEAN NOT NULL DEFAULT FALSE,
          include_dato               BOOLEAN NOT NULL DEFAULT FALSE,
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        -- Self-heal tables created before later columns were added (mirrors the
        -- ADD COLUMN IF NOT EXISTS approach in ensureUserSchema). Without this, a
        -- table created before the 'Dato' category breaks link sharing with a
        -- missing-column error on insert.
        ALTER TABLE public.shared_skabeloner
          ADD COLUMN IF NOT EXISTS description                TEXT        NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS prompt                     TEXT        NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS include_deltagere          BOOLEAN     NOT NULL DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS include_beslutningspunkter BOOLEAN     NOT NULL DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS include_dagsorden          BOOLEAN     NOT NULL DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS include_dato               BOOLEAN     NOT NULL DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW();
      `)
      .then(() => undefined)
      .catch((err) => {
        // Reset so a transient failure can be retried on the next call.
        ensured = null;
        throw err;
      });
  }
  return ensured;
}
