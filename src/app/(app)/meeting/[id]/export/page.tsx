'use client';

import React, { useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ProcessStrip } from '@/components/layout/ProcessStrip';

type ExportFormat = 'pdf' | 'docx' | 'md';

const FORMATS: { key: ExportFormat; label: string; description: string; ext: string }[] = [
  { key: 'pdf', label: 'PDF', description: 'Til arkivering og distribution. Kan ikke redigeres.', ext: 'pdf' },
  { key: 'docx', label: 'Word', description: 'Redigerbart .docx til videre bearbejdning.', ext: 'docx' },
  { key: 'md', label: 'Markdown', description: 'Ren tekst — egnet til Notion, Obsidian og andre.', ext: 'md' },
];

export default function ExportPage() {
  const params = useParams();
  const id = params.id as string;
  const [selected, setSelected] = useState<ExportFormat>('pdf');
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fmt = FORMATS.find((f) => f.key === selected)!;
  const filename = `referat.${fmt.ext}`;

  async function handleExport() {
    setExporting(true);
    setError(null);
    try {
      const res = await fetch(`/api/export/${id}?format=${selected}`);
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error ?? 'Eksport fejlede');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Noget gik galt');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div>
      <ProcessStrip meetingId={id} activePhase="export" completedPhases={['recording', 'review', 'minutes']} />
      <div className="mx-auto max-w-[720px] px-6 py-12">
        <h1
          style={{ fontSize: 'var(--t-h1)', fontWeight: 300, color: 'var(--ink)', margin: '0 0 8px' }}
        >
          Eksportér referat
        </h1>
        <p className="text-[var(--muted)] mb-10" style={{ fontSize: 'var(--t-small)' }}>
          Vælg format og download.
        </p>

        {error && (
          <div
            className="mb-6 rounded-[var(--radius)] border px-4 py-3 text-sm text-[var(--danger)]"
            style={{ backgroundColor: 'var(--danger-wash)', borderColor: 'var(--danger)' }}
          >
            {error}
          </div>
        )}

        {/* Format list */}
        <div className="border border-[var(--line)] rounded-[var(--radius)] overflow-hidden divide-y divide-[var(--line)] mb-8">
          {FORMATS.map((f) => {
            const isSelected = selected === f.key;
            return (
              <label
                key={f.key}
                className="flex items-center gap-4 px-5 py-4 cursor-pointer transition-colors"
                style={{ backgroundColor: isSelected ? 'var(--accent-wash)' : 'var(--surface)' }}
              >
                <input
                  type="radio"
                  name="format"
                  value={f.key}
                  checked={isSelected}
                  onChange={() => setSelected(f.key)}
                  className="accent-[var(--accent)] shrink-0"
                  style={{ accentColor: 'var(--accent)', width: 16, height: 16 }}
                />
                <div className="flex-1">
                  <span
                    className="font-medium text-[var(--ink)]"
                    style={{ fontSize: 'var(--t-body)' }}
                  >
                    {f.label}
                  </span>
                  <span className="ml-3 text-[var(--muted)]" style={{ fontSize: 'var(--t-small)' }}>
                    {f.description}
                  </span>
                </div>
                <span
                  className="text-[var(--muted-2)] shrink-0"
                  style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--t-micro)' }}
                >
                  {`referat.${f.ext}`}
                </span>
              </label>
            );
          })}
        </div>

        {/* Action row */}
        <div className="flex items-center gap-6">
          <div className="text-[var(--muted)]" style={{ fontSize: 'var(--t-small)' }}>
            <p>Indeholder ingen rå tale, lyd eller PII.</p>
            <Link
              href={`/meeting/${id}/settings`}
              className="text-[var(--accent)] hover:underline"
            >
              Slet kilder nu →
            </Link>
          </div>
          <Button
            onClick={handleExport}
            disabled={exporting}
            className="shrink-0"
          >
            {exporting ? 'Genererer…' : `Download ${filename}`}
          </Button>
        </div>
      </div>
    </div>
  );
}
