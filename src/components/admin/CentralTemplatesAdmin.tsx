'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ErrorBanner } from '@/components/ui/error-banner';
import { Select } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableEmptyRow, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useMe } from '@/lib/hooks/use-me';
import type {
  CentralCatalogueEntry,
  CentralScopeOrgUnit,
  CentralTemplateAdmin,
  CentralTemplateListItem,
} from '@/lib/skabeloner/central-types';
import { apiRequest } from './api';
import { AdminPage } from './AdminPage';
import { CentralTemplateEditor } from './CentralTemplateEditor';
import { CentralTemplatesStateDialog, type StateChange } from './CentralTemplatesStateDialog';
import {
  FLAG_TEXT,
  audienceEntries,
  formatTime,
  truncateAudience,
  unitNameLookup,
} from './central-template-utils';
import { TemplateVersionHistory } from './TemplateVersionHistory';

type Filter = 'active' | 'archived' | 'all';
type EditorState = { open: false } | { open: true; template: CentralTemplateAdmin | null };

export function CentralTemplatesAdmin() {
  const { data: me, loading: meLoading, error: meError } = useMe();
  const [filter, setFilter] = useState<Filter>('active');
  const [templates, setTemplates] = useState<CentralTemplateListItem[]>([]);
  const [units, setUnits] = useState<CentralScopeOrgUnit[]>([]);
  const [catalogue, setCatalogue] = useState<CentralCatalogueEntry[]>([]);
  // From the catalogue endpoint: may this caller target roles and groups (a global manager), and may
  // they refresh the catalogue from Rollekatalog.
  const [catalogueInfo, setCatalogueInfo] = useState({ canTarget: false, canRefresh: false, lastRefreshedAt: null as string | null });
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>({ open: false });
  const [stateChange, setStateChange] = useState<{ template: CentralTemplateListItem; mode: StateChange } | null>(null);
  const [history, setHistory] = useState<CentralTemplateListItem | null>(null);

  // Only the newest request may write state, so switching the filter quickly cannot
  // leave the list of the previous filter on screen.
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setLoadError(null);
    const [list, scope, roles] = await Promise.all([
      apiRequest<{ templates: CentralTemplateListItem[] }>(`/api/admin/central-templates?status=${filter}`),
      apiRequest<{ orgUnits: CentralScopeOrgUnit[] }>('/api/admin/central-templates/scope'),
      apiRequest<{ roles: CentralCatalogueEntry[]; canTarget: boolean; canRefresh: boolean; lastRefreshedAt: string | null }>(
        '/api/admin/central-templates/roles',
      ),
    ]);
    if (seq !== requestSeq.current) return;
    if (list.ok) setTemplates(list.data.templates);
    else setLoadError(list.message);
    if (scope.ok) setUnits(scope.data.orgUnits);
    else setLoadError((prev) => prev ?? scope.message);
    if (roles.ok) {
      setCatalogue(roles.data.roles);
      setCatalogueInfo({
        canTarget: roles.data.canTarget,
        canRefresh: roles.data.canRefresh,
        lastRefreshedAt: roles.data.lastRefreshedAt,
      });
    } else setLoadError((prev) => prev ?? roles.message);
    setLoading(false);
  }, [filter]);
  useEffect(() => {
    load();
  }, [load]);

  const unitName = useMemo(() => unitNameLookup(units), [units]);

  // The page gate guarantees template.manage; the controls only wait for /api/me. The server decides on every write.
  const canManage = !!me;

  async function refreshCatalogue() {
    setRefreshing(true);
    setActionError(null);
    setRefreshNote(null);
    const res = await apiRequest<{ counts: { fetched: number; added: number; deactivated: number } }>(
      '/api/admin/central-templates/roles/refresh',
      { method: 'POST', json: {} },
    );
    setRefreshing(false);
    if (!res.ok) return setActionError(res.message);
    const c = res.data.counts;
    setRefreshNote(`Rollekataloget er opdateret: ${c.fetched} roller og grupper, ${c.added} nye, ${c.deactivated} fjernet.`);
    load();
  }

  async function openEditor(item: CentralTemplateListItem | null) {
    setActionError(null);
    if (item === null) return setEditor({ open: true, template: null });
    const res = await apiRequest<{ template: CentralTemplateAdmin }>(`/api/admin/central-templates/${item.id}`);
    if (!res.ok) return setActionError(res.message);
    setEditor({ open: true, template: res.data.template });
  }

  return (
    <AdminPage
      title="Centrale skabeloner"
      description="Fælles skabeloner, som du gør til rådighed for enheder, roller og grupper. Brugerne kan bruge dem, men ikke læse eller ændre dem."
    >
      <ErrorBanner message={meError} />
      <ErrorBanner message={loadError} onRetry={load} />
      <ErrorBanner message={actionError} />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <Select
          label="Vis"
          value={filter}
          onChange={(e) => setFilter(e.target.value as Filter)}
          wrapperClassName="w-48"
        >
          <option value="active">Aktive</option>
          <option value="archived">Arkiverede</option>
          <option value="all">Alle</option>
        </Select>
        <div className="flex flex-wrap items-center gap-2">
          {canManage && catalogueInfo.canRefresh && (
            <Button type="button" variant="outline" onClick={refreshCatalogue} disabled={refreshing}>
              {refreshing ? 'Opdaterer …' : 'Opdatér rollekatalog'}
            </Button>
          )}
          {canManage && (
            <Button type="button" onClick={() => openEditor(null)}>
              Ny central skabelon
            </Button>
          )}
        </div>
      </div>
      {refreshNote && (
        <p role="status" className="text-[13px] text-[var(--ink-2)]">
          {refreshNote}
        </p>
      )}

      {loading || meLoading ? (
        <p role="status" className="text-sm text-[var(--muted)]">Indlæser …</p>
      ) : (
        <Table>
          <caption className="sr-only">Centrale skabeloner</caption>
          <TableHeader>
            <TableRow>
              <TableHead>Skabelon</TableHead>
              <TableHead>Ejerenhed</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Til rådighed for</TableHead>
              <TableHead>Oprettet af</TableHead>
              <TableHead>Senest ændret</TableHead>
              <TableHead>Handlinger</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {templates.length === 0 && !loadError ? (
              <TableEmptyRow colSpan={8}>Ingen centrale skabeloner</TableEmptyRow>
            ) : (
              templates.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>
                    <div className="font-medium">{t.name}</div>
                    {t.description && <div className="text-[13px] text-[var(--muted)]">{t.description}</div>}
                  </TableCell>
                  <TableCell>
                    {t.ownerOrgUnitUuid === null ? (
                      <span title="Ingen ejerenhed: kun skabelonansvarlige for hele organisationen kan redigere den">
                        Hele organisationen
                      </span>
                    ) : (
                      unitName(t.ownerOrgUnitUuid)
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={t.status === 'active' ? 'success' : 'secondary'}>
                      {t.status === 'active' ? 'Aktiv' : 'Arkiveret'}
                    </Badge>
                  </TableCell>
                  <TableCell>{t.currentVersion}</TableCell>
                  <TableCell>
                    <Audience template={t} unitName={unitName} />
                  </TableCell>
                  <TableCell>{t.createdByName ?? <span className="text-[var(--muted)]">Ukendt</span>}</TableCell>
                  <TableCell>
                    <div>{t.lastEditedByName ?? <span className="text-[var(--muted)]">Ukendt</span>}</div>
                    <div className="text-[13px] text-[var(--muted)]">{formatTime(t.lastEditedAt)}</div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-2">
                      {canManage && t.status === 'active' && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-label={`Rediger ${t.name}`}
                          onClick={() => openEditor(t)}
                        >
                          Rediger
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        aria-label={`Historik for ${t.name}`}
                        onClick={() => setHistory(t)}
                      >
                        Historik
                      </Button>
                      {canManage && (
                        <Button
                          type="button"
                          size="sm"
                          variant={t.status === 'active' ? 'danger-ghost' : 'outline'}
                          aria-label={`${t.status === 'active' ? 'Arkivér (fjerner for alle)' : 'Gendan'} ${t.name}`}
                          onClick={() =>
                            setStateChange({ template: t, mode: t.status === 'active' ? 'archive' : 'restore' })
                          }
                        >
                          {t.status === 'active' ? 'Arkivér (fjerner for alle)' : 'Gendan'}
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      )}

      {canManage && editor.open && (
        <CentralTemplateEditor
          open
          onOpenChange={(o) => !o && setEditor({ open: false })}
          template={editor.template}
          units={units}
          catalogue={catalogue}
          isGlobalManager={catalogueInfo.canTarget}
          onSaved={load}
        />
      )}

      <CentralTemplatesStateDialog
        open={stateChange !== null}
        onOpenChange={(o) => !o && setStateChange(null)}
        template={stateChange?.template ?? null}
        mode={stateChange?.mode ?? 'archive'}
        onDone={load}
      />

      <Dialog open={history !== null} onOpenChange={(o) => !o && setHistory(null)}>
        <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Ændringshistorik</DialogTitle>
            <DialogDescription>{history ? `»${history.name}«. Nyeste version først.` : ''}</DialogDescription>
          </DialogHeader>
          {history && <TemplateVersionHistory templateId={history.id} unitName={unitName} />}
        </DialogContent>
      </Dialog>
    </AdminPage>
  );
}

/** Who the template is made available to, by name: roles, groups and units, a few shown and "+N" for the rest. */
function Audience({ template, unitName }: { template: CentralTemplateListItem; unitName: (uuid: string) => string }) {
  const { shown, more } = truncateAudience(audienceEntries(template, unitName));
  if (shown.length === 0) return <Badge variant="warning">Ikke til rådighed for nogen</Badge>;
  return (
    <ul aria-label={`Til rådighed for, ${template.name}`} className="flex flex-col gap-0.5 text-[13px]">
      {shown.map((e) => (
        <li key={e.key} style={e.flagged ? { color: 'var(--warn)' } : undefined}>
          {e.label}
          {e.flagged && ` (${FLAG_TEXT})`}
        </li>
      ))}
      {more.length > 0 && (
        <li className="text-[var(--muted)]" title={more.map((e) => e.label).join('\n')}>
          +{more.length} flere
        </li>
      )}
    </ul>
  );
}
