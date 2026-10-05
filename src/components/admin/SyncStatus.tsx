'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ErrorBanner } from '@/components/ui/error-banner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { MeResponse } from '@/lib/authz/me';
import {
  checkCountLabels,
  checkEndpointLabels,
  syncCountLabels,
  syncErrorMessage,
  syncStatusLabels,
} from '@/lib/rollekatalog/labels.da';
import { SYNC_COUNT_KEYS, type SyncCounts } from '@/lib/rollekatalog/types';
import { apiRequest } from './api';

// Mirrors SyncRunSummary / CheckReport (JSON, so dates are strings).
export interface SyncRunView {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'success' | 'failed';
  counts: Partial<SyncCounts> | null;
  errorCode: string | null;
}

interface SyncResponse {
  run: SyncRunView | null;
  configIssue: string | null;
}

interface EndpointCheckView {
  endpoint: string;
  ok: boolean;
  httpStatusCode: number | null;
  schemaValid: boolean;
  counts?: Record<string, number>;
  cprFieldPresentInResponse?: boolean;
  errorCode?: string;
  skipped?: boolean;
}

interface CheckReportView {
  configured: boolean;
  configIssue: string | null;
  endpoints: EndpointCheckView[];
}

export function formatSyncTime(iso: string | null): string {
  if (!iso) return '–';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '–' : d.toLocaleString('da-DK', { dateStyle: 'medium', timeStyle: 'short' });
}

// Advisory: the routes re-check sync.run / access.manage on every request.
const canSeeSyncRun = (me: MeResponse) =>
  me.readOnly && (me.capabilities.includes('sync.run') || me.capabilities.includes('access.manage'));

/** The latest sync run, only fetched when the viewer may read it (a denied read would be audited). */
function useSyncRun(enabled: boolean) {
  const [state, setState] = useState<{ data: SyncResponse | null; loading: boolean; error: string | null }>({
    data: null,
    loading: enabled,
    error: null,
  });
  const reload = useCallback(async () => {
    const res = await apiRequest<SyncResponse>('/api/admin/access/sync');
    setState(res.ok ? { data: res.data, loading: false, error: null } : { data: null, loading: false, error: res.message });
  }, []);
  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);
  return { ...state, reload };
}

/** One line for the read-only user and organisation pages: where the data comes from and how fresh it is. */
export function LastSyncLine({ me }: { me: MeResponse | null }) {
  const showTime = !!me && canSeeSyncRun(me);
  const { data, loading } = useSyncRun(showTime);
  if (!me || !me.readOnly) return null;

  let freshness: string | null = null;
  if (showTime && !loading && data) {
    const run = data.run;
    if (!run) freshness = 'Ikke synkroniseret endnu.';
    else if (run.status === 'success') freshness = `Sidst synkroniseret ${formatSyncTime(run.finishedAt ?? run.startedAt)}.`;
    else if (run.status === 'running') freshness = 'En synkronisering er i gang.';
    else freshness = `Seneste synkronisering mislykkedes ${formatSyncTime(run.finishedAt ?? run.startedAt)}. Data kan være forældede.`;
  }

  return (
    <p className="flex flex-wrap items-center gap-2 text-[13px] text-[var(--muted)]">
      <Badge variant="outline">Rollekatalog</Badge>
      <span>Data hentes fra Rollekatalog.{freshness ? ` ${freshness}` : ''}</span>
    </p>
  );
}

function CheckTable({ report }: { report: CheckReportView }) {
  const strips = report.endpoints.some((e) => e.cprFieldPresentInResponse);
  return (
    <div className="flex flex-col gap-2">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Opslag</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Svar</TableHead>
            <TableHead>Format</TableHead>
            <TableHead>Resultat</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {report.endpoints.map((e) => (
            <TableRow key={e.endpoint}>
              <TableCell>{checkEndpointLabels[e.endpoint] ?? e.endpoint}</TableCell>
              <TableCell>
                {e.skipped ? (
                  <Badge variant="secondary">Sprunget over</Badge>
                ) : e.ok ? (
                  <Badge variant="success">OK</Badge>
                ) : (
                  <Badge variant="destructive">Fejl</Badge>
                )}
              </TableCell>
              <TableCell className="font-mono text-[12px]">{e.httpStatusCode ?? '–'}</TableCell>
              <TableCell>{e.skipped ? '–' : e.schemaValid ? 'Genkendt' : 'Ikke genkendt'}</TableCell>
              <TableCell className="text-[13px]">
                {e.skipped
                  ? 'Din bruger er ikke koblet til Rollekatalog.'
                  : e.ok
                    ? Object.entries(e.counts ?? {})
                        .map(([k, v]) => `${v} ${checkCountLabels[k] ?? k}`)
                        .join(', ')
                    : syncErrorMessage(e.errorCode)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {strips && (
        <p role="note" className="text-[13px] text-[var(--muted)]">
          Rollekatalog sender CPR- eller NemLog-in-felter i svaret. Løsningen kasserer dem ved indlæsning og gemmer dem aldrig.
        </p>
      )}
    </div>
  );
}

/**
 * `syncEnabled` is false in local mode: only "Test forbindelse" is offered then, so an
 * operator can verify the configuration BEFORE switching (the sync route answers 409 in
 * local mode and its run history is empty).
 */
function SyncPanel({ syncEnabled }: { syncEnabled: boolean }) {
  const { data, loading, error, reload } = useSyncRun(syncEnabled);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [force, setForce] = useState(false);
  const [sawThreshold, setSawThreshold] = useState(false);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [report, setReport] = useState<CheckReportView | null>(null);

  const run = data?.run ?? null;
  const configIssue = data?.configIssue ?? null;
  // The override is only offered after the removal threshold stopped a run; it is not a standing option.
  const needsForce = sawThreshold || (run?.status === 'failed' && run.errorCode === 'removal_threshold');

  async function startSync() {
    setRunning(true);
    setRunError(null);
    const res = await apiRequest('/api/admin/access/sync', { method: 'POST', json: force ? { force: true } : {} });
    setRunning(false);
    if (res.ok) {
      setConfirmOpen(false);
      setForce(false);
      setSawThreshold(false);
      setNotice('Synkroniseringen er gennemført.');
      void reload();
      return;
    }
    setNotice(null);
    setRunError(res.message);
    setSawThreshold(res.message === syncErrorMessage('removal_threshold'));
    void reload();
  }

  async function runCheck() {
    setChecking(true);
    setCheckError(null);
    const res = await apiRequest<CheckReportView>('/api/admin/access/rollekatalog/check', { method: 'POST' });
    setChecking(false);
    if (res.ok) setReport(res.data);
    else {
      setReport(null);
      setCheckError(res.message);
    }
  }

  function openConfirm() {
    setRunError(null);
    setForce(false);
    setConfirmOpen(true);
  }

  const counts = run?.counts ?? null;

  return (
    <section aria-labelledby="sync-heading" className="flex flex-col gap-3">
      <h2 id="sync-heading" className="text-[var(--t-h2)] font-light text-[var(--ink)]">
        {syncEnabled ? 'Synkronisering med Rollekatalog' : 'Forbindelse til Rollekatalog'}
      </h2>

      {!syncEnabled && (
        <p className="text-[13px] text-[var(--muted)]">
          Rettigheder styres lokalt. Du kan teste forbindelsen til Rollekatalog, før du skifter til Rollekatalog som kilde.
        </p>
      )}
      {syncEnabled && <ErrorBanner message={error} onRetry={() => void reload()} />}
      {syncEnabled && configIssue && <p className="text-[13px] text-[var(--muted)]">{syncErrorMessage(configIssue)}</p>}

      {!syncEnabled ? null : loading ? (
        <p className="text-sm text-[var(--muted)]">Indlæser …</p>
      ) : run ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant={run.status === 'success' ? 'success' : run.status === 'running' ? 'secondary' : 'destructive'}>
              {syncStatusLabels[run.status]}
            </Badge>
            <span className="text-[var(--ink-2)]">Seneste synkronisering {formatSyncTime(run.finishedAt ?? run.startedAt)}</span>
          </div>
          {run.status === 'failed' && <ErrorBanner message={syncErrorMessage(run.errorCode)} />}
          {counts && (
            <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-[13px] sm:grid-cols-2">
              {SYNC_COUNT_KEYS.map((key) => (
                <div key={key} className="flex justify-between gap-3 border-b border-[var(--line)] py-0.5">
                  <dt className="text-[var(--muted)]">{syncCountLabels[key]}</dt>
                  <dd className="font-mono text-[var(--ink)]">{counts[key] ?? 0}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      ) : (
        !error && <p className="text-sm text-[var(--muted)]">Der er ikke kørt nogen synkronisering endnu.</p>
      )}

      {notice && (
        <p role="status" className="text-[13px] text-[var(--ok)]">
          {notice}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {syncEnabled && (
          <Button
            type="button"
            onClick={openConfirm}
            disabled={running || !!configIssue}
            title={configIssue ? syncErrorMessage(configIssue) : undefined}
          >
            Synkroniser nu
          </Button>
        )}
        <Button type="button" variant="outline" onClick={runCheck} disabled={checking}>
          {checking ? 'Tester …' : 'Test forbindelse'}
        </Button>
      </div>

      <ErrorBanner message={checkError} />
      {report && <CheckTable report={report} />}

      <Dialog open={confirmOpen} onOpenChange={(o) => !o && !running && setConfirmOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Synkroniser nu</DialogTitle>
            <DialogDescription>
              Henter organisation, brugere og roller fra Rollekatalog og opdaterer løsningen. Roller, der ikke længere findes i
              Rollekatalog, fjernes.
            </DialogDescription>
          </DialogHeader>
          {needsForce && (
            <label className="mt-3 flex items-start gap-2 text-sm text-[var(--ink)]">
              <input
                type="checkbox"
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
                disabled={running}
                className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
              />
              <span>
                <span className="font-medium">Gennemtving</span>
                <span className="block text-[13px] text-[var(--muted)]">
                  Den forrige synkronisering blev stoppet, fordi usædvanligt mange brugere eller roller ville blive fjernet.
                  Sæt kun kryds, hvis du ved, at det er rigtigt.
                </span>
              </span>
            </label>
          )}
          <ErrorBanner message={runError} className="mt-3" />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmOpen(false)} disabled={running}>
              Annuller
            </Button>
            <Button type="button" onClick={startSync} disabled={running}>
              {running ? 'Synkroniserer …' : force ? 'Gennemtving synkronisering' : 'Start synkronisering'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

/**
 * Sync status, "Synkroniser nu" and "Test forbindelse" for a viewer with sync.run. The sync
 * parts only while Rollekatalog owns the data; in local mode just "Test forbindelse".
 * The server enforces both on every call.
 */
export function SyncStatus({ me }: { me: MeResponse }) {
  if (!me.capabilities.includes('sync.run')) return null;
  return <SyncPanel syncEnabled={me.readOnly} />;
}
