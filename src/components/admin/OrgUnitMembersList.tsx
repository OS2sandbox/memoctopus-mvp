'use client';

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner } from '@/components/ui/error-banner';
import { apiRequest } from './api';

interface Member {
  directoryUserUuid: string;
  name: string;
  email?: string | null;
}

interface MembersResponse {
  members: Member[];
  /** Set by the API when it cut the list; the panel then says so. */
  truncated?: boolean;
}

/**
 * Read-only list of the people in one unit, shown under its row in the organisation table.
 * Mounted only once the row has been expanded, so the members are fetched lazily.
 */
export function OrgUnitMembersList({ unitUuid, unitName, id }: { unitUuid: string; unitName: string; id: string }) {
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: MembersResponse }
  >({ status: 'loading' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    const res = await apiRequest<MembersResponse>(`/api/admin/access/org-units/${unitUuid}/members`);
    setState(res.ok ? { status: 'ready', data: res.data } : { status: 'error', message: res.message });
  }, [unitUuid]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div id={id} className="flex flex-col gap-2 py-1 text-sm">
      {state.status === 'loading' && (
        <p role="status" className="text-[var(--muted)]">
          Indlæser medlemmer …
        </p>
      )}
      {state.status === 'error' && <ErrorBanner message={state.message} onRetry={() => void load()} />}
      {state.status === 'ready' &&
        (state.data.members.length === 0 ? (
          <p className="text-[var(--muted)]">Ingen medlemmer</p>
        ) : (
          <>
            <ul aria-label={`Medlemmer af ${unitName}`} className="flex flex-col gap-1">
              {state.data.members.map((m) => (
                <li key={m.directoryUserUuid} className="flex flex-wrap items-baseline gap-x-3">
                  <span className="text-[var(--ink)]">{m.name}</span>
                  {m.email && <span className="font-mono text-[12px] text-[var(--muted)]">{m.email}</span>}
                </li>
              ))}
            </ul>
            {state.data.truncated === true && (
              <p role="note" className="text-[13px] text-[var(--muted)]">
                Viser de første {state.data.members.length} medlemmer. Listen er afkortet.
              </p>
            )}
          </>
        ))}
    </div>
  );
}
