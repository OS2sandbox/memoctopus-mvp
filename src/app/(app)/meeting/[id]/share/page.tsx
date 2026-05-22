'use client';

import React, { useState } from 'react';
import { useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';

type ExportFormat = 'pdf' | 'docx';

export default function SharePage() {
  const params = useParams();
  const id = params.id as string;
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function exportAs(format: ExportFormat) {
    setExporting(format);
    setError(null);
    try {
      const res = await fetch(`/api/export/${id}?format=${format}`);
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error ?? 'Eksport fejlede');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `referat.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Noget gik galt');
    } finally {
      setExporting(null);
    }
  }

  return (
    <div className="mx-auto max-w-[720px] px-4 py-8">
      <h1 className="text-xl font-semibold text-[var(--text)] mb-2">Eksportér referat</h1>
      <p className="text-sm text-[var(--text-muted)] mb-8">
        Download referatet som PDF eller Word-dokument.
      </p>

      {error && (
        <div className="mb-6 rounded-[var(--radius)] border border-red-200 bg-red-50 px-4 py-3 text-sm text-[var(--danger)]">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {/* PDF */}
        <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-6">
          <div className="mb-4">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius)] bg-red-50 text-[var(--danger)] text-lg font-bold">
              PDF
            </span>
          </div>
          <h2 className="font-semibold text-[var(--text)] mb-1">PDF-dokument</h2>
          <p className="text-sm text-[var(--text-muted)] mb-4">
            Egnet til arkivering og distribution. Kan ikke redigeres.
          </p>
          <Button
            onClick={() => exportAs('pdf')}
            disabled={exporting !== null}
            variant="secondary"
            className="w-full"
          >
            {exporting === 'pdf' ? 'Genererer PDF...' : 'Download PDF'}
          </Button>
        </div>

        {/* DOCX */}
        <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-6">
          <div className="mb-4">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius)] bg-blue-50 text-[var(--accent)] text-lg font-bold">
              DOC
            </span>
          </div>
          <h2 className="font-semibold text-[var(--text)] mb-1">Word-dokument</h2>
          <p className="text-sm text-[var(--text-muted)] mb-4">
            Redigerbart .docx-format til videre bearbejdning i Word.
          </p>
          <Button
            onClick={() => exportAs('docx')}
            disabled={exporting !== null}
            variant="secondary"
            className="w-full"
          >
            {exporting === 'docx' ? 'Genererer DOCX...' : 'Download DOCX'}
          </Button>
        </div>
      </div>

      <div className="mt-8 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 text-sm text-[var(--text-muted)]">
        <strong className="font-medium text-[var(--text-2)]">Bemærk:</strong> Det eksporterede
        dokument indeholder den anonymiserede version af referatet. Personoplysninger er fjernet
        i overensstemmelse med GDPR.
      </div>
    </div>
  );
}
