// Retention pruner: the ONLY code allowed to delete audit rows. The immutability
// trigger refuses DELETE unless the transaction ran
// set_config('audit.allow_prune', 'on', true) (transaction-local, so it cannot
// leak to a pooled connection's next use). Batches keep each transaction short.
import { defaultRunner, type SqlRunner } from '@/lib/authz/pg-runner';
import { recordEvent } from './record';

export const DEFAULT_PRUNE_BATCH = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TABLE_RE = /^[A-Za-z0-9_."]{1,128}$/;

export interface PruneOptions {
  /** Rows strictly older than this many whole days are deleted. Must be >= 1 (0 would wipe the log). */
  olderThanDays: number;
  now?: Date;
  batchSize?: number;
  runner?: SqlRunner;
  /** Test lane only (throwaway schema), like RecordOptions.table. */
  table?: string;
  /** Record the audit.prune event (default true). Off only in the Postgres test lane, which has no app pool. */
  emitEvent?: boolean;
}

/**
 * Deletes audit rows older than the cutoff and returns how many. Records one
 * `audit.prune` system event when something was deleted, so callers (the cron
 * route) must not record it again.
 */
export async function pruneAuditEvents(opts: PruneOptions): Promise<number> {
  const { olderThanDays } = opts;
  if (!Number.isSafeInteger(olderThanDays) || olderThanDays < 1) {
    throw new RangeError('olderThanDays must be an integer >= 1');
  }
  const batchSize = opts.batchSize ?? DEFAULT_PRUNE_BATCH;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new RangeError('batchSize must be an integer >= 1');
  const table = opts.table ?? 'public.audit_events';
  if (!TABLE_RE.test(table)) throw new RangeError('invalid table');

  const runner = opts.runner ?? defaultRunner();
  const cutoff = new Date((opts.now ?? new Date()).getTime() - olderThanDays * DAY_MS);

  let total = 0;
  for (;;) {
    const deleted = await runner.transaction(async (tx) => {
      await tx.query(`SELECT set_config('audit.allow_prune', 'on', true)`);
      const res = await tx.query(
        `DELETE FROM ${table}
          WHERE id IN (SELECT id FROM ${table} WHERE occurred_at < $1 ORDER BY id LIMIT $2)`,
        [cutoff, batchSize],
      );
      return res.rowCount ?? 0;
    });
    total += deleted;
    if (deleted < batchSize) break;
  }

  if (total > 0 && opts.emitEvent !== false) {
    await recordEvent({
      type: 'audit.prune',
      source: 'system',
      details: { deletedCount: total, olderThanDays },
    });
  }
  return total;
}
