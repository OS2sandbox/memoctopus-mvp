// The sync_runs table and the small SQL seam the sync uses. Kept apart from
// sync.ts so the routes can read the latest run without pulling in the engine.
// All SQL here is schema-qualified through SyncEnv.schema (a trusted constant),
// so the gated Postgres lane can run the very same code in a throwaway schema.
import type { ClientLike, SqlResult } from '@/lib/authz/pg-runner';
import { pool } from '@/lib/db';
import { SYNC_COUNT_KEYS, emptySyncCounts, type SyncCounts, type SyncRunSummary } from './types';

export interface SyncEnv {
  /** Postgres schema holding the central tables; 'public' in production. */
  schema: string;
  /** A dedicated connection. The caller releases it (`release(true)` destroys it). */
  connect(): Promise<ClientLike>;
}

const SCHEMA_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export function defaultSyncEnv(): SyncEnv {
  return {
    schema: 'public',
    connect: async () => {
      const client = await pool.connect();
      return {
        query: (text, params) =>
          client.query(text, params as unknown[] | undefined) as unknown as Promise<SqlResult<never>>,
        release: (destroy) => client.release(destroy),
      };
    },
  };
}

/** `"schema".table`, validated: the schema name comes from the environment seam, never from a request. */
export function tbl(env: SyncEnv, table: string): string {
  if (!SCHEMA_RE.test(env.schema)) throw new Error('invalid schema name');
  return `"${env.schema}".${table}`;
}

/** One statement on a short-lived connection. */
export async function queryOnce<R extends object = Record<string, unknown>>(
  env: SyncEnv,
  text: string,
  params?: readonly unknown[],
): Promise<SqlResult<R>> {
  const client = await env.connect();
  try {
    return await client.query<R>(text, params);
  } finally {
    client.release();
  }
}

/** Keeps only known numeric counters, so a hand-edited or old row cannot leak arbitrary JSON into the API. */
export function parseCounts(raw: unknown): SyncCounts | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = emptySyncCounts();
  for (const key of SYNC_COUNT_KEYS) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
  }
  return out;
}

export async function startRun(env: SyncEnv, now: Date): Promise<string> {
  const res = await queryOnce<{ id: string }>(
    env,
    `INSERT INTO ${tbl(env, 'sync_runs')} (started_at, status) VALUES ($1::timestamptz, 'running') RETURNING id::text AS id`,
    [now],
  );
  return res.rows[0].id;
}

export async function finishRun(
  env: SyncEnv,
  id: string,
  status: 'success' | 'failed',
  counts: SyncCounts,
  errorCode: string | null,
  now: Date,
): Promise<void> {
  await queryOnce(
    env,
    `UPDATE ${tbl(env, 'sync_runs')}
        SET status = $2, finished_at = $3::timestamptz, counts = $4::jsonb, error_code = $5
      WHERE id = $1::uuid`,
    [id, status, now, JSON.stringify(counts), errorCode],
  );
}

/** A run that never started (e.g. not configured) still leaves a row, so the admin sees why nothing synced. */
export async function recordFailedRun(env: SyncEnv, errorCode: string, now: Date): Promise<string> {
  const res = await queryOnce<{ id: string }>(
    env,
    `INSERT INTO ${tbl(env, 'sync_runs')} (started_at, finished_at, status, counts, error_code)
     VALUES ($1::timestamptz, $1::timestamptz, 'failed', $2::jsonb, $3) RETURNING id::text AS id`,
    [now, JSON.stringify(emptySyncCounts()), errorCode],
  );
  return res.rows[0].id;
}

/**
 * Only called while the sync advisory lock is held: a row that is still 'running'
 * then belongs to a run that died (crash, restart), never to a live one.
 */
export async function abandonStaleRuns(env: SyncEnv, now: Date): Promise<void> {
  await queryOnce(
    env,
    `UPDATE ${tbl(env, 'sync_runs')}
        SET status = 'failed', finished_at = $1::timestamptz, error_code = 'abandoned'
      WHERE status = 'running'`,
    [now],
  );
}

interface RunRow {
  id: string;
  started_at: Date;
  finished_at: Date | null;
  status: string;
  counts: unknown;
  error_code: string | null;
}

export async function getLatestSyncRun(env: SyncEnv = defaultSyncEnv()): Promise<SyncRunSummary | null> {
  const res = await queryOnce<RunRow>(
    env,
    `SELECT id::text AS id, started_at, finished_at, status, counts, error_code
       FROM ${tbl(env, 'sync_runs')} ORDER BY started_at DESC, id DESC LIMIT 1`,
  );
  const row = res.rows[0];
  if (!row) return null;
  const status = row.status === 'success' || row.status === 'failed' ? row.status : 'running';
  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status,
    counts: parseCounts(row.counts),
    errorCode: row.error_code,
  };
}
