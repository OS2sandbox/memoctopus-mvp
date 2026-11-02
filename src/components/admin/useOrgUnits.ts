'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from './api';

export interface OrgUnit {
  uuid: string;
  name: string;
  parentUuid: string | null;
  source: string;
  memberCount: number;
}

export interface OrgUnitsState {
  units: OrgUnit[];
  /** True while a request is in flight (also on every reload). */
  loading: boolean;
  /** True once the first request has finished, whatever its outcome. */
  loaded: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/** The org-unit tree from GET /api/admin/access/org-units; one read serves the whole users page. */
export function useOrgUnits(): OrgUnitsState {
  const [units, setUnits] = useState<OrgUnit[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only the newest request may write state, so a slow old response cannot overwrite a newer reload.
  const requestSeq = useRef(0);

  const reload = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    const res = await apiRequest<{ orgUnits: OrgUnit[] }>('/api/admin/access/org-units');
    if (seq !== requestSeq.current) return;
    if (res.ok) setUnits(res.data.orgUnits);
    else setError(res.message);
    setLoading(false);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { units, loading, loaded, error, reload };
}
