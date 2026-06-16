'use client';

import React, { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  decodeSkabelonCode,
  extractImportToken,
  type ShareableSkabelon,
} from '@/lib/skabeloner/share-code';
import type { Skabelon } from '@/types';

interface SkabelonEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // The Skabelon being edited, or null to create a new one.
  skabelon: Skabelon | null;
  onSaved: (skabelon: Skabelon) => void;
}

const CATEGORIES = [
  ['includeDeltagere', 'Deltagere'],
  ['includeBeslutningspunkter', 'Beslutningspunkter'],
  ['includeDagsorden', 'Dagsorden'],
  ['includeDato', 'Dato'],
] as const;

type CategoryKey = (typeof CATEGORIES)[number][0];

export function SkabelonEditor({ open, onOpenChange, skabelon, onSaved }: SkabelonEditorProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [cats, setCats] = useState<Record<CategoryKey, boolean>>({
    includeDeltagere: false,
    includeBeslutningspunkter: false,
    includeDagsorden: false,
    includeDato: false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pasteValue, setPasteValue] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [pasteApplied, setPasteApplied] = useState(false);

  // Reset the form whenever the dialog opens (for a new skabelon or an edit).
  useEffect(() => {
    if (!open) return;
    setName(skabelon?.name ?? '');
    setDescription(skabelon?.description ?? '');
    setPrompt(skabelon?.prompt ?? '');
    setCats({
      includeDeltagere: skabelon?.includeDeltagere ?? false,
      includeBeslutningspunkter: skabelon?.includeBeslutningspunkter ?? false,
      includeDagsorden: skabelon?.includeDagsorden ?? false,
      includeDato: skabelon?.includeDato ?? false,
    });
    setError(null);
    setPasteValue('');
    setPasteError(null);
    setPasteApplied(false);
  }, [open, skabelon]);

  function applyShareable(s: ShareableSkabelon) {
    setName(s.name);
    setDescription(s.description);
    setPrompt(s.prompt);
    setCats({
      includeDeltagere: s.includeDeltagere,
      includeBeslutningspunkter: s.includeBeslutningspunkter,
      includeDagsorden: s.includeDagsorden,
      includeDato: s.includeDato,
    });
    setPasteValue('');
    setPasteError(null);
    setPasteApplied(true);
  }

  // Accept either a self-contained code or an old-style import link.
  async function handleImport() {
    const raw = pasteValue.trim();
    if (!raw) return;
    setPasteError(null);

    const decoded = decodeSkabelonCode(raw);
    if (decoded) {
      applyShareable(decoded);
      return;
    }

    const token = extractImportToken(raw);
    if (token) {
      setPasting(true);
      try {
        const res = await fetch(`/api/skabeloner/import/${token}`);
        if (!res.ok) throw new Error();
        const data = (await res.json()) as { skabelon: ShareableSkabelon };
        applyShareable(data.skabelon);
      } catch {
        setPasteError('Kunne ikke hente skabelon fra linket');
      } finally {
        setPasting(false);
      }
      return;
    }

    setPasteError('Ugyldig kode eller link');
  }

  async function handleSave() {
    if (!name.trim()) {
      setError('Navn er påkrævet');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const url = skabelon ? `/api/skabeloner/${skabelon.id}` : '/api/skabeloner';
      const method = skabelon ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description, prompt, ...cats }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? 'Kunne ikke gemme skabelon');
      }
      const data = (await res.json()) as { skabelon: Skabelon };
      onSaved(data.skabelon);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Noget gik galt');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{skabelon ? 'Rediger skabelon' : 'Ny skabelon'}</DialogTitle>
          <DialogDescription>
            En skabelon er en genbrugelig prompt til at generere referater.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          {!skabelon && (
            <div className="rounded-[var(--radius-lg)] border border-dashed border-[var(--line)] p-3 space-y-2">
              <Label htmlFor="sk-paste">Har du en kode eller et link?</Label>
              <p className="text-xs text-[var(--muted)]">
                Indsæt en delt skabelonkode eller et link for at udfylde felterne automatisk.
              </p>
              <div className="flex items-start gap-2">
                <Textarea
                  id="sk-paste"
                  value={pasteValue}
                  onChange={(e) => {
                    setPasteValue(e.target.value);
                    setPasteError(null);
                  }}
                  placeholder="Indsæt kode eller link…"
                  rows={2}
                  className="font-mono text-xs"
                />
                <Button
                  type="button"
                  size="sm"
                  onClick={handleImport}
                  disabled={pasting || !pasteValue.trim()}
                >
                  {pasting ? 'Henter…' : 'Indsæt'}
                </Button>
              </div>
              {pasteError && <p className="text-sm text-[var(--kill)]">{pasteError}</p>}
              {pasteApplied && !pasteError && (
                <p className="text-sm" style={{ color: 'var(--accent)' }}>
                  Skabelon indlæst — gennemse og gem.
                </p>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="sk-name">Navn</Label>
            <Input id="sk-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="F.eks. Bestyrelsesmøde" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sk-desc">Beskrivelse</Label>
            <Input id="sk-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Kort beskrivelse" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sk-prompt">Prompt</Label>
            <Textarea
              id="sk-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Instruktion til hvordan referatet skal skrives…"
              rows={5}
            />
          </div>

          <div className="space-y-2">
            <Label>Kategorier (valgfri)</Label>
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map(([key, label]) => {
                const active = cats[key];
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setCats((prev) => ({ ...prev, [key]: !prev[key] }))}
                    style={{
                      padding: '4px 12px',
                      border: '1px solid ' + (active ? 'var(--accent)' : 'var(--line)'),
                      borderRadius: 999,
                      background: active ? 'var(--accent-wash)' : 'transparent',
                      fontSize: 12.5,
                      color: active ? 'var(--accent)' : 'var(--ink-2)',
                      cursor: 'pointer',
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {error && <p className="text-sm text-[var(--kill)]">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Annullér
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Gemmer…' : 'Gem'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
