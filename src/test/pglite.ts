import { beforeAll, beforeEach } from 'vitest';
import { PGlite, types } from '@electric-sql/pglite';

/**
 * An in-process Postgres (PGlite, Postgres compiled to WASM) standing in for the
 * `pg` pool of `@/lib/db`, so the real SQL runs in Vitest: `ensureUserSchema`, the
 * per-user `queryUserSchema` helpers, and every store module built on them. A test
 * that asserts on SQL text proves the text, not that Postgres agrees with it.
 *
 * Usage, in a node-environment test file:
 *
 *   vi.mock('@/lib/db', async () => (await import('@/test/pglite')).pgliteDbModule());
 *   import { usePgliteDb, pgliteSql } from '@/test/pglite';
 *
 *   usePgliteDb();                               // start once; empty db per test
 *   await queryUserSchema('user-1', 'SELECT …'); // ensureUserSchema runs for real
 *   await pgliteSql('UPDATE u_user_1.x …');      // raw access, for fixtures
 *
 * One database per test file (Vitest gives each file its own module registry), so
 * files do not see each other's rows. Starting it costs about a second.
 *
 * What it is not:
 *  - One Postgres session, not a pool. Clients are simulated: each keeps its own
 *    `search_path`, and a client that opened a transaction (BEGIN) has the session
 *    to itself until COMMIT/ROLLBACK. Anything that needs two real sessions — an
 *    advisory lock contended by two connections, row locks, isolation levels —
 *    cannot be tested here; keep those mocked. (`pg_try_advisory_lock` succeeds,
 *    always: it is re-entrant within the one session.)
 *  - The drizzle `db` export is an empty stub. Only the raw-SQL `pool` is real.
 *
 * Values come back the way node-postgres returns them, so mapping code is tested
 * as it runs: BIGINT and NUMERIC as strings, timestamps as Dates, JSON parsed.
 */

let instance: Promise<PGlite> | null = null;

function database(): Promise<PGlite> {
  instance ??= PGlite.create();
  return instance;
}

/** node-postgres leaves these as strings; PGlite would turn them into numbers. */
const PARSERS = {
  [types.INT8]: (value: string) => value,
  [types.NUMERIC]: (value: string) => value,
};

const DEFAULT_SEARCH_PATH = '"$user", public';
const SET_SEARCH_PATH = /^\s*SET\s+search_path\s+TO\s+([\s\S]+?)\s*;?\s*$/i;

// ─── The one session, shared fairly between simulated clients ─────────────────

let holder: object | null = null;
const waiting: Array<() => void> = [];
let sessionSearchPath = DEFAULT_SEARCH_PATH;

async function acquire(owner: object): Promise<void> {
  while (holder !== null && holder !== owner) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  holder = owner;
}

function release(owner: object): void {
  if (holder !== owner) return;
  holder = null;
  waiting.shift()?.();
}

interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

class SimulatedClient {
  private searchPath = DEFAULT_SEARCH_PATH;
  private inTransaction = false;

  async query(sql: string | { text: string; values?: unknown[] }, params: unknown[] = []): Promise<QueryResult> {
    const text = typeof sql === 'string' ? sql : sql.text;
    const values = typeof sql === 'string' ? params : (sql.values ?? []);

    const setPath = SET_SEARCH_PATH.exec(text);
    if (setPath) {
      this.searchPath = setPath[1];
      return { rows: [], rowCount: 0 };
    }

    await acquire(this);
    try {
      const pg = await database();
      if (sessionSearchPath !== this.searchPath) {
        await pg.exec(`SET search_path TO ${this.searchPath}`);
        sessionSearchPath = this.searchPath;
      }
      const result =
        values.length === 0
          ? // Like node-postgres' simple protocol: no parameters, any statement
            // (DO blocks, ALTER TYPE …) and possibly several of them.
            (await pg.exec(text, { parsers: PARSERS })).at(-1)
          : await pg.query(text, values, { parsers: PARSERS });

      if (/^\s*(BEGIN|START\s+TRANSACTION)\b/i.test(text)) this.inTransaction = true;
      if (/^\s*(COMMIT|ROLLBACK|END)\b/i.test(text)) this.inTransaction = false;

      const rows = (result?.rows ?? []) as Record<string, unknown>[];
      return { rows, rowCount: result?.affectedRows ?? rows.length };
    } finally {
      // A statement that failed inside a transaction keeps the session: the
      // caller's ROLLBACK is what ends it.
      if (!this.inTransaction) release(this);
    }
  }

  release(): void {
    this.inTransaction = false;
    release(this);
  }

  // pg.Client surface, for createDbClient() callers.
  async connect(): Promise<void> {}
  async end(): Promise<void> {
    this.release();
  }
}

/** Stands in for `pg.Pool`: `connect()` hands out a simulated client. */
export const pglitePool = {
  async connect(): Promise<SimulatedClient> {
    return new SimulatedClient();
  },
  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const client = new SimulatedClient();
    try {
      return await client.query(sql, params);
    } finally {
      client.release();
    }
  },
  async end(): Promise<void> {},
  on(): void {},
};

/** The replacement for `@/lib/db`, for `vi.mock('@/lib/db', …)`. */
export function pgliteDbModule() {
  return {
    pool: pglitePool,
    db: {},
    createDbClient: () => new SimulatedClient(),
  };
}

/** Raw SQL against the test database, outside any user's search_path — for fixtures and assertions. */
export async function pgliteSql<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pglitePool.query(sql, params)).rows as T[];
}

/**
 * Registers the hooks a test file needs: start the database once (generously
 * bounded, since compiling the WASM is slow on a busy machine) and give every test
 * an empty database. Call at the top level of the file, after the vi.mock.
 */
export function usePgliteDb(): void {
  beforeAll(async () => {
    await database();
  }, 120_000);
  beforeEach(() => resetPgliteDb(), 30_000);
}

/**
 * Drops every per-user schema and forgets that any was initialised, so the next
 * `queryUserSchema` call runs `ensureUserSchema` from scratch.
 */
export async function resetPgliteDb(): Promise<void> {
  const schemas = await pgliteSql<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'u\\_%'`,
  );
  for (const { nspname } of schemas) {
    await pgliteSql(`DROP SCHEMA "${nspname}" CASCADE`);
  }
  // user-schema.ts caches which schemas it has ensured on globalThis.
  (globalThis as { initializedSchemas?: Set<string> }).initializedSchemas?.clear();
}
