'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ErrorBanner } from '@/components/ui/error-banner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { CATEGORIES, eventTypesOfCategory, isCategoryKey, type CategoryKey } from '@/lib/audit/categories';
import { AUDIT_EXPORT_MAX_ROWS, AUDIT_TRUNCATED_HEADER, auditExportFilename } from '@/lib/audit/csv';
import { eventTypeLabel, outcomeLabels, sourceBadgeLabels, sourceLabels } from '@/lib/audit/labels.da';
import { summariseEvent } from '@/lib/audit/summary.da';
import { useMe } from '@/lib/hooks/use-me';
import { apiRequest } from './api';
import { AdminPage } from './AdminPage';
import { formatDateTime } from './format';

// Mirrors the JSON of GET /api/admin/audit.
interface AuditEventView {
  id: string;
  occurredAt: string;
  source: 'server' | 'client' | 'system';
  eventType: string;
  outcome: 'success' | 'denied' | 'error';
  actorUserId: string | null;
  actorName: string | null;
  entityType: string | null;
  entityId: string | null;
  secondaryEntityType: string | null;
  secondaryEntityId: string | null;
  requestId: string | null;
  details: Record<string, unknown>;
  ipAddress?: string | null;
  /** Central template events only: the documented reason for the change, from the template changelog. */
  changeNote?: string;
  templateName?: string | null;
}

type Period = 'today' | '7d' | '30d' | 'all';

const PERIOD_OPTIONS: ReadonlyArray<{ value: Period; label: string }> = [
  { value: 'today', label: 'I dag' },
  { value: '7d', label: 'Seneste 7 dage' },
  { value: '30d', label: 'Seneste 30 dage' },
  { value: 'all', label: 'Alle' },
];

/** What is applied to the list: every change here refetches, so nothing is filtered "in hiding". */
interface Filters {
  q: string;
  category: CategoryKey | '';
  period: Period;
  outcome: string;
  source: string;
  entityId: string;
  /** Local days (yyyy-mm-dd). Either one set replaces the period. */
  from: string;
  to: string;
}

const DEFAULT_FILTERS: Filters = { q: '', category: '', period: '7d', outcome: '', source: '', entityId: '', from: '', to: '' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Start of the period as an instant, or undefined for "all". */
function periodStart(period: Period, now: Date): Date | undefined {
  switch (period) {
    case 'today':
      return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    case '7d':
      return new Date(now.getTime() - 7 * DAY_MS);
    case '30d':
      return new Date(now.getTime() - 30 * DAY_MS);
    default:
      return undefined;
  }
}

/** Filters as a query string; dates are the user's local days, sent as instants. Custom dates override the period. */
function filterQuery(f: Filters, now: Date = new Date()): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.category) for (const t of eventTypesOfCategory(f.category)) p.append('eventType', t);
  if (f.outcome) p.set('outcome', f.outcome);
  if (f.source) p.set('source', f.source);
  if (f.entityId) p.set('entityId', f.entityId.toLowerCase());
  if (f.from || f.to) {
    if (f.from) p.set('from', new Date(`${f.from}T00:00:00`).toISOString());
    if (f.to) p.set('to', new Date(`${f.to}T23:59:59.999`).toISOString());
  } else {
    const start = periodStart(f.period, now);
    if (start) p.set('from', start.toISOString());
  }
  return p;
}

const isDefault = (f: Filters) => JSON.stringify(f) === JSON.stringify(DEFAULT_FILTERS);

const formatTime = (iso: string) => formatDateTime(iso, { dateStyle: 'medium', timeStyle: 'short' });

/** One "key: value" line per detail, so long keys wrap instead of widening the page. */
function detailLines(details: Record<string, unknown>): string[] {
  return Object.entries(details).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`);
}

const EXPORT_FAILED = 'Eksport mislykkedes';
// The guard's 401/403 bodies are English; show a fixed Danish text for those (same wording as api.ts).
const EXPORT_STATUS_MESSAGE: Record<number, string> = {
  401: 'Din session er udløbet. Log ind igen.',
  403: 'Du har ikke adgang til denne handling.',
};
const EXPORT_TRUNCATED_WARNING = `Eksporten er afkortet til de første ${String(AUDIT_EXPORT_MAX_ROWS).replace(/\B(?=(\d{3})+(?!\d))/g, '.')} rækker. Indsnævr filteret (fx datointerval) og eksportér igen.`;

/** Danish text for a failed export: fixed for 401/403, else the server's `{error}`, else a generic one. */
async function exportErrorMessage(res: Response): Promise<string> {
  const fixed = EXPORT_STATUS_MESSAGE[res.status];
  if (fixed) return fixed;
  try {
    const body: unknown = await res.json();
    const error = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
    if (typeof error === 'string' && error.trim()) return error;
  } catch {
    // Not JSON: fall through to the generic text.
  }
  return EXPORT_FAILED;
}

/** File name from Content-Disposition; falls back to the pre-header name for today. */
function exportFilename(res: Response, truncated: boolean): string {
  const match = /filename="?([^";]+)"?/i.exec(res.headers.get('Content-Disposition') ?? '');
  const name = match?.[1]?.trim().replace(/[\\/]/g, '_');
  return name || auditExportFilename(new Date().toISOString().slice(0, 10), truncated);
}

const outcomeVariant = { success: 'success', denied: 'warning', error: 'destructive' } as const;

function TechnicalDetails({ e }: { e: AuditEventView }) {
  const lines = detailLines(e.details);
  const rows: Array<[string, string | null | undefined]> = [
    ['Hændelse', `${eventTypeLabel(e.eventType)} (${e.eventType})`],
    ['Resultat', outcomeLabels[e.outcome] ?? e.outcome],
    ['Kilde', sourceLabels[e.source] ?? e.source],
    ['Bruger-id', e.actorUserId],
    ['Objekt', e.entityId ? `${e.entityType ?? ''} ${e.entityId}`.trim() : null],
    ['Andet objekt', e.secondaryEntityId ? `${e.secondaryEntityType ?? ''} ${e.secondaryEntityId}`.trim() : null],
    ['Anmodnings-id', e.requestId],
    ['IP-adresse', e.ipAddress],
  ];
  return (
    <details className="mt-2 text-[13px]">
      <summary className="cursor-pointer select-none text-[var(--muted)] hover:text-[var(--ink-2)]">Tekniske detaljer</summary>
      <dl className="mt-2 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-sm bg-[var(--surface-2)] px-3 py-2">
        {rows.map(([label, value]) =>
          value ? (
            <div key={label} className="contents">
              <dt className="text-[var(--muted)]">{label}</dt>
              <dd className="m-0 font-mono text-[12px] text-[var(--ink-2)] [overflow-wrap:anywhere]">{value}</dd>
            </div>
          ) : null,
        )}
        {lines.length > 0 && (
          <div className="contents">
            <dt className="text-[var(--muted)]">Detaljer</dt>
            <dd className="m-0 font-mono text-[12px] text-[var(--ink-2)] [overflow-wrap:anywhere]">
              {lines.map((line) => (
                <div key={line}>{line}</div>
              ))}
            </dd>
          </div>
        )}
      </dl>
    </details>
  );
}

function EventRow({ e }: { e: AuditEventView }) {
  const version = typeof e.details.version === 'number' ? e.details.version : null;
  return (
    <li className="flex flex-col gap-1 border-b border-[var(--line)] px-1 py-3.5 last:border-b-0 sm:flex-row sm:gap-4">
      <time dateTime={e.occurredAt} className="shrink-0 text-[13px] text-[var(--muted)] sm:w-40 sm:pt-0.5">
        {formatTime(e.occurredAt)}
      </time>
      <div className="min-w-0 flex-1">
        <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px] font-medium leading-snug text-[var(--ink)]">
          <span className="[overflow-wrap:anywhere]">{summariseEvent(e)}</span>
          {e.outcome !== 'success' && <Badge variant={outcomeVariant[e.outcome] ?? 'outline'}>{outcomeLabels[e.outcome] ?? e.outcome}</Badge>}
          {e.source === 'client' && <Badge variant="secondary">{sourceBadgeLabels.client}</Badge>}
        </p>
        {e.changeNote && (
          <div className="mt-2.5 rounded-sm border-l-4 border-[var(--accent)] bg-[var(--accent-wash)] px-4 py-3.5">
            <div className="text-[12px] font-semibold uppercase tracking-wide text-[var(--ink-2)]">
              Ændringsbeskrivelse
              {version !== null && <span className="font-normal normal-case"> · version {version}</span>}
            </div>
            <p className="m-0 mt-1.5 whitespace-pre-wrap break-words text-[16px] leading-relaxed text-[var(--ink)]">{e.changeNote}</p>
          </div>
        )}
        <TechnicalDetails e={e} />
      </div>
    </li>
  );
}

export function AuditLog() {
  const { data: me, loading: meLoading, error: meError } = useMe();
  // Text the user is typing; committed together with the next filter change or on Enter.
  const [draft, setDraft] = useState({ q: '', entityId: '', from: '', to: '' });
  const [applied, setApplied] = useState<Filters>(DEFAULT_FILTERS);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [events, setEvents] = useState<AuditEventView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Only the newest request may write state, so a slow old response cannot overwrite a newer filter.
  const requestSeq = useRef(0);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportTruncated, setExportTruncated] = useState(false);
  // A ref, not the state: two clicks in the same tick must still send one request.
  const exportInFlight = useRef(false);

  const fetchPage = useCallback(async (filters: Filters, cursor: string | null) => {
    const seq = ++requestSeq.current;
    const p = filterQuery(filters);
    p.set('limit', String(PAGE_SIZE));
    if (cursor) p.set('cursor', cursor);
    const res = await apiRequest<{ events: AuditEventView[]; nextCursor: string | null }>(`/api/admin/audit?${p.toString()}`);
    if (seq !== requestSeq.current) return;
    if (res.ok) {
      setEvents((prev) => (cursor ? [...prev, ...res.data.events] : res.data.events));
      setNextCursor(res.data.nextCursor);
      setLoadError(null);
    } else {
      setLoadError(res.message);
    }
    setLoading(false);
    setLoadingMore(false);
  }, []);

  useEffect(() => {
    setLoading(true);
    setEvents([]);
    setNextCursor(null);
    fetchPage(applied, null);
  }, [applied, fetchPage]);

  const canExport = !!me && me.capabilities.includes('audit.export');
  const isGlobalReader = !!me && me.scopes['audit.read']?.global === true;

  async function runExport() {
    if (exportInFlight.current) return;
    exportInFlight.current = true;
    setExporting(true);
    setExportError(null);
    setExportTruncated(false);
    try {
      const res = await fetch(`/api/admin/audit/export?${filterQuery(applied).toString()}`, { credentials: 'same-origin' });
      // Never save a non-2xx body: it is an error document, not the log.
      if (!res.ok) {
        setExportError(await exportErrorMessage(res));
        return;
      }
      const truncated = res.headers.get(AUDIT_TRUNCATED_HEADER) === 'true';
      const blob = new Blob([await res.arrayBuffer()], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement('a');
        a.href = url;
        a.download = exportFilename(res, truncated);
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
      } finally {
        // One task later, so every browser has started the download before the URL dies.
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
      setExportTruncated(truncated);
    } catch {
      setExportError(EXPORT_FAILED);
    } finally {
      exportInFlight.current = false;
      setExporting(false);
    }
  }

  /** Apply the typed text plus `patch`. Invalid input is reported and nothing is applied. */
  function commit(patch: Partial<Filters> = {}) {
    const next: Filters = {
      ...applied,
      q: draft.q.trim(),
      entityId: draft.entityId.trim(),
      from: draft.from,
      to: draft.to,
      ...patch,
    };
    if (next.entityId && !UUID_RE.test(next.entityId)) {
      setFilterError('Objekt-id skal være et gyldigt id (UUID).');
      return;
    }
    if (next.from && next.to && next.from > next.to) {
      setFilterError('Fra-datoen må ikke ligge efter til-datoen.');
      return;
    }
    setFilterError(null);
    setApplied(next);
  }

  function reset() {
    setDraft({ q: '', entityId: '', from: '', to: '' });
    setFilterError(null);
    setApplied(DEFAULT_FILTERS);
  }

  const customRange = !!(applied.from || applied.to);
  const advancedCount = [applied.outcome, applied.source, applied.entityId, customRange ? 'x' : ''].filter(Boolean).length;
  const filtered = !isDefault(applied);

  return (
    <AdminPage title="Log" description="Aktivitet i løsningen. Loggen viser kun, hvad der er sket, aldrig indholdet af møder, referater eller skabeloner.">
      <ErrorBanner message={meError} />
      {me && !isGlobalReader && (
        <p role="status" className="text-[13px] text-[var(--muted)]">
          Du ser kun hændelser fra de enheder, din rolle gælder for.
        </p>
      )}

      <form
        role="search"
        aria-label="Filtrér loggen"
        onSubmit={(e) => {
          e.preventDefault();
          commit();
        }}
        className="flex flex-col gap-3"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_12rem_12rem]">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="audit-search">Søg efter bruger</Label>
            <div className="flex gap-2">
              <Input
                id="audit-search"
                type="search"
                value={draft.q}
                maxLength={100}
                onChange={(e) => setDraft((d) => ({ ...d, q: e.target.value }))}
                autoComplete="off"
                placeholder="Navn på bruger"
              />
              <Button type="submit" variant="outline">
                Søg
              </Button>
            </div>
          </div>
          <Select
            label="Kategori"
            value={applied.category}
            onChange={(e) => commit({ category: isCategoryKey(e.target.value) ? e.target.value : '' })}
          >
            <option value="">Alle hændelser</option>
            {CATEGORIES.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </Select>
          <Select
            label="Periode"
            value={customRange ? 'custom' : applied.period}
            onChange={(e) => {
              const period = PERIOD_OPTIONS.find((o) => o.value === e.target.value)?.value;
              if (!period) return; // the "custom" entry only reflects the dates below
              setDraft((d) => ({ ...d, from: '', to: '' }));
              commit({ period, from: '', to: '' });
            }}
          >
            {customRange && <option value="custom">Valgt datointerval</option>}
            {PERIOD_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>

        <details className="text-sm">
          <summary className="cursor-pointer select-none text-[var(--ink-2)]">
            Flere filtre{advancedCount > 0 ? ` (${advancedCount} valgt)` : ''}
          </summary>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Select label="Resultat" value={applied.outcome} onChange={(e) => commit({ outcome: e.target.value })}>
              <option value="">Alle</option>
              {Object.entries(outcomeLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
            <Select label="Kilde" value={applied.source} onChange={(e) => commit({ source: e.target.value })}>
              <option value="">Alle</option>
              {Object.entries(sourceLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="audit-entity">Objekt-id</Label>
              <Input
                id="audit-entity"
                value={draft.entityId}
                onChange={(e) => setDraft((d) => ({ ...d, entityId: e.target.value }))}
                autoComplete="off"
                placeholder="UUID (tryk Enter)"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="audit-from">Fra dato</Label>
              <Input
                id="audit-from"
                type="date"
                value={draft.from}
                onChange={(e) => {
                  setDraft((d) => ({ ...d, from: e.target.value }));
                  commit({ from: e.target.value });
                }}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="audit-to">Til dato</Label>
              <Input
                id="audit-to"
                type="date"
                value={draft.to}
                onChange={(e) => {
                  setDraft((d) => ({ ...d, to: e.target.value }));
                  commit({ to: e.target.value });
                }}
              />
            </div>
            <p className="self-end text-[13px] text-[var(--muted)]">Et valgt datointerval erstatter perioden ovenfor.</p>
          </div>
        </details>
      </form>
      <ErrorBanner message={filterError} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <p className="max-w-prose text-[13px] text-[var(--muted)]">
            Hændelser markeret »selvrapporteret« er indberettet af brugerens egen browser. De kan ikke bekræftes af serveren.
          </p>
          {filtered && (
            <Button type="button" variant="link" size="sm" onClick={reset}>
              Nulstil
            </Button>
          )}
        </div>
        {canExport && (
          <Button type="button" variant="outline" size="sm" disabled={exporting} onClick={runExport}>
            {exporting ? 'Eksporterer …' : 'Eksportér som CSV'}
          </Button>
        )}
      </div>

      <ErrorBanner message={exportError} />
      {exportTruncated && (
        <div
          role="status"
          className="flex items-start gap-2.5 rounded-[var(--radius)] px-3 py-2.5 text-[13px] leading-snug text-[var(--ink)]"
          style={{ border: '1px solid color-mix(in oklch, var(--warn) 40%, var(--line))', background: 'color-mix(in oklch, var(--warn) 12%, white)' }}
        >
          <span className="flex-1">{EXPORT_TRUNCATED_WARNING}</span>
          <button type="button" onClick={() => setExportTruncated(false)} className="shrink-0 underline underline-offset-2">
            Luk
          </button>
        </div>
      )}

      <ErrorBanner
        message={loadError}
        onRetry={() => {
          setLoading(true);
          fetchPage(applied, null);
        }}
      />

      {loading || meLoading ? (
        <p role="status" className="text-sm text-[var(--muted)]">
          Indlæser …
        </p>
      ) : events.length === 0 ? (
        !loadError && (
          <div className="rounded-[var(--radius)] border border-[var(--line)] px-4 py-8 text-center">
            <p className="m-0 text-sm text-[var(--ink)]">Ingen hændelser fundet</p>
            {filtered && <p className="m-0 mt-1 text-[13px] text-[var(--muted)]">Prøv et andet navn, en anden kategori eller en længere periode.</p>}
          </div>
        )
      ) : (
        <ol aria-label="Hændelser" className="m-0 list-none rounded-[var(--radius)] border border-[var(--line)] p-0 px-3">
          {events.map((e) => (
            <EventRow key={e.id} e={e} />
          ))}
        </ol>
      )}

      {nextCursor && !loading && (
        <div>
          <Button
            type="button"
            variant="outline"
            disabled={loadingMore}
            onClick={() => {
              setLoadingMore(true);
              fetchPage(applied, nextCursor);
            }}
          >
            {loadingMore ? 'Indlæser …' : 'Indlæs flere'}
          </Button>
        </div>
      )}
    </AdminPage>
  );
}
