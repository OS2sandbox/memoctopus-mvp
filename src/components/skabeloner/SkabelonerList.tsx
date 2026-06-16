'use client';

import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { SkabelonEditor } from './SkabelonEditor';
import { encodeSkabelonCode } from '@/lib/skabeloner/share-code';
import type { Skabelon } from '@/types';

const CATEGORY_LABELS: [keyof Skabelon, string][] = [
  ['includeDeltagere', 'Deltagere'],
  ['includeBeslutningspunkter', 'Beslutningspunkter'],
  ['includeDagsorden', 'Dagsorden'],
  ['includeDato', 'Dato'],
];

export function SkabelonerList() {
  const [skabeloner, setSkabeloner] = useState<Skabelon[]>([]);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Skabelon | null>(null);
  const [shareCode, setShareCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch('/api/skabeloner')
      .then((r) => (r.ok ? r.json() : { skabeloner: [] }))
      .then((data: { skabeloner: Skabelon[] }) => setSkabeloner(data.skabeloner ?? []))
      .finally(() => setLoading(false));
  }, []);

  function handleSaved(saved: Skabelon) {
    setSkabeloner((prev) => {
      const exists = prev.some((s) => s.id === saved.id);
      return exists ? prev.map((s) => (s.id === saved.id ? saved : s)) : [saved, ...prev];
    });
  }

  function openNew() {
    setEditing(null);
    setEditorOpen(true);
  }

  function openEdit(s: Skabelon) {
    setEditing(s);
    setEditorOpen(true);
  }

  async function handleDelete(s: Skabelon) {
    if (!window.confirm(`Slet skabelonen "${s.name}"?`)) return;
    const res = await fetch(`/api/skabeloner/${s.id}`, { method: 'DELETE' });
    if (res.ok) setSkabeloner((prev) => prev.filter((x) => x.id !== s.id));
  }

  async function handleSetDefault(s: Skabelon) {
    if (s.isDefault) return;
    const res = await fetch(`/api/skabeloner/${s.id}/default`, { method: 'POST' });
    if (!res.ok) return;
    // One default per user — mirror that locally so only the chosen card fills.
    setSkabeloner((prev) => prev.map((x) => ({ ...x, isDefault: x.id === s.id })));
  }

  async function handleShare(s: Skabelon) {
    // The whole template travels inside the code, so no server round-trip is
    // needed — and the recipient pastes it under "Ny skabelon".
    const code = encodeSkabelonCode(s);
    setShareCode(code);
    setCopied(false);
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      /* clipboard may be unavailable; the code is still selectable */
    }
  }

  async function copyCode() {
    if (!shareCode) return;
    try {
      await navigator.clipboard.writeText(shareCode);
      setCopied(true);
    } catch {
      /* clipboard may be unavailable; the code is still selectable */
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <p className="text-sm text-[var(--muted)]">
          Skabeloner er genbrugelige prompts til at generere referater. Tryk Del for at kopiere en skabelon som kode, andre kan indsætte under Ny skabelon.
        </p>
        <Button size="sm" onClick={openNew}>
          + Ny skabelon
        </Button>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {[...Array(2)].map((_, i) => (
            <div key={i} className="h-40 bg-[var(--fill)] rounded-[var(--radius-lg)] animate-pulse" />
          ))}
        </div>
      ) : skabeloner.length === 0 ? (
        <div className="rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--surface)] px-8 py-12 text-center">
          <p className="text-sm text-[var(--muted)]">Ingen skabeloner endnu.</p>
          <Button size="sm" className="mt-4" onClick={openNew}>+ Opret din første skabelon</Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {skabeloner.map((s) => {
            const activeCats = CATEGORY_LABELS.filter(([key]) => s[key]);
            return (
              <div
                key={s.id}
                className="rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--surface)] p-5 flex flex-col"
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <h2 className="font-semibold text-[var(--ink)]">{s.name}</h2>
                  <div className="flex items-center gap-2 shrink-0">
                    {s.isDefault && (
                      <span className="text-xs whitespace-nowrap" style={{ color: 'var(--accent)' }}>
                        Skabelon valgt som standard
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => handleSetDefault(s)}
                      title={s.isDefault ? 'Standardskabelon' : 'Gør til standard'}
                      aria-pressed={s.isDefault}
                      aria-label={s.isDefault ? 'Standardskabelon' : 'Gør til standard'}
                      className="p-1 rounded-full transition-colors"
                      style={{
                        background: 'none', border: 'none', lineHeight: 0,
                        cursor: s.isDefault ? 'default' : 'pointer',
                        color: s.isDefault ? 'var(--accent)' : 'var(--muted)',
                      }}
                    >
                      <svg
                        width="20" height="20" viewBox="0 0 24 24"
                        fill={s.isDefault ? 'currentColor' : 'none'}
                        stroke={s.isDefault ? 'none' : 'currentColor'}
                        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                        shapeRendering="geometricPrecision"
                        style={{ display: 'block' }}
                      >
                        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                      </svg>
                    </button>
                  </div>
                </div>
                <p className="text-sm text-[var(--muted)] mb-4">{s.description || 'Ingen beskrivelse'}</p>

                {activeCats.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-4">
                    {activeCats.map(([key, label]) => (
                      <span
                        key={key as string}
                        className="text-xs px-2 py-0.5 rounded-full border border-[var(--line)] text-[var(--muted)]"
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                )}

                <div className="mt-auto flex items-center gap-1 pt-2">
                  <Button variant="ghost" size="sm" onClick={() => openEdit(s)}>Rediger</Button>
                  <Button variant="ghost" size="sm" onClick={() => handleShare(s)}>Del</Button>
                  <Button variant="ghost" size="sm" onClick={() => handleDelete(s)}>Slet</Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <SkabelonEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        skabelon={editing}
        onSaved={handleSaved}
      />

      <Dialog open={shareCode !== null} onOpenChange={(o) => !o && setShareCode(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Del skabelon</DialogTitle>
            <DialogDescription>
              {copied
                ? 'Koden er kopieret til udklipsholderen. Send den til andre — de indsætter den under "Ny skabelon".'
                : 'Kopiér denne kode og send den til andre. De indsætter den under "Ny skabelon".'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 mt-2">
            <Textarea
              readOnly
              value={shareCode ?? ''}
              rows={4}
              className="font-mono text-xs"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button size="sm" onClick={copyCode}>{copied ? 'Kopieret' : 'Kopiér kode'}</Button>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShareCode(null)}>Luk</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
