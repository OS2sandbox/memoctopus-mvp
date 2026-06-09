'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ProcessStrip } from '@/components/layout/ProcessStrip';
import { RedactDialog } from '@/components/compliance/RedactDialog';
import { getMeeting, updateMeeting, deleteMeeting, deleteAudio, getTranscript, saveTranscript } from '@/lib/storage';

export default function MeetingSettingsPage() {
  const params = useParams();
  const id = params.id as string;
  const router = useRouter();

  // Meeting title + rename state
  const [meetingTitle, setMeetingTitle] = useState<string>('');
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Dialog open states
  const [redactOpen, setRedactOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Fetch meeting title on mount
  useEffect(() => {
    getMeeting(id)
      .then((m) => {
        const title = m?.title ?? '';
        setMeetingTitle(title);
        setRenameValue(title);
      })
      .catch(() => {});
  }, [id]);

  // Focus the input when rename mode activates
  useEffect(() => {
    if (isRenaming) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isRenaming]);

  function startRenaming() {
    setRenameValue(meetingTitle);
    setIsRenaming(true);
  }

  function cancelRenaming() {
    setIsRenaming(false);
    setRenameValue(meetingTitle);
  }

  async function commitRename() {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === meetingTitle) {
      cancelRenaming();
      return;
    }
    try {
      await updateMeeting(id, { title: trimmed });
      setMeetingTitle(trimmed);
    } catch {
      // silently ignore; revert to original title
    } finally {
      setIsRenaming(false);
    }
  }

  function handleRenameKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename();
    } else if (e.key === 'Escape') {
      cancelRenaming();
    }
  }

  async function handleRedactConfirm() {
    const transcript = await getTranscript(id);
    if (transcript) {
      await saveTranscript(id, {
        rawText: '',
        segments: [],
        chapters: transcript.chapters,
        piiReplacements: [],
        piiRemovedAt: new Date().toISOString(),
      });
    }
    await deleteAudio(id);
    await updateMeeting(id, { status: 'redacted', audioDeleted: true });
    router.push('/arkiv');
  }

  async function handleDelete() {
    setIsDeleting(true);
    try {
      await deleteMeeting(id);
      router.push('/arkiv');
    } catch {
      setIsDeleting(false);
    }
  }

  return (
    <div>
      <ProcessStrip meetingId={id} activePhase="export" />
      <div className="mx-auto max-w-[720px] px-6 py-12">
        <h1
          style={{ fontSize: 'var(--t-h1)', fontWeight: 300, color: 'var(--ink)', margin: '0 0 32px' }}
        >
          Mødeindstillinger
        </h1>

        <div className="divide-y divide-[var(--line)]">
          {/* Rename */}
          <SettingRow
            title="Omdøb møde"
            description="Skift titlen på dette møde."
          >
            {isRenaming ? (
              <input
                ref={inputRef}
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={handleRenameKeyDown}
                className="rounded border border-[var(--line)] bg-[var(--surface)] px-2 py-1 text-sm text-[var(--ink)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                style={{ minWidth: 200 }}
              />
            ) : (
              <Button variant="outline" size="sm" onClick={startRenaming}>
                Omdøb
              </Button>
            )}
          </SettingRow>

          {/* Redact sensitive content */}
          <SettingRow
            title="Slet følsomt indhold"
            description="Slet lyd, rå transskription og PII permanent. Referatet beholdes."
          >
            <Button variant="danger-ghost" size="sm" onClick={() => setRedactOpen(true)}>
              Slet følsomt indhold
            </Button>
          </SettingRow>

          {/* Delete entire meeting */}
          <SettingRow
            title="Slet hele mødet"
            description="Slet mødet og alt tilhørende indhold permanent."
          >
            <Button variant="danger-ghost" size="sm" onClick={() => setDeleteOpen(true)}>
              Slet mødet
            </Button>
          </SettingRow>
        </div>
      </div>

      {/* Redact dialog */}
      <RedactDialog
        open={redactOpen}
        onOpenChange={setRedactOpen}
        meetingTitle={meetingTitle}
        onConfirm={handleRedactConfirm}
      />

      {/* Delete meeting dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Slet dette møde?</DialogTitle>
            <DialogDescription>
              Alt indhold slettes permanent — lyd, transskription og referat.
              Denne handling kan ikke fortrydes.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleteOpen(false)} disabled={isDeleting}>
              Annullér
            </Button>
            <Button variant="destructive" size="sm" onClick={handleDelete} disabled={isDeleting}>
              Slet møde
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between py-5">
      <div>
        <p className="font-medium text-[var(--ink)]" style={{ fontSize: 'var(--t-body)' }}>
          {title}
        </p>
        <p className="mt-0.5 text-[var(--muted)]" style={{ fontSize: 'var(--t-small)' }}>
          {description}
        </p>
      </div>
      <div className="shrink-0 ml-6">{children}</div>
    </div>
  );
}
