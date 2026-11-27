import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool } from 'pg';
import * as schema from './schema';
import { safeLogError } from '@/lib/audit/safe-log';

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

// Idle pooled clients emit 'error' on the pool; unhandled it would crash the process.
pool.on('error', (err) => safeLogError('db/pool: idle client error', err));

export const db = drizzle(pool, { schema });
export { pool };

/**
 * A standalone connection, outside `pool`'s 20-connection budget. For a
 * session-scoped Postgres advisory lock held across a long-running operation
 * (minutes, not the lifetime of one request) — using a pooled connection for
 * that would tie up one of `pool`'s slots for the whole operation and starve
 * ordinary request handling. The caller owns its lifecycle: `connect()`, then
 * `end()` once done (a `finally`, not a `release()` back to any pool).
 *
 * The connection sits idle for minutes, so a database restart or a proxy
 * dropping it emits `'error'` on the client; with no listener Node rethrows it
 * as an uncaught exception and the whole server dies. The listener only logs:
 * Postgres releases a session advisory lock when its connection goes, and the
 * caller's own unlock/`end()` already tolerate a dead client.
 */
export function createDbClient(): Client {
  const client = new Client({ connectionString: process.env.DATABASE_URL! });
  client.on('error', (err) => safeLogError('db/standalone-client: connection error', err));
  return client;
}
