'use client';

import React, { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { ProcessStrip, ProcessPhase } from '@/components/layout/ProcessStrip';
import { RecordingScreen } from '@/components/recording/RecordingScreen';
import { MeetingBotScreen } from '@/components/recording/MeetingBotScreen';
import { TranscriptReview } from '@/components/transcript/TranscriptReview';
import { MinutesEditor } from '@/components/minutes/MinutesEditor';
import { ExportTab } from '@/components/meeting/ExportTab';
import { DeleteAudioDialog } from '@/components/meeting/DeleteAudioDialog';
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

  const { meeting, audioFile, transcript, minutes } = data;

  const switchTab = useCallback(
    (tab: ProcessPhase) => {
      if (tab === 'recording' && activeTab === 'review') {
        setShowDeleteAudioDialog(true);
        return;
      }
      setActiveTab(tab);
      window.history.replaceState(
        null,
        '',
        tab === 'recording' ? `/meeting/${meetingId}` : `/meeting/${meetingId}/${tab}`,
      );
    },
    [meetingId, activeTab],
  );

  const completedPhases: ProcessPhase[] = (() => {
    const s = meeting.status;
    if (s === 'done') return ['recording', 'review', 'minutes'];
    if (s === 'minutes') return ['recording', 'review'];
    if (s === 'review') return ['recording'];
    return [];
  })();

  const isCompleted = meeting.status !== 'recording' && meeting.status !== 'processing';
  const isTeamsMeeting = meeting.source === 'teams';

  return (
    <>
      <DeleteAudioDialog
        open={showDeleteAudioDialog}
        onOpenChange={setShowDeleteAudioDialog}
        meetingId={meetingId}
        title="Slet lydfil og gå til optagelse?"
        confirmLabel="Slet og gå til optagelse"
        onDeleted={() => router.push(`/meeting/${meetingId}`)}
      />
      <ProcessStrip
        meetingId={meetingId}
        activePhase={activeTab}
        completedPhases={completedPhases}
        onTabChange={switchTab}
      />

      {activeTab === 'recording' && isTeamsMeeting && (
        <MeetingBotScreen
          meetingId={meetingId}
          meetingUrl={meeting.meetingUrl ?? ''}
        />
      )}

      {activeTab === 'recording' && !isTeamsMeeting && (
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
    </>
  );
}
