'use client';

import React, { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { deleteAudio, updateMeeting } from '@/lib/storage';

interface DeleteAudioDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meetingId: string;
  title: string;
  description?: string;
  confirmLabel: string;
  onDeleted: () => void;
}

export function DeleteAudioDialog({ open, onOpenChange, meetingId, title, description, confirmLabel, onDeleted }: DeleteAudioDialogProps) {
  const [deleting, setDeleting] = useState(false);

  async function handleConfirm() {
    setDeleting(true);
    try {
      await deleteAudio(meetingId);
      await updateMeeting(meetingId, { audioDeleted: true });
      onDeleted();
    } finally {
      setDeleting(false);
      onOpenChange(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">Bekræft sletning af lydfil</DialogDescription>
        </DialogHeader>
        <p style={{ fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.6 }}>
          {description ?? 'Lydfilen slettes, og mødet nulstilles til optagelse.'}
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={deleting}>
            Afbryd
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={deleting}>
            {deleting ? 'Sletter…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
