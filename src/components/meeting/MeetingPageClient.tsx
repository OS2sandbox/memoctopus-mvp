'use client';

import React, { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { ProcessStrip, ProcessPhase } from '@/components/layout/ProcessStrip';
import { RecordingScreen } from '@/components/recording/RecordingScreen';
import { TranscriptReview } from '@/components/transcript/TranscriptReview';
import { MinutesEditor } from '@/components/minutes/MinutesEditor';
import { ExportTab } from '@/components/meeting/ExportTab';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { MeetingPageData } from '@/lib/data/meeting-page';

interface MeetingPageClientProps {
  meetingId: string;
  initialTab: ProcessPhase;
  data: MeetingPageData;
}

export function MeetingPageClient({ meetingId, initialTab, data }: MeetingPageClientProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<ProcessPhase>(initialTab);
  const [showDeleteAudioDialog, setShowDeleteAudioDialog] = useState(false);
  const [pendingNav, setPendingNav] = useState<{ tab?: ProcessPhase; href?: string } | null>(null);
  const [deletingAudio, setDeletingAudio] = useState(false);

  const { meeting, audioFile, transcript, minutes } = data;

  function doSwitchTab(tab: ProcessPhase) {
    setActiveTab(tab);
    const path =
      tab === 'recording'
        ? `/meeting/${meetingId}`
        : `/meeting/${meetingId}/${tab}`;
    window.history.replaceState(null, '', path);
  }

  const switchTab = useCallback(
    (tab: ProcessPhase) => {
      if (tab === 'recording' && activeTab === 'review') {
        setPendingNav({ tab });
        setShowDeleteAudioDialog(true);
        return;
      }
      doSwitchTab(tab);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [meetingId, activeTab],
  );

  async function confirmDeleteAndNavigate() {
    if (!pendingNav) return;
    setDeletingAudio(true);
    try {
      await fetch(`/api/meetings/${meetingId}/audio`, { method: 'DELETE' });
    } finally {
      setDeletingAudio(false);
      setShowDeleteAudioDialog(false);
      setPendingNav(null);
    }
    if (pendingNav.href) {
      router.push(pendingNav.href);
    } else if (pendingNav.tab) {
      router.push(`/meeting/${meetingId}`);
    }
  }

  function cancelDeleteNav() {
    setShowDeleteAudioDialog(false);
    setPendingNav(null);
  }

  const completedPhases: ProcessPhase[] = (() => {
    const s = meeting.status;
    if (s === 'done') return ['recording', 'review', 'minutes'];
    if (s === 'minutes') return ['recording', 'review'];
    if (s === 'review') return ['recording'];
    return [];
  })();

  const isCompleted = meeting.status !== 'recording' && meeting.status !== 'processing';

  return (
    <>
      <Dialog open={showDeleteAudioDialog} onOpenChange={(open) => { if (!open) cancelDeleteNav(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Slet lydfil og gå til optagelse?</DialogTitle>
          </DialogHeader>
          <p style={{ fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.6 }}>
            Lydfilen slettes, og mødet nulstilles til optagelse. Du kan derefter optage et nyt møde.
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={cancelDeleteNav} disabled={deletingAudio}>
              Afbryd
            </Button>
            <Button variant="destructive" onClick={confirmDeleteAndNavigate} disabled={deletingAudio}>
              {deletingAudio ? 'Sletter…' : 'Slet og gå til optagelse'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div>
      <ProcessStrip
        meetingId={meetingId}
        activePhase={activeTab}
        completedPhases={completedPhases}
        onTabChange={switchTab}
      />

      {activeTab === 'recording' && (
        <RecordingScreen
          meetingId={meetingId}
          existingRecording={
            isCompleted && audioFile
              ? { durationSeconds: audioFile.durationSeconds, sizeBytes: audioFile.sizeBytes }
              : undefined
          }
          onNavigateToReview={() => switchTab('review')}
        />
      )}

      {activeTab === 'review' && transcript && (
        <TranscriptReview
          meetingId={meetingId}
          transcriptId={transcript.id}
          initialSegments={transcript.segments}
          piiReplacements={transcript.piiReplacements}
          audioUrl={audioFile ? `/api/meetings/${meetingId}/audio` : undefined}
          audioDurationSeconds={audioFile?.durationSeconds}
          audioDeleted={!audioFile && meeting.status !== 'recording' && meeting.status !== 'processing' && meeting.status !== 'review'}
          initialChapters={transcript.chapters}
        />
      )}

      {activeTab === 'review' && !transcript && (
        <div className="mx-auto max-w-[720px] px-6 py-12">
          <h1 className="text-xl font-semibold text-[var(--ink)]">Ingen transskription</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Transskriptionen er endnu ikke tilgængelig. Prøv at genindlæse siden.
          </p>
        </div>
      )}

      {activeTab === 'minutes' && minutes && (
        <MinutesEditor
          meetingId={meetingId}
          minutesId={minutes.id}
          initialContent={minutes.content}
          version={minutes.version}
          versions={minutes.versions}
        />
      )}

      {activeTab === 'minutes' && !minutes && (
        <div className="mx-auto max-w-[720px] px-6 py-12">
          <h1 className="text-xl font-semibold text-[var(--ink)]">Ingen referat endnu</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Gå til{' '}
            <button
              className="text-[var(--accent)] hover:underline"
              onClick={() => switchTab('review')}
            >
              Gennemgang
            </button>{' '}
            for at generere et referat.
          </p>
        </div>
      )}

      {activeTab === 'export' && <ExportTab meetingId={meetingId} />}
    </div>
    </>
  );
}
