// A scripted SyncEnv for unit tests of the Rollekatalog sync and catalogue refresh: `script` answers
// each statement (whitespace-collapsed) with rows, an Error to throw, or undefined for "no rows".
// Every statement is logged with its connection number; releases are recorded. Not a SQL engine: the
// real behaviour lives in the *.pg.test.ts lane.
import type { ClientLike, SqlResult } from '@/lib/authz/pg-runner';
import type { SyncEnv } from '@/lib/rollekatalog/sync-run';

export type FakeReply = SqlResult<Record<string, unknown>> | Error | undefined;

export function makeFakeSyncEnv(script: (sql: string, params: readonly unknown[] | undefined) => FakeReply) {
  const log: Array<{ conn: number; sql: string; params: readonly unknown[] | undefined }> = [];
  const released: Array<{ conn: number; destroy: boolean }> = [];
  let n = 0;
  const env: SyncEnv = {
    schema: 'public',
    connect: async (): Promise<ClientLike> => {
      const conn = ++n;
      return {
        query: async (sql, params) => {
          const flat = sql.replace(/\s+/g, ' ').trim();
          log.push({ conn, sql: flat, params });
          const reply = script(flat, params);
          if (reply instanceof Error) throw reply;
          return (reply ?? { rows: [], rowCount: 0 }) as unknown as SqlResult<never>;
        },
        release: (destroy) => void released.push({ conn, destroy: destroy === true }),
      };
    },
  };
  return { env, log, released, sqls: () => log.map((l) => l.sql) };
}
