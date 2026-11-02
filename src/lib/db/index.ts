import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool } from 'pg';
import * as schema from './schema';

const globalForDb = globalThis as unknown as {
  pool: Pool | undefined;
};

const pool =
  globalForDb.pool ??
  new Pool({
    connectionString: process.env.DATABASE_URL!,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

if (process.env.NODE_ENV !== 'production') {
  globalForDb.pool = pool;
}

export const db = drizzle(pool, { schema });
export { pool };

/**
 * A standalone connection, outside `pool`'s 20-connection budget. For a
 * session-scoped Postgres advisory lock held across a long-running operation
 * (minutes, not the lifetime of one request) — using a pooled connection for
 * that would tie up one of `pool`'s slots for the whole operation and starve
 * ordinary request handling. The caller owns its lifecycle: `connect()`, then
 * `end()` once done (a `finally`, not a `release()` back to any pool).
 */
export function createDbClient(): Client {
  return new Client({ connectionString: process.env.DATABASE_URL! });
}
