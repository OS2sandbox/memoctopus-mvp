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
import { ProcessingTranscription } from '@/components/meeting/ProcessingTranscription';
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

  // Auto-refresh every 4 s while transcription is in progress so the page
  // picks up the transcript as soon as the audio-upload route completes.
  useEffect(() => {
    if (meeting.status !== 'processing' || activeTab !== 'review') return;
    const id = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(id);
  }, [meeting.status, activeTab, router]);


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
          participants={meeting.participants}
        />
      )}

      {activeTab === 'review' && !transcript && meeting.status === 'processing' && !isTeamsMeeting && (
        <ProcessingTranscription meetingId={meetingId} />
      )}

      {activeTab === 'review' && !transcript && meeting.status === 'processing' && isTeamsMeeting && (
        <div className="mx-auto max-w-[720px] px-6 py-12">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{
              width: 8, height: 8, borderRadius: 999, background: 'var(--accent)', flexShrink: 0,
              animation: 'processingPulse 1.4s ease-in-out infinite',
            }} />
            <h1 className="text-xl font-semibold text-[var(--ink)]">Behandler optagelse…</h1>
          </div>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Mødet er slut. Transskription og referat er ved at blive lavet…
          </p>
          <div style={{ marginTop: 20, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7 }}>
              <span style={{
                display: 'inline-block', width: 11, height: 11, borderRadius: 999, flexShrink: 0,
                border: '2px solid var(--accent)', borderTopColor: 'transparent',
                animation: 'spin 0.8s linear infinite',
              }} />
              <span>transskriberer optagelse…</span>
            </div>
            <div style={{ height: 3, borderRadius: 999, background: 'var(--line)', overflow: 'hidden', position: 'relative' }}>
              <div style={{
                position: 'absolute',
                height: '100%', borderRadius: 999, background: 'var(--accent)',
                width: '40%',
                animation: 'botProcessing 1.5s ease-in-out infinite',
              }} />
            </div>
          </div>
          <style>{`
            @keyframes processingPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
            @keyframes spin { to { transform: rotate(360deg); } }
            @keyframes botProcessing { 0% { left: -40%; } 100% { left: 100%; } }
          `}</style>
        </div>
      )}

      {activeTab === 'review' && !transcript && meeting.status === 'failed' && (
        <div className="mx-auto max-w-[720px] px-6 py-12">
          <h1 className="text-xl font-semibold text-[var(--ink)]">Transskription fejlede</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Lydfilen kunne ikke transskriberes — transskriptionsserveren er muligvis midlertidigt utilgængelig.
          </p>
          <button
            onClick={() => router.push(`/meeting/${meetingId}`)}
            style={{
              marginTop: 16, padding: '8px 16px', borderRadius: 8,
              background: 'var(--ink)', color: 'var(--bg)', border: 'none',
              fontSize: 13, cursor: 'pointer',
            }}
          >
            Gå til optagelse
          </button>
        </div>
      )}

      {activeTab === 'review' && !transcript && meeting.status !== 'processing' && meeting.status !== 'failed' && (
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
