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
import type { ShareConfig } from '@/lib/skabeloner/share-config';
import type { Skabelon } from '@/types';

interface SkabelonEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // The Skabelon being edited, or null to create a new one.
  skabelon: Skabelon | null;
  onSaved: (skabelon: Skabelon) => void;
  // Which sharing methods are enabled — gates the paste-to-import affordance.
  shareConfig?: ShareConfig;
}

const CATEGORIES = [
  ['includeDeltagere', 'Deltagere'],
  ['includeBeslutningspunkter', 'Beslutningspunkter'],
  ['includeDagsorden', 'Dagsorden'],
  ['includeDato', 'Dato'],
] as const;

type CategoryKey = (typeof CATEGORIES)[number][0];

const NOTE_MAX = 2000;

// The names the API reports for a changed field, in the words of the form.
const FIELD_LABELS: Record<string, string> = {
  name: 'navn',
  description: 'beskrivelse',
  prompt: 'prompt',
  includeDeltagere: 'deltagere',
  includeBeslutningspunkter: 'beslutningspunkter',
  includeDagsorden: 'dagsorden',
  includeDato: 'dato',
};

interface HistoryEntry {
  version: number;
  changeNote: string | null;
  changedFields: string[];
  createdAt: string;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString('da-DK', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function SkabelonEditor({
  open,
  onOpenChange,
  skabelon,
  onSaved,
  shareConfig = { code: true, link: false },
}: SkabelonEditorProps) {
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
  // Optional note about THIS edit; kept only in the person's own changelog.
  const [changeNote, setChangeNote] = useState('');
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

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
    setChangeNote('');
    setHistory(null);
    setHistoryOpen(false);
    setHistoryError(null);
  }, [open, skabelon]);

  // The person's own changelog is only fetched when they ask for it.
  async function toggleHistory() {
    const next = !historyOpen;
    setHistoryOpen(next);
    if (!next || history !== null || !skabelon) return;
    setHistoryError(null);
    try {
      const res = await fetch(`/api/skabeloner/${skabelon.id}/history`);
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { versions?: HistoryEntry[] };
      setHistory(data.versions ?? []);
    } catch {
      setHistoryError('Kunne ikke hente historikken');
    }
  }

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

  // Accept whichever sharing methods the admin enabled: a self-contained code
  // and/or a server import link.
  async function handleImport() {
    const raw = pasteValue.trim();
    if (!raw) return;
    setPasteError(null);

    if (shareConfig.code) {
      const decoded = decodeSkabelonCode(raw);
      if (decoded) {
        applyShareable(decoded);
        return;
      }
    }

    if (shareConfig.link) {
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
    }

    setPasteError(
      shareConfig.code && shareConfig.link
        ? 'Ugyldig kode eller link'
        : shareConfig.link
          ? 'Ugyldigt link'
          : 'Ugyldig kode',
    );
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
        body: JSON.stringify({
          name: name.trim(),
          description,
          prompt,
          ...cats,
          ...(skabelon && changeNote.trim() ? { changeNote } : {}),
        }),
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

  // The paste affordance adapts to whichever sharing methods are enabled.
  const pasteEnabled = shareConfig.code || shareConfig.link;
  const what =
    shareConfig.code && shareConfig.link
      ? { label: 'Har du en kode eller et link?', placeholder: 'Indsæt kode eller link…', help: 'Indsæt en delt skabelonkode eller et link for at udfylde felterne automatisk.' }
      : shareConfig.link
        ? { label: 'Har du et link?', placeholder: 'Indsæt link…', help: 'Indsæt et delingslink for at udfylde felterne automatisk.' }
        : { label: 'Har du en kode?', placeholder: 'Indsæt kode…', help: 'Indsæt en delt skabelonkode for at udfylde felterne automatisk.' };

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
          {!skabelon && pasteEnabled && (
            <div className="rounded-[var(--radius)] border border-dashed border-[var(--line)] px-3 py-2.5 space-y-2">
              <div>
                <Label htmlFor="sk-paste">{what.label}</Label>
                <p className="text-xs text-[var(--muted)] mt-0.5">
                  {what.help}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  id="sk-paste"
                  value={pasteValue}
                  onChange={(e) => {
                    setPasteValue(e.target.value);
                    setPasteError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleImport();
                    }
                  }}
                  placeholder={what.placeholder}
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

          {skabelon && (
            <div className="space-y-1.5">
              <Label htmlFor="sk-note">Hvad ændrede du? (valgfri)</Label>
              <Textarea
                id="sk-note"
                value={changeNote}
                onChange={(e) => setChangeNote(e.target.value)}
                maxLength={NOTE_MAX}
                rows={2}
                placeholder="En note til dig selv om denne ændring"
              />
              <p className="text-xs text-[var(--muted)]">
                Noten gemmes kun i din egen historik og er ikke synlig for andre.
              </p>
            </div>
          )}

          {skabelon && (
            <div className="space-y-1.5">
              <button
                type="button"
                onClick={toggleHistory}
                aria-expanded={historyOpen}
                className="text-sm text-[var(--accent)] hover:underline"
              >
                {historyOpen ? 'Skjul historik' : 'Vis historik'}
              </button>
              {historyOpen && historyError && <p className="text-sm text-[var(--kill)]">{historyError}</p>}
              {historyOpen && history && history.length === 0 && (
                <p className="text-sm text-[var(--muted)]">Ingen ændringer endnu.</p>
              )}
              {historyOpen && history && history.length > 0 && (
                <ul className="max-h-40 overflow-y-auto space-y-1.5 text-sm" aria-label="Historik">
                  {history.map((h) => (
                    <li key={h.version} className="rounded-[var(--radius)] border border-[var(--line)] px-2.5 py-1.5">
                      <div className="text-xs text-[var(--muted)]">
                        Version {h.version} · {formatWhen(h.createdAt)}
                        {h.changedFields.length > 0
                          ? ` · ændret: ${h.changedFields.map((f) => FIELD_LABELS[f] ?? f).join(', ')}`
                          : ' · oprettet'}
                      </div>
                      {h.changeNote && <p className="whitespace-pre-wrap">{h.changeNote}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

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
