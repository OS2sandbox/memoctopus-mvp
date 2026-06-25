'use client';

import React, { useEffect, useRef, useState } from 'react';
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
import { Textarea } from '@/components/ui/textarea';
import { ErrorBanner } from '@/components/ui/error-banner';
import { SkabelonEditor } from './SkabelonEditor';
import { encodeSkabelonCode } from '@/lib/skabeloner/share-code';
import type { ShareConfig } from '@/lib/skabeloner/share-config';
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
  // Default to the out-of-box config (code on, link off) so the share affordance
  // renders correctly before the server config arrives; corrected on fetch.
  const [shareConfig, setShareConfig] = useState<ShareConfig>({ code: true, link: false });
  const [shareTarget, setShareTarget] = useState<Skabelon | null>(null);
  const [shareCode, setShareCode] = useState<string | null>(null);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [linkLoading, setLinkLoading] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  // The skabelon whose code/link was just copied inline (single-method sharing),
  // and the brief confirmation to show above its buttons.
  const [copiedToast, setCopiedToast] = useState<{ id: string; text: string } | null>(null);
  const copiedToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  function loadSkabeloner() {
    setLoadError(null);
    setLoading(true);
    fetch('/api/skabeloner')
      .then((r) => {
        if (!r.ok) {
          console.error('[skabeloner] Kunne ikke hente skabeloner — HTTP', r.status);
          throw new Error(`HTTP ${r.status}`);
        }
        return r.json();
      })
      .then((data: { skabeloner: Skabelon[] }) => setSkabeloner(data.skabeloner ?? []))
      .catch((err) => {
        console.error('[skabeloner] Fejl ved indlæsning af skabeloner:', err);
        setLoadError('Kunne ikke indlæse skabeloner. Prøv at genindlæse siden.');
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadSkabeloner();
    fetch('/api/skabeloner/share-config')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { share: ShareConfig } | null) => {
        if (data?.share) setShareConfig(data.share);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => {
    if (copiedToastTimer.current) clearTimeout(copiedToastTimer.current);
  }, []);

  const shareEnabled = shareConfig.code || shareConfig.link;

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
    setActionError(null);
    try {
      const res = await fetch(`/api/skabeloner/${s.id}`, { method: 'DELETE' });
      if (res.ok) {
        setSkabeloner((prev) => prev.filter((x) => x.id !== s.id));
      } else {
        console.error('[skabeloner] Sletning fejlede — HTTP', res.status, 'for skabelon', s.id);
        setActionError('Kunne ikke slette skabelonen. Prøv igen.');
      }
    } catch (err) {
      console.error('[skabeloner] Netværksfejl ved sletning af skabelon', s.id, err);
      setActionError('Kunne ikke slette skabelonen. Prøv igen.');
    }
  }

  async function handleSetDefault(s: Skabelon) {
    if (s.isDefault) return;
    setActionError(null);
    try {
      const res = await fetch(`/api/skabeloner/${s.id}/default`, { method: 'POST' });
      if (!res.ok) {
        console.error('[skabeloner] Kunne ikke sætte standardskabelon — HTTP', res.status, 'for skabelon', s.id);
        setActionError('Kunne ikke sætte standardskabelon. Prøv igen.');
        return;
      }
      // One default per user — mirror that locally so only the chosen card fills.
      setSkabeloner((prev) => prev.map((x) => ({ ...x, isDefault: x.id === s.id })));
    } catch (err) {
      console.error('[skabeloner] Netværksfejl ved ændring af standardskabelon', s.id, err);
      setActionError('Kunne ikke sætte standardskabelon. Prøv igen.');
    }
  }

  // Copy text to the clipboard and flash the inline "… kopieret til udklipsholder"
  // confirmation above the given skabelon's buttons. Returns false if the clipboard
  // is unavailable so the caller can fall back to the dialog.
  async function copyInline(id: string, text: string, message: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return false;
    }
    if (copiedToastTimer.current) clearTimeout(copiedToastTimer.current);
    setCopiedToast({ id, text: message });
    copiedToastTimer.current = setTimeout(() => setCopiedToast(null), 2500);
    return true;
  }

  // Publish the template server-side and return its import link, or null on failure.
  async function createShareLink(s: Skabelon): Promise<string | null> {
    try {
      const res = await fetch(`/api/skabeloner/${s.id}/share`, { method: 'POST' });
      if (!res.ok) throw new Error();
      const { token } = (await res.json()) as { token: string };
      return `${window.location.origin}/skabeloner/import/${token}`;
    } catch {
      return null;
    }
  }

  function resetShareState() {
    setCopiedCode(false);
    setCopiedLink(false);
    setShareCode(null);
    setShareLink(null);
    setLinkError(null);
  }

  async function handleShare(s: Skabelon) {
    const onlyCode = shareConfig.code && !shareConfig.link;
    const onlyLink = shareConfig.link && !shareConfig.code;

    // Single-method sharing copies straight to the clipboard and confirms inline —
    // there's only one thing to hand over, so no dialog is needed.
    if (onlyCode) {
      const code = encodeSkabelonCode(s);
      if (await copyInline(s.id, code, 'Kode kopieret til udklipsholder')) return;
      // Clipboard blocked — open the dialog so the code stays selectable.
      resetShareState();
      setShareCode(code);
      setShareTarget(s);
      return;
    }

    if (onlyLink) {
      const link = await createShareLink(s);
      if (link && (await copyInline(s.id, link, 'Link kopieret til udklipsholder'))) return;
      // Clipboard blocked or link creation failed — open the dialog (reuses the
      // already-created link, or surfaces the error for a retry).
      resetShareState();
      if (link) setShareLink(link);
      else setLinkError('Kunne ikke oprette delingslink');
      setShareTarget(s);
      return;
    }

    // Both methods enabled — open the dialog so the user can pick code or link.
    resetShareState();
    setShareTarget(s);

    const code = encodeSkabelonCode(s);
    setShareCode(code);
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(true);
    } catch {
      /* clipboard may be unavailable; the code is still selectable */
    }

    setLinkLoading(true);
    const link = await createShareLink(s);
    setLinkLoading(false);
    if (link) setShareLink(link);
    else setLinkError('Kunne ikke oprette delingslink');
  }

  async function copyText(text: string, which: 'code' | 'link') {
    try {
      await navigator.clipboard.writeText(text);
      if (which === 'code') setCopiedCode(true);
      else setCopiedLink(true);
    } catch {
      /* clipboard may be unavailable; the value is still selectable */
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <p className="text-sm text-[var(--muted)]">
          Skabeloner er genbrugelige prompts til at generere referater.
          {shareEnabled && ' Tryk Del for at dele en skabelon med andre.'}
        </p>
        <Button size="sm" onClick={openNew}>
          + Ny skabelon
        </Button>
      </div>

      {loadError && (
        <ErrorBanner
          message={loadError}
          onRetry={loadSkabeloner}
          className="mb-4"
        />
      )}

      {actionError && (
        <ErrorBanner message={actionError} onRetry={() => setActionError(null)} retryLabel="Luk" className="mb-4" />
      )}

      {loading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {[...Array(2)].map((_, i) => (
            <div key={i} className="h-40 bg-[var(--fill)] rounded-[var(--radius-lg)] animate-pulse" />
          ))}
        </div>
      ) : !loadError && skabeloner.length === 0 ? (
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

                <div className="mt-auto pt-2">
                  {copiedToast?.id === s.id && (
                    <p
                      className="mb-1.5 text-xs"
                      style={{ color: 'var(--accent)' }}
                      role="status"
                      aria-live="polite"
                    >
                      {copiedToast.text}
                    </p>
                  )}
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="sm" onClick={() => openEdit(s)}>Rediger</Button>
                    {shareEnabled && (
                      <Button variant="ghost" size="sm" onClick={() => handleShare(s)}>Del</Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => handleDelete(s)}>Slet</Button>
                  </div>
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
        shareConfig={shareConfig}
      />

      <Dialog open={shareTarget !== null} onOpenChange={(o) => !o && setShareTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Del skabelon</DialogTitle>
            <DialogDescription>
              Send en kode eller et link til andre — de indsætter det under &quot;Ny skabelon&quot;.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 mt-2">
            {shareConfig.code && shareCode && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-[var(--ink)]">Kode</p>
                <Textarea
                  readOnly
                  value={shareCode}
                  rows={4}
                  className="font-mono text-xs"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button size="sm" onClick={() => copyText(shareCode, 'code')}>
                  {copiedCode ? 'Kopieret' : 'Kopiér kode'}
                </Button>
              </div>
            )}

            {shareConfig.link && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-[var(--ink)]">Link</p>
                {linkLoading ? (
                  <p className="text-sm text-[var(--muted)]">Genererer link…</p>
                ) : linkError ? (
                  <p className="text-sm text-[var(--kill)]">{linkError}</p>
                ) : shareLink ? (
                  <div className="flex items-center gap-2">
                    <Input readOnly value={shareLink} onFocus={(e) => e.currentTarget.select()} />
                    <Button size="sm" onClick={() => copyText(shareLink, 'link')}>
                      {copiedLink ? 'Kopieret' : 'Kopiér'}
                    </Button>
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setShareTarget(null)}>Luk</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
