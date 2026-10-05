// In-memory SqlRunner for unit tests of code that talks to the central tables.
// `respond` decides the rows per statement; every statement is recorded in order,
// transactional ones with `tx: true`. Not a SQL engine: tests assert on the SQL
// text they care about, and the real behaviour lives in the *.pg.test.ts lane.
import type { SqlQueryable, SqlResult, SqlRunner } from '@/lib/authz/pg-runner';

export interface RecordedQuery {
  sql: string;
  params: readonly unknown[];
  tx: boolean;
}

export type Responder = (
  sql: string,
  params: readonly unknown[],
  tx: boolean,
) => Array<Record<string, unknown>> | Promise<Array<Record<string, unknown>>> | undefined;

export function makeFakeRunner(respond: Responder = () => []) {
  const calls: RecordedQuery[] = [];

  const run = async (sql: string, params: readonly unknown[], tx: boolean): Promise<SqlResult<never>> => {
    calls.push({ sql, params, tx });
    const rows = ((await respond(sql, params, tx)) ?? []) as never[];
    return { rows, rowCount: rows.length };
  };

  const runner: SqlRunner = {
    query: (sql, params = []) => run(sql, params, false) as never,
    async transaction(fn) {
      const tx: SqlQueryable = { query: (sql, params = []) => run(sql, params, true) as never };
      calls.push({ sql: 'BEGIN', params: [], tx: true });
      try {
        const out = await fn(tx);
        calls.push({ sql: 'COMMIT', params: [], tx: true });
        return out;
      } catch (e) {
        calls.push({ sql: 'ROLLBACK', params: [], tx: true });
        throw e;
      }
    },
  };

  return { runner, calls, sqls: () => calls.map((c) => c.sql) };
}
