'use client';

import { useCallback, useEffect, useState } from 'react';
import { isMeResponse, type MeResponse } from '@/lib/authz/me';

export interface UseMeResult {
  data: MeResponse | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Who am I and what may I do, from GET /api/me. Advisory: it drives what the
 * UI shows, never what the server allows. `data` stays null while loading and
 * on any failure, so callers that gate on it never flash privileged UI.
 */
export function useMe(): UseMeResult {
  const [data, setData] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch('/api/me')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body: unknown = await res.json();
        if (!isMeResponse(body)) throw new Error('invalid body');
        return body;
      })
      .then((body) => {
        if (!cancelled) setData(body);
      })
      .catch(() => {
        if (cancelled) return;
        setData(null);
        setError('Kunne ikke hente dine rettigheder.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  return { data, loading, error, reload };
}
