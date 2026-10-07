'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ErrorBanner } from '@/components/ui/error-banner';
import { Table, TableBody, TableCell, TableEmptyRow, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { meToPrincipal } from '@/lib/authz/me';
import { explainDenial } from '@/lib/authz/permissions';
import { useMe } from '@/lib/hooks/use-me';
import { apiRequest } from './api';
import { AdminPage, ReadOnlyBanner } from './AdminPage';
import { flattenOrgTree } from './org-tree';
import { OrgUnitFormDialog } from './OrgUnitFormDialog';
import { OrgUnitMembersDialog } from './OrgUnitMembersDialog';
import { OrgUnitMembersList } from './OrgUnitMembersList';
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
  // The unit whose members are being edited (local mode, local units only).
  const [members, setMembers] = useState<OrgUnit | null>(null);
  // Units with an open member panel; `opened` keeps a panel mounted (hidden) after the first expand so it loads once.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [membersRev, setMembersRev] = useState(0);
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
  // Unit | Members, plus an actions column only where there are actions (local mode).
  const columns = canWrite ? 3 : 2;

  function toggleUnit(uuid: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) next.delete(uuid);
      else next.add(uuid);
      return next;
    });
    setOpened((prev) => (prev.has(uuid) ? prev : new Set(prev).add(uuid)));
  }

  // Members were edited: forget every closed panel and reload the open ones with the new data.
  function membersSaved() {
    setOpened(new Set(expanded));
    setMembersRev((n) => n + 1);
    void load();
  }

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
      {me?.readOnly && <ReadOnlyBanner source={me.source} />}
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
              {canWrite && <TableHead>Handlinger</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && !loadError ? (
              <TableEmptyRow colSpan={columns}>Ingen organisationsenheder</TableEmptyRow>
            ) : (
              rows.map(({ unit, depth }) => {
                const editable = canWrite && unit.source === 'local';
                const isOpen = expanded.has(unit.uuid);
                const panelId = `unit-members-${unit.uuid}`;
                return (
                  <Fragment key={unit.uuid}>
                    <TableRow>
                      <TableCell>
                        {/* Indentation is visual only; screen readers get the level as text. */}
                        {depth > 0 && <span className="sr-only">{`Niveau ${depth + 1}: `}</span>}
                        <div className="flex items-center gap-1" style={{ paddingLeft: depth * 20 }}>
                          {isManager && (
                            <button
                              type="button"
                              aria-expanded={isOpen}
                              aria-controls={panelId}
                              aria-label={`${isOpen ? 'Skjul' : 'Vis'} medlemmer af ${unit.name}`}
                              onClick={() => toggleUnit(unit.uuid)}
                              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--muted)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                            >
                              <svg
                                aria-hidden
                                width="12"
                                height="12"
                                viewBox="0 0 12 12"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                style={{ transform: isOpen ? 'rotate(90deg)' : undefined, transition: 'transform 120ms' }}
                              >
                                <path d="M4 2l4 4-4 4" />
                              </svg>
                            </button>
                          )}
                          <span data-depth={depth}>{unit.name}</span>
                        </div>
                      </TableCell>
                      <TableCell>{unit.memberCount}</TableCell>
                      {canWrite && (
                        <TableCell>
                          {editable ? (
                            <div className="flex flex-wrap gap-2">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                aria-label={`Rediger medlemmer i ${unit.name}`}
                                onClick={() => setMembers(unit)}
                              >
                                Medlemmer
                              </Button>
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
                            </div>
                          ) : (
                            <span className="text-[12px] text-[var(--muted)]">Styres af Rollekatalog</span>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                    {isManager && opened.has(unit.uuid) && (
                      <TableRow hidden={!isOpen} className="bg-[var(--surface-2)] hover:bg-[var(--surface-2)]">
                        <TableCell colSpan={columns} className="pb-3 pt-1">
                          <div style={{ paddingLeft: depth * 20 + 28 }}>
                            <OrgUnitMembersList
                              key={membersRev}
                              id={panelId}
                              unitUuid={unit.uuid}
                              unitName={unit.name}
                            />
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
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
        onSaved={membersSaved}
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
