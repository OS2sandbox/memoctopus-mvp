'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ErrorBanner } from '@/components/ui/error-banner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableEmptyRow, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { eventTypeLabel, eventTypeLabels, outcomeLabels, sourceBadgeLabels, sourceLabels } from '@/lib/audit/labels.da';
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
}

interface Filters {
  eventType: string;
  outcome: string;
  source: string;
  from: string;
  to: string;
  actorUserId: string;
  entityId: string;
}

const EMPTY: Filters = { eventType: '', outcome: '', source: '', from: '', to: '', actorUserId: '', entityId: '' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 50;

const EVENT_OPTIONS = Object.keys(eventTypeLabels)
  .map((value) => ({ value, label: eventTypeLabel(value) }))
  .sort((a, b) => a.label.localeCompare(b.label, 'da'));

/** Filters as a query string; dates are the user's local days, sent as instants. */
function filterQuery(f: Filters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.eventType) p.append('eventType', f.eventType);
  if (f.outcome) p.set('outcome', f.outcome);
  if (f.source) p.set('source', f.source);
  if (f.from) p.set('from', new Date(`${f.from}T00:00:00`).toISOString());
  if (f.to) p.set('to', new Date(`${f.to}T23:59:59.999`).toISOString());
  if (f.actorUserId) p.set('actorUserId', f.actorUserId);
  if (f.entityId) p.set('entityId', f.entityId.toLowerCase());
  return p;
}

const formatTime = (iso: string) => formatDateTime(iso, { dateStyle: 'short', timeStyle: 'medium' });

function formatDetails(details: Record<string, unknown>): string {
  return Object.entries(details)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
    .join(' · ');
}

const outcomeVariant = { success: 'success', denied: 'warning', error: 'destructive' } as const;

export function AuditLog() {
  const { data: me, loading: meLoading, error: meError } = useMe();
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [events, setEvents] = useState<AuditEventView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Only the newest request may write state, so a slow old response cannot overwrite a newer filter.
  const requestSeq = useRef(0);

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
  const showNetwork = events.some((e) => e.ipAddress);
  const exportHref = useMemo(() => `/api/admin/audit/export?${filterQuery(applied).toString()}`, [applied]);

  function applyFilters(e: React.FormEvent) {
    e.preventDefault();
    const entityId = draft.entityId.trim();
    if (entityId && !UUID_RE.test(entityId)) {
      setFilterError('Objekt-id skal være et gyldigt id (UUID).');
      return;
    }
    if (draft.from && draft.to && draft.from > draft.to) {
      setFilterError('Fra-datoen må ikke ligge efter til-datoen.');
      return;
    }
    setFilterError(null);
    setApplied({ ...draft, actorUserId: draft.actorUserId.trim(), entityId });
  }

  function reset() {
    setDraft(EMPTY);
    setFilterError(null);
    setApplied(EMPTY);
  }

  const set = (key: keyof Filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setDraft((d) => ({ ...d, [key]: e.target.value }));

  const columns = showNetwork ? 8 : 7;

  return (
    <AdminPage title="Log" description="Aktivitet i løsningen. Loggen viser kun, hvad der er sket, aldrig indholdet af møder, referater eller skabeloner.">
      <ErrorBanner message={meError} />
      {me && !isGlobalReader && (
        <p role="status" className="text-[13px] text-[var(--muted)]">
          Du ser kun hændelser fra de enheder, din rolle gælder for.
        </p>
      )}

      <form role="search" aria-label="Filtrér loggen" onSubmit={applyFilters} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Select label="Hændelse" value={draft.eventType} onChange={set('eventType')}>
          <option value="">Alle hændelser</option>
          {EVENT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        <Select label="Resultat" value={draft.outcome} onChange={set('outcome')}>
          <option value="">Alle</option>
          {Object.entries(outcomeLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
        <Select label="Kilde" value={draft.source} onChange={set('source')}>
          <option value="">Alle</option>
          {Object.entries(sourceLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-actor">
            Bruger-id
          </Label>
          <Input id="audit-actor" value={draft.actorUserId} onChange={set('actorUserId')} autoComplete="off" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-entity">
            Objekt-id
          </Label>
          <Input id="audit-entity" value={draft.entityId} onChange={set('entityId')} autoComplete="off" placeholder="UUID" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-from">
            Fra dato
          </Label>
          <Input id="audit-from" type="date" value={draft.from} onChange={set('from')} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-to">
            Til dato
          </Label>
          <Input id="audit-to" type="date" value={draft.to} onChange={set('to')} />
        </div>
        <div className="flex items-end gap-2">
          <Button type="submit">Filtrér</Button>
          <Button type="button" variant="outline" onClick={reset}>
            Nulstil
          </Button>
        </div>
      </form>
      <ErrorBanner message={filterError} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-prose text-[13px] text-[var(--muted)]">
          Hændelser markeret »selvrapporteret« er indberettet af brugerens egen browser. De kan ikke bekræftes af serveren.
        </p>
        {canExport && (
          <a
            href={exportHref}
            download
            className="inline-flex h-9 min-h-[36px] items-center justify-center rounded-[var(--radius)] border border-[var(--line-strong)] px-3 text-xs font-medium text-[var(--ink)] hover:bg-[var(--surface-2)]"
          >
            Eksportér som CSV
          </a>
        )}
      </div>

      <ErrorBanner message={loadError} onRetry={() => {
          setLoading(true);
          fetchPage(applied, null);
        }} />

      {loading || meLoading ? (
        <p className="text-sm text-[var(--muted)]">Indlæser …</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tidspunkt</TableHead>
              <TableHead>Hændelse</TableHead>
              <TableHead>Resultat</TableHead>
              <TableHead>Bruger</TableHead>
              <TableHead>Objekt</TableHead>
              <TableHead>Kilde</TableHead>
              <TableHead>Detaljer</TableHead>
              {showNetwork && <TableHead>IP-adresse</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.length === 0 && !loadError ? (
              <TableEmptyRow colSpan={columns}>Ingen hændelser fundet</TableEmptyRow>
            ) : (
              events.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap align-top text-[13px]">{formatTime(e.occurredAt)}</TableCell>
                  <TableCell className="align-top">
                    <div className="font-medium text-[var(--ink)]">{eventTypeLabel(e.eventType)}</div>
                    <div className="font-mono text-[11px] text-[var(--muted)]">{e.eventType}</div>
                  </TableCell>
                  <TableCell className="align-top">
                    <Badge variant={outcomeVariant[e.outcome] ?? 'outline'}>{outcomeLabels[e.outcome] ?? e.outcome}</Badge>
                  </TableCell>
                  <TableCell className="align-top">
                    {e.actorUserId ? (
                      <>
                        <div>{e.actorName ?? 'Ukendt navn'}</div>
                        <div className="font-mono text-[11px] text-[var(--muted)]">{e.actorUserId}</div>
                      </>
                    ) : (
                      <span className="text-[var(--muted)]">Ingen bruger</span>
                    )}
                  </TableCell>
                  <TableCell className="align-top">
                    {e.entityId ? (
                      <>
                        <div className="text-[13px]">{e.entityType}</div>
                        <div className="font-mono text-[11px] text-[var(--muted)]">{e.entityId}</div>
                      </>
                    ) : (
                      <span className="text-[var(--muted)]">–</span>
                    )}
                  </TableCell>
                  <TableCell className="align-top">
                    <Badge variant={e.source === 'client' ? 'warning' : 'secondary'}>{sourceBadgeLabels[e.source] ?? e.source}</Badge>
                  </TableCell>
                  <TableCell className="align-top font-mono text-[11px] text-[var(--ink-2)]">{formatDetails(e.details)}</TableCell>
                  {showNetwork && <TableCell className="align-top font-mono text-[11px]">{e.ipAddress ?? ''}</TableCell>}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
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
