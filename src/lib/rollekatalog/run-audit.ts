// The audit event for one Rollekatalog pull (user/organisation sync or role/group catalogue
// refresh): integration.sync_run. Called by the four routes that start a run (the two cron routes
// and the two admin buttons), so every run that actually ran leaves a trace, whether it applied,
// was stopped by a guard (empty response, removal threshold) or failed.
//
// Only what the run already reports as numbers and short codes goes in: never a name, a person,
// a role or group identifier, a key or a URL, and never who got or lost which role (rights changes
// are not audited). A run that found another run holding the lock changed nothing and is not recorded.
import { recordEvent, recordServerEvent } from '@/lib/audit/record';
import { INTEGRATION_COUNT_KEYS } from '@/lib/audit/events/integration';
import { CODE_RE } from '@/lib/audit/events/types';
import type { HeaderSource } from '@/lib/audit/request-context';

export interface IntegrationRunResult {
  status: 'success' | 'already_running' | 'aborted' | 'error';
  counts: unknown;
  errorCode: string | null;
}

export interface IntegrationRunAudit {
  kind: 'org_sync' | 'role_catalogue';
  trigger: 'cron' | 'manual';
  result: IntegrationRunResult;
  /** The administrator for a manual run; absent for cron. */
  actorUserId?: string | null;
  /** The request of a manual run (its ip and user agent are stored with the event). */
  req?: HeaderSource;
}

/** Only the known counters, only finite non-negative integers: a hand-edited or old row cannot widen the event. */
function countsOf(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const key of INTEGRATION_COUNT_KEYS) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) out[key] = v;
  }
  return out;
}

/** Best effort, never throws: a run's result is never lost to its audit row. */
export async function recordIntegrationRun(run: IntegrationRunAudit): Promise<void> {
  const { result } = run;
  if (result.status === 'already_running') return;
  try {
    const failed = result.status !== 'success';
    const event = {
      type: 'integration.sync_run' as const,
      source: run.trigger === 'manual' ? ('server' as const) : ('system' as const),
      ...(failed ? { outcome: 'error' as const } : {}),
      ...(run.trigger === 'manual' && run.actorUserId ? { actorUserId: run.actorUserId } : {}),
      details: {
        kind: run.kind,
        trigger: run.trigger,
        status: result.status,
        ...(failed ? { code: result.errorCode && CODE_RE.test(result.errorCode) ? result.errorCode : 'unknown' } : {}),
        // An aborted or failed run changed nothing, so it has no counts to report.
        ...(failed ? {} : countsOf(result.counts)),
      },
    };
    await (run.req ? recordServerEvent(run.req, event) : recordEvent(event));
  } catch {
    /* the audit layer already warns content-free; a run is never failed for its row */
  }
}
