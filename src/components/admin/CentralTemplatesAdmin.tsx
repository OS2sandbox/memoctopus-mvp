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
  CentralScopeOrgUnit,
  CentralTemplateAdmin,
  CentralTemplateListItem,
} from '@/lib/skabeloner/central-types';
import { apiRequest } from './api';
import { AdminPage } from './AdminPage';
import { CentralTemplateEditor } from './CentralTemplateEditor';
import { CentralTemplatesStateDialog, type StateChange } from './CentralTemplatesStateDialog';
import { formatTime, unitNameLookup } from './central-template-utils';
import { TemplateVersionHistory } from './TemplateVersionHistory';

type Filter = 'active' | 'archived' | 'all';
type EditorState = { open: false } | { open: true; template: CentralTemplateAdmin | null };

export function CentralTemplatesAdmin() {
  const { data: me, loading: meLoading, error: meError } = useMe();
  const [filter, setFilter] = useState<Filter>('active');
  const [templates, setTemplates] = useState<CentralTemplateListItem[]>([]);
  const [units, setUnits] = useState<CentralScopeOrgUnit[]>([]);
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
    const [list, scope] = await Promise.all([
      apiRequest<{ templates: CentralTemplateListItem[] }>(`/api/admin/central-templates?status=${filter}`),
      apiRequest<{ orgUnits: CentralScopeOrgUnit[] }>('/api/admin/central-templates/scope'),
    ]);
    if (seq !== requestSeq.current) return;
    if (list.ok) setTemplates(list.data.templates);
    else setLoadError(list.message);
    if (scope.ok) setUnits(scope.data.orgUnits);
    else setLoadError((prev) => prev ?? scope.message);
    setLoading(false);
  }, [filter]);
  useEffect(() => {
    load();
  }, [load]);

  const unitName = useMemo(() => unitNameLookup(units), [units]);

  // The page gate guarantees template.manage; the controls only wait for /api/me. The server decides on every write.
  const canManage = !!me;

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
      description="Skabeloner, som du uddelegerer til medarbejdere under dig. Brugerne kan ikke ændre dem."
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
        {canManage && (
          <Button type="button" onClick={() => openEditor(null)}>
            Ny central skabelon
          </Button>
        )}
      </div>

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
                  <TableCell>{unitName(t.ownerOrgUnitUuid)}</TableCell>
                  <TableCell>
                    <Badge variant={t.status === 'active' ? 'success' : 'secondary'}>
                      {t.status === 'active' ? 'Aktiv' : 'Arkiveret'}
                    </Badge>
                  </TableCell>
                  <TableCell>{t.currentVersion}</TableCell>
                  <TableCell>
                    {t.targetCount === 0 ? (
                      <Badge variant="warning">Ikke til rådighed for nogen</Badge>
                    ) : (
                      `${t.targetCount} ${t.targetCount === 1 ? 'enhed' : 'enheder'}`
                    )}
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
                          aria-label={`${t.status === 'active' ? 'Arkivér' : 'Gendan'} ${t.name}`}
                          onClick={() =>
                            setStateChange({ template: t, mode: t.status === 'active' ? 'archive' : 'restore' })
                          }
                        >
                          {t.status === 'active' ? 'Arkivér' : 'Gendan'}
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
