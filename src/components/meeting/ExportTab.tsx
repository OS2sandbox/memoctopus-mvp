'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useIsMobile } from '@/lib/use-is-mobile';

type ExportFormat = 'pdf' | 'md';

const FORMATS: { key: ExportFormat; label: string; description: string; file: string; meta: string }[] = [
  { key: 'pdf', label: 'PDF', description: 'Til arkivering og distribution. Kan ikke redigeres.', file: 'referat.pdf', meta: '2 sider · A4' },
  { key: 'md', label: 'Markdown', description: 'Ren tekst — egnet til Notion, Obsidian og andre.', file: 'referat.md', meta: '~3 KB · UTF-8' },
];

export function ExportTab({ meetingId }: { meetingId: string }) {
  const isMobile = useIsMobile();
  const [selected, setSelected] = useState<ExportFormat>('pdf');
  const [exporting, setExporting] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fmt = FORMATS.find((f) => f.key === selected)!;

  async function handleExport() {
    setExporting(true);
    setError(null);
    try {
      const res = await fetch(`/api/export/${meetingId}?format=${selected}`);
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error ?? 'Eksport fejlede');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fmt.file;
      a.click();
      URL.revokeObjectURL(url);
      setDownloaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Noget gik galt');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div style={{ minHeight: 'calc(100vh - 56px - 47px)', padding: isMobile ? '40px 20px' : '64px 32px' }}>
      <div style={{ maxWidth: 780, margin: '0 auto' }}>

        {/* Header */}
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', letterSpacing: 0.4 }}>04 · eksport</div>
        <h1 style={{ fontWeight: 300, fontSize: isMobile ? 32 : 42, lineHeight: 1.04, letterSpacing: '-0.025em', margin: '8px 0 0' }}>
          Klar til <em style={{ fontStyle: 'italic' }}>aflevering</em>.
        </h1>

        {/* Error */}
        {error && (
          <div style={{
            marginTop: 20, padding: '12px 16px', borderRadius: 'var(--radius)',
            background: 'var(--kill-wash)', borderLeft: '3px solid var(--kill)',
            fontSize: 13.5, color: 'var(--kill)',
          }}>
            {error}
          </div>
        )}

        {/* Format choice */}
        <div style={{ marginTop: 40 }} role="radiogroup" aria-label="Eksportformat">
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', letterSpacing: 0.4, marginBottom: 12 }}>format</div>
          {FORMATS.map((f) => {
            const sel = f.key === selected;
            return (
              <button
                key={f.key}
                type="button"
                role="radio"
                aria-checked={sel}
                onClick={() => setSelected(f.key)}
                style={{
                  width: '100%', textAlign: 'left', font: 'inherit', color: 'inherit',
                  padding: '18px 20px',
                  display: 'grid', gridTemplateColumns: '20px 1fr auto',
                  gap: 16, alignItems: 'center',
                  border: '1px solid ' + (sel ? 'var(--accent)' : 'var(--line-2)'),
                  background: sel ? 'var(--accent-wash)' : 'transparent',
                  borderRadius: 'var(--radius)',
                  marginBottom: 10, cursor: 'pointer',
                  transition: 'background 120ms, border-color 120ms',
                }}
              >
                <span style={{
                  width: 16, height: 16, borderRadius: 999,
                  border: '1px solid ' + (sel ? 'var(--accent)' : 'var(--line-2)'),
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                  {sel && <span style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--accent)', display: 'block' }} />}
                </span>
                <div>
                  <div style={{ fontSize: 16, color: 'var(--ink)', fontWeight: 500 }}>{f.label}</div>
                  <div style={{ fontSize: 13, color: 'var(--ink-2)', marginTop: 3 }}>{f.description}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)' }}>{f.file}</div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--muted-2)', marginTop: 3 }}>{f.meta}</div>
                </div>
              </button>
            );
          })}
        </div>

        {/* Bottom row */}
        <div style={{ marginTop: 24, display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
            lydfil slettet ved generering<br />
            <span style={{ color: 'var(--muted-2)' }}>transskription bevares i arkivet</span>
          </div>
          <button
            onClick={handleExport}
            disabled={exporting}
            style={{
              marginLeft: 'auto', padding: '12px 22px',
              background: 'var(--accent)', color: '#fff',
              border: '1px solid var(--accent)',
              borderRadius: 'var(--radius)', cursor: exporting ? 'not-allowed' : 'pointer',
              fontFamily: 'var(--mono)', fontSize: 13.5, fontWeight: 500,
              opacity: exporting ? 0.7 : 1,
            }}
          >
            {exporting ? 'genererer…' : `download ${fmt.file}`}
          </button>
        </div>

        {/* Compliance note */}
        <div style={{
          marginTop: 32, paddingTop: 20, borderTop: '1px solid var(--line)',
          fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted)',
          display: 'flex', justifyContent: 'space-between',
          flexWrap: 'wrap', gap: 12,
        }}>
          <span>indeholder ingen rå tale, lyd eller personoplysninger</span>
          <Link
            href={`/meeting/${meetingId}/review`}
            style={{
              color: 'var(--ink-2)', textDecoration: 'underline',
              textDecorationColor: 'var(--line-2)', textUnderlineOffset: 3,
            }}
          >
            ↶ tilbage til referat
          </Link>
        </div>

        {/* Post-download confirmation */}
        {downloaded && (
          <div style={{
            marginTop: 32, padding: '20px 24px',
            border: '1px dashed var(--line-2)', borderRadius: 'var(--radius)',
            background: 'var(--bg-2)',
            display: 'flex', alignItems: 'center', gap: 16,
          }}>
            <span style={{
              width: 28, height: 28, borderRadius: 999, background: 'var(--keep)',
              color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 14, fontWeight: 600, flexShrink: 0,
            }}>✓</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14.5, color: 'var(--ink)' }}>
                {fmt.file} downloadet
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>
                referatet ligger i arkivet
              </div>
            </div>
            <Link
              href="/"
              style={{
                fontFamily: 'var(--mono)', fontSize: 13.5, fontWeight: 500,
                padding: '8px 14px', borderRadius: 'var(--radius)',
                border: '1px solid var(--line-2)', background: 'transparent',
                color: 'var(--ink)', textDecoration: 'none',
              }}
            >
              nyt møde →
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
