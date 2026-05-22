'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { TranscriptSegment, PiiReplacement } from '@/types';
import { SpeakerRow } from './SpeakerRow';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface TranscriptReviewProps {
  meetingId: string;
  transcriptId: string;
  initialSegments: TranscriptSegment[];
  piiReplacements: PiiReplacement[];
}

export function TranscriptReview({
  meetingId,
  transcriptId,
  initialSegments,
  piiReplacements,
}: TranscriptReviewProps) {
  const router = useRouter();
  const [segments, setSegments] = useState(initialSegments);
  const [showPiiPanel, setShowPiiPanel] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);

  function handleSegmentUpdate(index: number, updated: TranscriptSegment) {
    setSegments((prev) => prev.map((s, i) => (i === index ? updated : s)));
  }

  async function proceedToMinutes() {
    setIsGenerating(true);
    setError(null);
    try {
      const res = await fetch('/api/minutes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meetingId, transcriptId, segments }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? 'Kunne ikke generere referat');
      }
      router.push(`/meeting/${meetingId}/minutes`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Noget gik galt');
      setIsGenerating(false);
    }
  }

  const typeLabels: Record<string, string> = {
    NAVN: 'Navn',
    CPR: 'CPR-nummer',
    ADRESSE: 'Adresse',
    TELEFON: 'Telefonnummer',
    EMAIL: 'E-mail',
    OTHER: 'Andet',
    ANDEN_PII: 'Andet',
  };

  const piiTypeVariant = (type: string) => {
    if (type === 'CPR') return 'destructive' as const;
    if (type === 'NAVN') return 'default' as const;
    return 'secondary' as const;
  };

  return (
    <div className="mx-auto max-w-[960px] px-4 py-8">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl font-semibold text-[var(--ink)]">Gennemse transskription</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Ret eventuelle fejl. Klik på et talernavn for at omdøbe taleren.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {piiReplacements.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowPiiPanel(true)}
            >
              {piiReplacements.length} PII fjernet
            </Button>
          )}
          <Button
            onClick={() => setShowConfirm(true)}
            disabled={isGenerating || segments.length === 0}
          >
            {isGenerating ? 'Genererer...' : 'Generér referat'}
          </Button>
        </div>
      </div>

      {error && (
        <div
          className="mb-4 rounded-[var(--radius)] border px-4 py-3 text-sm text-[var(--danger)]"
          style={{ backgroundColor: 'var(--danger-wash)', borderColor: 'var(--danger)' }}
        >
          {error}
        </div>
      )}

      {/* Transcript */}
      <div className="rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--surface)] divide-y divide-[var(--line)]">
        {segments.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-[var(--muted)]">
            Ingen transskription fundet.
          </p>
        ) : (
          <div className="px-4">
            {segments.map((seg, i) => (
              <SpeakerRow key={i} segment={seg} index={i} onUpdate={handleSegmentUpdate} />
            ))}
          </div>
        )}
      </div>

      <div className="mt-6 flex justify-end">
        <Button
          onClick={() => setShowConfirm(true)}
          disabled={isGenerating || segments.length === 0}
          size="lg"
        >
          {isGenerating ? 'Genererer referat...' : 'Godkend og generér referat'}
        </Button>
      </div>

      {/* PII panel */}
      <Dialog open={showPiiPanel} onOpenChange={setShowPiiPanel}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Fjernede personoplysninger</DialogTitle>
            <DialogDescription>
              Disse oplysninger er erstattet med anonymiserede placeholders.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto space-y-2 mt-2">
            {piiReplacements.map((r, i) => (
              <div
                key={i}
                className="flex items-center justify-between gap-2 py-2 border-b border-[var(--line)] last:border-0"
              >
                <div>
                  <span className="text-sm font-medium text-[var(--ink)] line-through mr-2">
                    {r.original}
                  </span>
                  <span className="text-sm text-[var(--muted)]">→ {r.replacement}</span>
                </div>
                <Badge variant={piiTypeVariant(r.type)} className="shrink-0">
                  {typeLabels[r.type] ?? r.type}
                </Badge>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setShowPiiPanel(false)}>
              Luk
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm dialog */}
      <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Generér referat?</DialogTitle>
            <DialogDescription>
              Claude vil nu udarbejde et referat baseret på transskriptionen. Du kan redigere det
              bagefter.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setShowConfirm(false)}>
              Annullér
            </Button>
            <Button
              onClick={() => {
                setShowConfirm(false);
                proceedToMinutes();
              }}
            >
              Generér referat
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
