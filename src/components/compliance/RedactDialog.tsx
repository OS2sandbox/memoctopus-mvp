'use client';

import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface RedactDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meetingTitle: string;
  onConfirm: () => Promise<void>;
}

export function RedactDialog({ open, onOpenChange, meetingTitle, onConfirm }: RedactDialogProps) {
  const [confirmText, setConfirmText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMatch = confirmText.trim() === meetingTitle.trim();

  async function handleConfirm() {
    if (!isMatch) return;
    setLoading(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Noget gik galt');
    } finally {
      setLoading(false);
    }
  }

  function handleClose() {
    setConfirmText('');
    setError(null);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Slet alt følsomt indhold fra dette møde?</DialogTitle>
        </DialogHeader>

        <div className="py-2">
          <p className="text-sm text-[var(--muted)] mb-4">
            Denne handling er permanent og kan ikke fortrydes. Følgende slettes:
          </p>
          <ul className="space-y-1.5 text-sm text-[var(--ink-2)]">
            <li className="flex items-start gap-2">
              <span className="text-[var(--danger)] mt-0.5">–</span>
              Lydfilen slettes permanent
            </li>
            <li className="flex items-start gap-2">
              <span className="text-[var(--danger)] mt-0.5">–</span>
              Den rå transskription overskrives med den rensede version
            </li>
            <li className="flex items-start gap-2">
              <span className="text-[var(--danger)] mt-0.5">–</span>
              PII-erstatningerne for dette møde slettes
            </li>
            <li className="flex items-start gap-2">
              <span className="text-[var(--ok)] mt-0.5">+</span>
              Det færdige, anonymiserede referat bevares
            </li>
          </ul>

          <div className="mt-6">
            <p className="text-sm text-[var(--ink-2)] mb-2">
              Skriv mødetitlen for at bekræfte:{' '}
              <span
                className="font-medium"
                style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--t-small)' }}
              >
                {meetingTitle}
              </span>
            </p>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={meetingTitle}
              className="w-full border border-[var(--line-strong)] rounded-[var(--radius)] px-3 py-2 text-sm bg-[var(--surface)] text-[var(--ink)] outline-none focus:border-[var(--danger)] placeholder:text-[var(--muted-2)]"
            />
          </div>

          {error && (
            <p className="mt-3 text-sm text-[var(--danger)]">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={handleClose} disabled={loading}>
            Afbryd
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={!isMatch || loading}
          >
            {loading ? 'Sletter…' : 'Slet permanent'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
