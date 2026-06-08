'use client';

import React, { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ProcessStrip, ProcessPhase } from '@/components/layout/ProcessStrip';
import { RecordingScreen } from '@/components/recording/RecordingScreen';
import { MeetingBotScreen } from '@/components/recording/MeetingBotScreen';
import { TranscriptReview } from '@/components/transcript/TranscriptReview';
import { MinutesEditor } from '@/components/minutes/MinutesEditor';
import { ExportTab } from '@/components/meeting/ExportTab';
import { DeleteAudioDialog } from '@/components/meeting/DeleteAudioDialog';
import type { MeetingPageData } from '@/lib/data/meeting-page';
import { useReviewAudio } from '@/lib/review-audio-context';

interface MeetingPageClientProps {
  meetingId: string;
  initialTab: ProcessPhase;
  data: MeetingPageData;
}

export function MeetingPageClient({ meetingId, initialTab, data }: MeetingPageClientProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<ProcessPhase>(initialTab);
  const [showDeleteAudioDialog, setShowDeleteAudioDialog] = useState(false);
  const { setHasAudio } = useReviewAudio();

  const { meeting, audioFile, transcript, minutes } = data;

  useEffect(() => {
    setHasAudio(activeTab === 'review' && !!audioFile);
    return () => setHasAudio(false);
  }, [activeTab, audioFile, setHasAudio]);

  // Auto-refresh every 4 s while transcription is in progress so the page
  // picks up the transcript as soon as the audio-upload route completes.
  useEffect(() => {
    if (meeting.status !== 'processing' || activeTab !== 'review') return;
    const id = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(id);
  }, [meeting.status, activeTab, router]);

  const switchTab = useCallback(
    (tab: ProcessPhase) => {
      if (tab === 'recording' && activeTab === 'review' && !!audioFile) {
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
    [meetingId, activeTab, audioFile],
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
        title={transcript ? 'Slet lydfil?' : 'Slet lydfil og gå til optagelse?'}
        description={
          transcript
            ? 'Lydfilen slettes. Transskriptionen bevares.'
            : 'Lydfilen slettes, og mødet nulstilles til optagelse.'
        }
        confirmLabel={transcript ? 'Slet lydfil' : 'Slet og gå til optagelse'}
        onDeleted={() => {
          if (transcript) {
            router.refresh();
          } else {
            router.push(`/meeting/${meetingId}`);
          }
        }}
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
          audioDeleted={!audioFile && meeting.status !== 'recording' && meeting.status !== 'processing'}
          initialChapters={transcript.chapters}
          participants={meeting.participants}
        />
      )}

      {activeTab === 'review' && !transcript && meeting.status === 'processing' && (
        <div className="mx-auto max-w-[720px] px-6 py-12">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{
              width: 8, height: 8, borderRadius: 999, background: 'var(--accent)', flexShrink: 0,
              animation: 'processingPulse 1.4s ease-in-out infinite',
            }} />
            <h1 className="text-xl font-semibold text-[var(--ink)]">Transskription er i gang…</h1>
          </div>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Lydfilen behandles. Siden opdateres automatisk når transskriptionen er klar.
          </p>
          <style>{`
            @keyframes processingPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
          `}</style>
        </div>
      )}

      {activeTab === 'review' && !transcript && meeting.status !== 'processing' && (
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
