'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ErrorBanner } from '@/components/ui/error-banner';
import { useToast } from '@/components/ui/toast';
import type { CentralTemplateListItem } from '@/lib/skabeloner/central-types';
import { ChangeNoteField } from './CentralTemplatesChangeNote';
import { centralRequest, conflictMessage, noteProblem } from './central-template-utils';

export type StateChange = 'archive' | 'restore';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template: Pick<CentralTemplateListItem, 'id' | 'name' | 'currentVersion'> | null;
  mode: StateChange;
  /** Called after a saved change, and after "Genindlæs" on a conflict, so the list is refetched. */
  onDone: () => void;
}

const COPY = {
  archive: {
    title: 'Arkivér skabelon',
    description:
      'En arkiveret skabelon forsvinder for modtagerne og kan ikke bruges til nye referater. Du kan gendanne den senere.',
    confirm: 'Arkivér',
    busy: 'Arkiverer …',
    toast: 'Skabelonen er arkiveret',
  },
  restore: {
    title: 'Gendan skabelon',
    description: 'Skabelonen bliver igen tilgængelig for sine modtagere.',
    confirm: 'Gendan',
    busy: 'Gendanner …',
    toast: 'Skabelonen er gendannet',
  },
} as const;

export function CentralTemplatesStateDialog({ open, onOpenChange, template, mode, onDone }: Props) {
  return (
    <Dialog open={open && template !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {template && <StateForm template={template} mode={mode} onClose={() => onOpenChange(false)} onDone={onDone} />}
      </DialogContent>
    </Dialog>
  );
}

function StateForm({
  template,
  mode,
  onClose,
  onDone,
}: {
  template: NonNullable<Props['template']>;
  mode: StateChange;
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const copy = COPY[mode];
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const problem = noteProblem(note);

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    if (problem || saving) return;
    setSaving(true);
    setError(null);
    const res = await centralRequest(`/api/admin/central-templates/${template.id}/${mode}`, {
      method: 'POST',
      json: { baseVersion: template.currentVersion, changeNote: note.trim() },
    });
    setSaving(false);
    if (!res.ok) {
      if (res.status === 409 && res.code === 'version_conflict') {
        setConflict(true);
        setError(res.currentVersion !== undefined ? conflictMessage(res.currentVersion) : res.message);
      } else {
        setError(res.message);
      }
      return;
    }
    toast({ message: copy.toast, variant: 'success' });
    onDone();
    onClose();
  }

  // Nothing is retried on its own: the list is refreshed and the person starts over knowingly.
  function reload() {
    onDone();
    onClose();
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{copy.title}</DialogTitle>
        <DialogDescription>
          »{template.name}«. {copy.description}
        </DialogDescription>
      </DialogHeader>
      <ErrorBanner message={error} onRetry={conflict ? reload : undefined} retryLabel="Genindlæs" />
      <ChangeNoteField id="ct-state-note" value={note} onChange={setNote} />
      <DialogFooter className="items-center gap-2">
        {problem && (
          <p id="ct-state-reason" className="mr-auto text-[13px] text-[var(--muted)]">
            {problem}
          </p>
        )}
        <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
          Annuller
        </Button>
        <Button
          type="submit"
          variant={mode === 'archive' ? 'destructive' : 'default'}
          disabled={problem !== null || saving || conflict}
          aria-describedby={problem ? 'ct-state-reason' : undefined}
        >
          {saving ? copy.busy : copy.confirm}
        </Button>
      </DialogFooter>
    </form>
  );
}
