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
        )
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
