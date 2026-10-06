'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ErrorBanner } from '@/components/ui/error-banner';
import { Table, TableBody, TableCell, TableEmptyRow, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { sourceLabels } from '@/lib/authz/labels.da';
import { meToPrincipal } from '@/lib/authz/me';
import { explainDenial } from '@/lib/authz/permissions';
import { useMe } from '@/lib/hooks/use-me';
import { apiRequest } from './api';
import { AdminPage, ReadOnlyBanner } from './AdminPage';
import { flattenOrgTree } from './org-tree';
import { OrgUnitFormDialog } from './OrgUnitFormDialog';
import { OrgUnitMembersDialog } from './OrgUnitMembersDialog';
import { LastSyncLine } from './SyncStatus';

interface OrgUnit {
  uuid: string;
  name: string;
  parentUuid: string | null;
  source: string;
  memberCount: number;
}

type FormState = { open: false } | { open: true; unit: OrgUnit | null };

export function OrganisationAdmin() {
  const { data: me, loading: meLoading, error: meError } = useMe();
  const { toast } = useToast();
  const [units, setUnits] = useState<OrgUnit[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>({ open: false });
  const [members, setMembers] = useState<OrgUnit | null>(null);
  const [remove, setRemove] = useState<OrgUnit | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  // Only the newest request may write state, so a slow old response cannot overwrite a newer reload.
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setLoadError(null);
    const res = await apiRequest<{ orgUnits: OrgUnit[] }>('/api/admin/access/org-units');
    if (seq !== requestSeq.current) return;
    if (res.ok) setUnits(res.data.orgUnits);
    else setLoadError(res.message);
    setLoading(false);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const rows = useMemo(() => flattenOrgTree(units), [units]);

  // Advisory only: the server decides. These flags just keep the UI from
  // offering actions it would answer with 403/409.
  const principal = me ? meToPrincipal(me) : null;
  const denial = principal ? explainDenial(principal, 'access.manage') : null;
  const isManager = denial === null && !!me;
  const canWrite = isManager && !me!.readOnly;

  async function confirmRemove() {
    if (!remove) return;
    setRemoving(true);
    setRemoveError(null);
    const res = await apiRequest(`/api/admin/access/org-units/${remove.uuid}`, { method: 'DELETE' });
    setRemoving(false);
    if (!res.ok) return setRemoveError(res.message);
    toast({ message: 'Enheden er slettet', variant: 'success' });
    setRemove(null);
    load();
  }

  return (
    <AdminPage title="Organisation" description="Organisationsenheder og deres medlemmer.">
      {me?.readOnly && <ReadOnlyBanner />}
      <LastSyncLine me={me} />
      {me && !me.readOnly && denial && (
        <p className="text-[13px] text-[var(--muted)]">Kun visning. {denial}</p>
      )}
      <ErrorBanner message={meError} />
      <ErrorBanner message={loadError} onRetry={load} />

      {canWrite && (
        <div>
          <Button type="button" onClick={() => setForm({ open: true, unit: null })}>
            Opret enhed
          </Button>
        </div>
      )}

      {loading || meLoading ? (
        <p role="status" className="text-sm text-[var(--muted)]">Indlæser …</p>
      ) : (
        <Table>
          <caption className="sr-only">Organisationsenheder</caption>
          <TableHeader>
            <TableRow>
              <TableHead>Enhed</TableHead>
              <TableHead>Medlemmer</TableHead>
              <TableHead>Kilde</TableHead>
              {isManager && <TableHead>Handlinger</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && !loadError ? (
              <TableEmptyRow colSpan={isManager ? 4 : 3}>Ingen organisationsenheder</TableEmptyRow>
            ) : (
              rows.map(({ unit, depth }) => {
                const editable = canWrite && unit.source === 'local';
                return (
                  <TableRow key={unit.uuid}>
                    <TableCell>
                      {/* Indentation is visual only; screen readers get the level as text. */}
                      {depth > 0 && <span className="sr-only">{`Niveau ${depth + 1}: `}</span>}
                      <span style={{ paddingLeft: depth * 20 }} data-depth={depth}>
                        {unit.name}
                      </span>
                    </TableCell>
                    <TableCell>{unit.memberCount}</TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {unit.source === 'local' || unit.source === 'rollekatalog'
                          ? sourceLabels[unit.source]
                          : unit.source}
                      </Badge>
                    </TableCell>
                    {isManager && (
                      <TableCell>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            aria-label={`${editable ? 'Rediger medlemmer' : 'Vis medlemmer'} i ${unit.name}`}
                            onClick={() => setMembers(unit)}
                          >
                            Medlemmer
                          </Button>
                          {editable && (
                            <>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                aria-label={`Rediger ${unit.name}`}
                                onClick={() => setForm({ open: true, unit })}
                              >
                                Rediger
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="danger-ghost"
                                aria-label={`Slet ${unit.name}`}
                                onClick={() => {
                                  setRemoveError(null);
                                  setRemove(unit);
                                }}
                              >
                                Slet
                              </Button>
                            </>
                          )}
                          {canWrite && !editable && (
                            <span className="self-center text-[12px] text-[var(--muted)]">Styres af Rollekatalog</span>
                          )}
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      )}

      {canWrite && form.open && (
        <OrgUnitFormDialog
          open
          onOpenChange={(o) => !o && setForm({ open: false })}
          unit={form.unit}
          orgUnits={units}
          onSaved={load}
        />
      )}

      <OrgUnitMembersDialog
        open={members !== null}
        onOpenChange={(o) => !o && setMembers(null)}
        unit={members}
        editable={canWrite && members?.source === 'local'}
        onSaved={load}
      />

      <Dialog open={remove !== null} onOpenChange={(o) => !o && !removing && setRemove(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Slet enhed</DialogTitle>
            <DialogDescription>{remove ? `Vil du slette enheden »${remove.name}«?` : ''}</DialogDescription>
          </DialogHeader>
          <ErrorBanner message={removeError} className="mt-3" />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRemove(null)} disabled={removing}>
              Annuller
            </Button>
            <Button type="button" variant="destructive" onClick={confirmRemove} disabled={removing}>
              {removing ? 'Sletter …' : 'Bekræft sletning'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminPage>
  );
}
