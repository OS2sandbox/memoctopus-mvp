'use client';

import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { ErrorBanner } from '@/components/ui/error-banner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { SCOPED_CAPABILITIES } from '@/lib/authz/capabilities';
import { capabilityLabels, roleDescriptions, roleLabels, sourceLabels } from '@/lib/authz/labels.da';
import { useMe } from '@/lib/hooks/use-me';
import { apiRequest } from './api';
import { AdminPage, ReadOnlyBanner } from './AdminPage';
import { describeCapabilityScope } from './scope-text';
import { SyncStatus } from './SyncStatus';

interface UnitName {
  uuid: string;
  name: string;
}

export function AdminOverview() {
  const { data: me, loading, error, reload } = useMe();
  const [names, setNames] = useState<Map<string, string>>(new Map());

  // Unit names are a convenience: /api/me only carries ids. Without the right to
  // read the directory the scope simply reads "Ukendt enhed".
  const canReadNames = !!me && (me.capabilities.includes('directory.read') || me.capabilities.includes('access.manage'));
  useEffect(() => {
    if (!canReadNames) return;
    let cancelled = false;
    apiRequest<{ orgUnits: UnitName[] }>('/api/admin/access/org-units').then((r) => {
      if (cancelled || !r.ok) return;
      setNames(new Map(r.data.orgUnits.map((u) => [u.uuid, u.name])));
    });
    return () => {
      cancelled = true;
    };
  }, [canReadNames]);

  const scopedCapabilities = useMemo(
    () => (me ? me.capabilities.filter((c) => SCOPED_CAPABILITIES.has(c)) : []),
    [me],
  );

  if (loading) return <AdminPage title="Overblik"><p className="text-sm text-[var(--muted)]">Indlæser …</p></AdminPage>;
  if (error || !me) {
    return (
      <AdminPage title="Overblik">
        <ErrorBanner message={error ?? 'Kunne ikke hente dine rettigheder.'} onRetry={reload} />
      </AdminPage>
    );
  }

  return (
    <AdminPage title="Overblik" description="Din identitet, dine roller og hvad de giver adgang til.">
      {me.readOnly && <ReadOnlyBanner />}

      <section aria-labelledby="who-heading" className="flex flex-col gap-2">
        <h2 id="who-heading" className="text-[var(--t-h2)] font-light text-[var(--ink)]">
          Dig
        </h2>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="font-medium text-[var(--ink)]">{me.user.name}</span>
          <span className="font-mono text-[12px] text-[var(--muted)]">{me.user.email}</span>
          <Badge variant={me.source === 'rollekatalog' ? 'default' : 'secondary'}>
            <span className="sr-only">Kilde: </span>
            {sourceLabels[me.source]}
          </Badge>
        </div>
      </section>

      <section aria-labelledby="roles-heading" className="flex flex-col gap-2">
        <h2 id="roles-heading" className="text-[var(--t-h2)] font-light text-[var(--ink)]">
          Dine roller
        </h2>
        {me.roles.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">Du har ingen roller.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {me.roles.map((role) => (
              <li key={role} className="text-sm">
                <span className="font-medium text-[var(--ink)]">{roleLabels[role] ?? role}</span>
                <span className="text-[var(--muted)]"> – {roleDescriptions[role] ?? ''}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="caps-heading" className="flex flex-col gap-2">
        <h2 id="caps-heading" className="text-[var(--t-h2)] font-light text-[var(--ink)]">
          Rettigheder og område
        </h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Rettighed</TableHead>
              <TableHead>Gælder for</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {me.capabilities.map((cap) => (
              <TableRow key={cap}>
                <TableCell>{capabilityLabels[cap] ?? cap}</TableCell>
                <TableCell>
                  {scopedCapabilities.includes(cap) ? describeCapabilityScope(me.scopes[cap], names) : 'Hele løsningen'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      <SyncStatus me={me} />
    </AdminPage>
  );
}
