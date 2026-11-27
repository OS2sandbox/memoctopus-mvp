// Minimal SQL seam for the login-time identity code (identity / directory-match /
// bootstrap). It exists so that (a) unit tests can fake the database with a
// plain object and (b) the gated Postgres lane can point the very same code at a
// throwaway schema. All SQL passed through here is schema-qualified (public.*).
import type { PoolClient } from 'pg';
import { pool } from '@/lib/db';

export interface SqlResult<R> {
  rows: R[];
  rowCount: number | null;
}

export interface SqlQueryable {
  query<R extends object = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<SqlResult<R>>;
}

export interface SqlRunner extends SqlQueryable {
  /** Runs `fn` on one dedicated connection inside BEGIN/COMMIT; rolls back on throw. */
  transaction<T>(fn: (tx: SqlQueryable) => Promise<T>): Promise<T>;
}

export interface ClientLike extends SqlQueryable {
  release(destroy?: boolean): void;
}

export function createRunner(
  base: SqlQueryable,
  connect: () => Promise<ClientLike>,
): SqlRunner {
  return {
    query: (text, params) => base.query(text, params),
    async transaction(fn) {
      const client = await connect();
      let destroy = false;
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // A connection that cannot even roll back must not return to the pool.
          destroy = true;
        }
        throw err;
      } finally {
        client.release(destroy || undefined);
      }
    },
  };
}

export function defaultRunner(): SqlRunner {
  return createRunner(
    {
      query: (text, params) =>
        pool.query(text, params as unknown[] | undefined) as Promise<SqlResult<never>>,
    },
    async () => {
      const client: PoolClient = await pool.connect();
      return {
        query: (text, params) =>
          client.query(text, params as unknown[] | undefined) as Promise<SqlResult<never>>,
        release: (destroy) => client.release(destroy),
      };
    },
  );
}

/** Safe-to-log description of an error: class name and SQLSTATE only, never the message (may echo values). */
export function errorLabel(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? `${name}/${code}` : name;
}
