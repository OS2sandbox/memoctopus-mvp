'use client';

import React, { useState, useCallback } from 'react';
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
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);

  const speakerCounts = segments.reduce<Record<string, number>>((acc, seg) => {
    acc[seg.speaker] = (acc[seg.speaker] ?? 0) + 1;
    return acc;
  }, {});

  function handleSegmentUpdate(index: number, updated: TranscriptSegment) {
    setSegments((prev) => prev.map((s, i) => (i === index ? updated : s)));
  }

  const handleRenameAll = useCallback(
    async (from: string, to: string) => {
      setSegments((prev) =>
        prev.map((seg) => (seg.speaker === from ? { ...seg, speaker: to } : seg)),
      );
      try {
        await fetch(`/api/meetings/${meetingId}/transcript/speakers`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, to }),
        });
      } catch {
        // optimistic update already applied; persist failure is non-critical
      }
    },
    [meetingId],
  );

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
    <div className="mx-auto max-w-[1040px] px-6 py-12">
      {error && (
        <div
          className="mb-6 rounded-[var(--radius)] border px-4 py-3 text-sm text-[var(--danger)]"
          style={{ backgroundColor: 'var(--danger-wash)', borderColor: 'var(--danger)' }}
        >
          {error}
        </div>
      )}

      {/* Two-column layout: transcript left, PII panel + actions right */}
      <div className="flex gap-8 items-start">
        {/* Transcript — main column */}
        <div className="flex-1 min-w-0">
          <h1
            className="mb-6 font-medium text-[var(--ink)]"
            style={{ fontSize: 'var(--t-h2)' }}
          >
            Transskription
          </h1>
          <p className="mb-6 text-[var(--muted)]" style={{ fontSize: 'var(--t-small)' }}>
            Ret eventuelle fejl. Klik på et talernavn for at omdøbe alle segmenter for den taler.
          </p>

          <div className="divide-y divide-[var(--line)]">
            {segments.length === 0 ? (
              <p className="py-8 text-center text-[var(--muted)]" style={{ fontSize: 'var(--t-small)' }}>
                Ingen transskription fundet.
              </p>
            ) : (
              segments.map((seg, i) => (
                <SpeakerRow
                  key={i}
                  segment={seg}
                  index={i}
                  onUpdate={handleSegmentUpdate}
                  onRenameAll={handleRenameAll}
                  speakerSegmentCount={speakerCounts[seg.speaker] ?? 1}
                />
              ))
            )}
          </div>
        </div>

        {/* Right sticky panel */}
        <div className="w-80 shrink-0 sticky top-20">
          {/* PII replacements */}
          {piiReplacements.length > 0 && (
            <div className="border border-[var(--line)] rounded-[var(--radius)] bg-[var(--surface)] mb-4 overflow-hidden">
              <div className="px-4 py-3 border-b border-[var(--line)]">
                <p className="font-medium text-[var(--ink)]" style={{ fontSize: 'var(--t-small)' }}>
                  {piiReplacements.length} PII fjernet
                </p>
              </div>
              <div className="divide-y divide-[var(--line)] max-h-64 overflow-y-auto">
                {piiReplacements.map((r, i) => (
                  <div key={i} className="flex items-center justify-between gap-2 px-4 py-2.5">
                    <div>
                      <span
                        className="line-through text-[var(--muted)]"
                        style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--t-micro)' }}
                      >
                        {r.original}
                      </span>
                      <span
                        className="ml-1.5 text-[var(--ink-2)]"
                        style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--t-micro)' }}
                      >
                        {r.replacement}
                      </span>
                    </div>
                    <Badge variant={piiTypeVariant(r.type)} className="shrink-0 text-[10px]">
                      {typeLabels[r.type] ?? r.type}
                    </Badge>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="space-y-2">
            <Button
              className="w-full"
              onClick={() => setShowConfirm(true)}
              disabled={isGenerating || segments.length === 0}
            >
              {isGenerating ? 'Genererer…' : 'Generér referat'}
            </Button>
            <button
              className="w-full text-center text-[var(--muted)] hover:text-[var(--danger)] transition-colors"
              style={{ fontSize: 'var(--t-small)' }}
              onClick={() => router.push(`/meeting/${meetingId}/settings`)}
            >
              Slet følsomt indhold nu →
            </button>
          </div>
        </div>
      </div>

      {/* Confirm dialog */}
      <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Generér referat?</DialogTitle>
            <DialogDescription>
              Modellen vil nu udarbejde et referat baseret på transskriptionen. Du kan redigere det bagefter.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowConfirm(false)}>
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
