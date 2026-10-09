'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ErrorBanner } from '@/components/ui/error-banner';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableEmptyRow, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { roleLabels, sourceLabels } from '@/lib/authz/labels.da';
import { isRoleKey } from '@/lib/authz/capabilities';
import { useMe } from '@/lib/hooks/use-me';
import type { AccessSource } from '@/lib/authz/config';
import { apiRequest } from './api';
import { AdminPage } from './AdminPage';
import { RoleGrantDialog } from './RoleGrantDialog';
import { describeAssignmentScope } from './scope-text';
import { RoleSourceCard } from './RoleSourceCard';
import { LastSyncLine, SyncStatus, canSeeSyncRun, useSyncRun } from './SyncStatus';
import type { TreeUnit } from './org-tree';

// Mirrors AssignmentView / AppUserView from the access service (JSON, so dates are strings).
interface Assignment {
  id: string;
  roleKey: string;
  scopeOrgUnitUuid: string | null;
  scopeOrgUnitName: string | null;
  includeDescendants: boolean;
  startDate: string | null;
  stopDate: string | null;
  source: string;
  active: boolean;
}

interface AppUser {
  id: string;
  name: string;
  email: string;
  directoryUserUuid: string | null;
  disabled: boolean;
  roles: Assignment[];
}

const roleName = (key: string) => (isRoleKey(key) ? roleLabels[key] : key);
const sourceName = (s: string) =>
  s === 'local' || s === 'rollekatalog' || s === 'claims' ? sourceLabels[s as AccessSource] : s;
const day = (iso: string) => iso.slice(0, 10);

function inactiveReason(a: Assignment, now = Date.now()): string {
  if (a.stopDate && new Date(a.stopDate).getTime() <= now) return 'Udløbet';
  if (a.startDate && new Date(a.startDate).getTime() > now) return 'Starter senere';
  return 'Inaktiv';
}

export function UsersAdmin() {
  const { data: me, loading: meLoading, error: meError } = useMe();
  const { toast } = useToast();
  // One read of the latest sync run serves the explanation card, the "last synchronised" line and the sync panel.
  const sync = useSyncRun(!!me && canSeeSyncRun(me));
  const [users, setUsers] = useState<AppUser[]>([]);
  const [orgUnits, setOrgUnits] = useState<TreeUnit[]>([]);
  const [orgUnitsError, setOrgUnitsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  // Only the newest request may write state, so a slow old response cannot overwrite a newer search.
  const requestSeq = useRef(0);
  const [q, setQ] = useState('');
  const [appliedQ, setAppliedQ] = useState('');
  const [grantFor, setGrantFor] = useState<AppUser | null>(null);
  const [revoke, setRevoke] = useState<{ user: AppUser; assignment: Assignment } | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);

  const load = useCallback(async (query: string) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setLoadError(null);
    const qs = query ? `?q=${encodeURIComponent(query)}` : '';
    const res = await apiRequest<{ users: AppUser[]; truncated?: boolean }>(`/api/admin/access/users${qs}`);
    if (seq !== requestSeq.current) return;
    if (res.ok) {
      setUsers(res.data.users);
      setTruncated(res.data.truncated === true);
    } else {
      setLoadError(res.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load(appliedQ);
  }, [load, appliedQ]);

  const loadOrgUnits = useCallback(async () => {
    const res = await apiRequest<{ orgUnits: TreeUnit[] }>('/api/admin/access/org-units');
    if (res.ok) {
      setOrgUnits(res.data.orgUnits);
      setOrgUnitsError(null);
    } else {
      setOrgUnitsError('Kunne ikke hente organisationsenheder.');
    }
  }, []);
  useEffect(() => {
    loadOrgUnits();
  }, [loadOrgUnits]);

  // Advisory only: the page gate guarantees access.manage, so this only hides controls in
  // Rollekatalog mode. The server re-checks capability, mode and row ownership on every write.
  const canWrite = !!me && !me.readOnly;

  async function confirmRevoke() {
    if (!revoke) return;
    setRevoking(true);
    setRevokeError(null);
    const res = await apiRequest(`/api/admin/access/assignments/${revoke.assignment.id}`, { method: 'DELETE' });
    setRevoking(false);
    if (!res.ok) {
      setRevokeError(res.message);
      return;
    }
    toast({ message: `Rollen »${roleName(revoke.assignment.roleKey)}« er fjernet fra ${revoke.user.name}`, variant: 'success' });
    setRevoke(null);
    load(appliedQ);
  }

  return (
    <AdminPage title="Brugere og roller" description="Brugere i løsningen og de roller, de er tildelt.">
      {me?.readOnly && <RoleSourceCard source={me.source} itSystem={sync.data?.itSystem} />}
      <LastSyncLine me={me} sync={sync} />
      <ErrorBanner message={meError} />
      <ErrorBanner message={loadError} onRetry={() => load(appliedQ)} />

      <form
        role="search"
        className="flex max-w-md gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setAppliedQ(q.trim());
        }}
      >
        <Input aria-label="Søg i brugere" placeholder="Søg på navn eller e-mail" maxLength={100} value={q} onChange={(e) => setQ(e.target.value)} />
        <Button type="submit" variant="outline">
          Søg
        </Button>
      </form>

      {loading || meLoading ? (
        <p role="status" className="text-sm text-[var(--muted)]">Indlæser …</p>
      ) : (
        <Table>
          <caption className="sr-only">Brugere og deres roller</caption>
          <TableHeader>
            <TableRow>
              <TableHead>Bruger</TableHead>
              <TableHead>Roller</TableHead>
              {canWrite && <TableHead>Handlinger</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.length === 0 && !loadError ? (
              <TableEmptyRow colSpan={canWrite ? 3 : 2}>Ingen brugere fundet</TableEmptyRow>
            ) : (
              users.map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="align-top">
                    <div className="font-medium text-[var(--ink)]">{user.name}</div>
                    <div className="font-mono text-[12px] text-[var(--muted)]">{user.email}</div>
                    {user.disabled && <Badge variant="destructive">Deaktiveret</Badge>}
                  </TableCell>
                  <TableCell className="align-top">
                    {user.roles.length === 0 ? (
                      <span className="text-[var(--muted)]">Ingen roller (standardrettighed)</span>
                    ) : (
                      <ul className="flex flex-col gap-2">
                        {user.roles.map((a) => (
                          <li key={a.id} className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{roleName(a.roleKey)}</span>
                            <span className="text-[13px] text-[var(--muted)]">{describeAssignmentScope(a)}</span>
                            <Badge variant="outline">{sourceName(a.source)}</Badge>
                            {!a.active && <Badge variant="warning">{inactiveReason(a)}</Badge>}
                            {(a.startDate || a.stopDate) && (
                              <span className="text-[12px] text-[var(--muted)]">
                                {a.startDate ? `fra ${day(a.startDate)}` : ''} {a.stopDate ? `indtil ${day(a.stopDate)}` : ''}
                              </span>
                            )}
                            {canWrite && a.source === 'local' && (
                              <Button
                                type="button"
                                size="sm"
                                variant="danger-ghost"
                                aria-label={`Fjern ${roleName(a.roleKey)} fra ${user.name}`}
                                onClick={() => {
                                  setRevokeError(null);
                                  setRevoke({ user, assignment: a });
                                }}
                              >
                                Fjern
                              </Button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </TableCell>
                  {canWrite && (
                    <TableCell className="align-top">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={user.disabled}
                        title={user.disabled ? 'Brugeren er deaktiveret' : undefined}
                        aria-label={`Tildel rolle til ${user.name}`}
                        onClick={() => setGrantFor(user)}
                      >
                        Tildel rolle
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      )}

      {truncated && !loading && !meLoading && (
        <p role="note" className="text-[13px] text-[var(--muted)]">
          Viser de første {users.length}. Brug søgefeltet for at finde flere.
        </p>
      )}

      {me && <SyncStatus me={me} sync={sync} />}

      {canWrite && (
        <RoleGrantDialog
          open={grantFor !== null}
          onOpenChange={(o) => !o && setGrantFor(null)}
          user={grantFor ? { id: grantFor.id, name: grantFor.name } : null}
          orgUnits={orgUnits}
          orgUnitsError={orgUnitsError}
          onGranted={() => load(appliedQ)}
        />
      )}

      <Dialog open={revoke !== null} onOpenChange={(o) => !o && !revoking && setRevoke(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Fjern rolle</DialogTitle>
            <DialogDescription>
              {revoke
                ? `Vil du fjerne rollen »${roleName(revoke.assignment.roleKey)}« fra ${revoke.user.name}?`
                : ''}
            </DialogDescription>
          </DialogHeader>
          <ErrorBanner message={revokeError} className="mt-3" />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRevoke(null)} disabled={revoking}>
              Annuller
            </Button>
            <Button type="button" variant="destructive" onClick={confirmRevoke} disabled={revoking}>
              {revoking ? 'Fjerner …' : 'Bekræft fjernelse'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminPage>
  );
}
