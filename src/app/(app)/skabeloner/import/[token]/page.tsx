'use client';

import React, { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

interface SharedPreview {
  name: string;
  description: string;
  prompt: string;
  includeDeltagere: boolean;
  includeBeslutningspunkter: boolean;
  includeDagsorden: boolean;
}

const CATEGORY_LABELS: [keyof SharedPreview, string][] = [
  ['includeDeltagere', 'Deltagere'],
  ['includeBeslutningspunkter', 'Beslutningspunkter'],
  ['includeDagsorden', 'Dagsorden'],
];

export default function ImportSkabelonPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const token = params.token;

  const [preview, setPreview] = useState<SharedPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/skabeloner/import/${token}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? 'Delingslink er ugyldigt');
        return r.json();
      })
      .then((data: { skabelon: SharedPreview }) => setPreview(data.skabelon))
      .catch((err) => setError(err instanceof Error ? err.message : 'Noget gik galt'))
      .finally(() => setLoading(false));
  }, [token]);

  async function handleImport() {
    setImporting(true);
    setError(null);
    try {
      const res = await fetch(`/api/skabeloner/import/${token}`, { method: 'POST' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Import fejlede');
      router.push('/arkiv?tab=skabeloner');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Noget gik galt');
      setImporting(false);
    }
  }

  return (
    <div className="mx-auto max-w-[640px] px-6 py-12">
      <h1 style={{ fontSize: 'var(--t-h1)', fontWeight: 300, color: 'var(--ink)', margin: 0 }}>
        Importér skabelon
      </h1>

      {loading ? (
        <div className="h-40 mt-8 bg-[var(--fill)] rounded-[var(--radius-lg)] animate-pulse" />
      ) : error && !preview ? (
        <p className="mt-6 text-sm text-[var(--kill)]">{error}</p>
      ) : preview ? (
        <>
          <div className="mt-8 rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--surface)] p-6">
            <h2 className="font-semibold text-[var(--ink)]">{preview.name}</h2>
            {preview.description && (
              <p className="text-sm text-[var(--muted)] mt-1">{preview.description}</p>
            )}
            {preview.prompt && (
              <p className="text-sm text-[var(--ink-2)] mt-4 whitespace-pre-wrap">{preview.prompt}</p>
            )}
            {CATEGORY_LABELS.some(([k]) => preview[k]) && (
              <div className="flex flex-wrap gap-1.5 mt-4">
                {CATEGORY_LABELS.filter(([k]) => preview[k]).map(([k, label]) => (
                  <span
                    key={k as string}
                    className="text-xs px-2 py-0.5 rounded-full border border-[var(--line)] text-[var(--muted)]"
                  >
                    {label}
                  </span>
                ))}
              </div>
            )}
          </div>

          {error && <p className="mt-4 text-sm text-[var(--kill)]">{error}</p>}

          <div className="mt-6 flex items-center gap-3">
            <Button onClick={handleImport} disabled={importing}>
              {importing ? 'Importerer…' : 'Importér til mine skabeloner'}
            </Button>
            <Button variant="ghost" onClick={() => router.push('/arkiv?tab=skabeloner')}>
              Annullér
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
