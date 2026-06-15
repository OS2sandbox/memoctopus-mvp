'use client';

import React, { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { SkabelonEditor } from './SkabelonEditor';
import type { Skabelon } from '@/types';

const CATEGORY_LABELS: [keyof Skabelon, string][] = [
  ['includeDeltagere', 'Deltagere'],
  ['includeBeslutningspunkter', 'Beslutningspunkter'],
  ['includeDagsorden', 'Dagsorden'],
];

export function SkabelonerList() {
  const [skabeloner, setSkabeloner] = useState<Skabelon[]>([]);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Skabelon | null>(null);
  const [shareLink, setShareLink] = useState<string | null>(null);
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

  async function handleShare(s: Skabelon) {
    const res = await fetch(`/api/skabeloner/${s.id}/share`, { method: 'POST' });
    if (!res.ok) return;
    const { token } = (await res.json()) as { token: string };
    setCopied(false);
    setShareLink(`${window.location.origin}/skabeloner/import/${token}`);
  }

  async function copyLink() {
    if (!shareLink) return;
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
    } catch {
      /* clipboard may be unavailable; the link is still selectable */
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <p className="text-sm text-[var(--muted)]">
          Skabeloner er genbrugelige prompts til at generere referater. Del dem med andre via et link.
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
                  {s.isDefault && <Badge variant="default">Standard</Badge>}
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

      <Dialog open={shareLink !== null} onOpenChange={(o) => !o && setShareLink(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Del skabelon</DialogTitle>
            <DialogDescription>
              Send dette link til andre. De kan importere skabelonen til deres egen liste.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 mt-2">
            <Input readOnly value={shareLink ?? ''} onFocus={(e) => e.currentTarget.select()} />
            <Button size="sm" onClick={copyLink}>{copied ? 'Kopieret' : 'Kopiér'}</Button>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShareLink(null)}>Luk</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
