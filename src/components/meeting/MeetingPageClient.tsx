'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { ProcessStrip, ProcessPhase } from '@/components/layout/ProcessStrip';
import { RecordingScreen } from '@/components/recording/RecordingScreen';
import { MeetingBotScreen } from '@/components/recording/MeetingBotScreen';
import { TranscriptReview } from '@/components/transcript/TranscriptReview';
import { MinutesEditor } from '@/components/minutes/MinutesEditor';
import { ExportTab } from '@/components/meeting/ExportTab';
import { DeleteAudioDialog } from '@/components/meeting/DeleteAudioDialog';
import { ProcessingTranscription } from '@/components/meeting/ProcessingTranscription';
import { useReviewAudio } from '@/lib/review-audio-context';
import {
  getMeeting,
  getTranscript,
  getMinutes,
  getAudio,
  StoredMeeting,
  StoredTranscript,
  StoredMinutes,
} from '@/lib/storage';

interface MeetingPageClientProps {
  meetingId: string;
  initialTab: ProcessPhase;
}

export function MeetingPageClient({ meetingId, initialTab }: MeetingPageClientProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<ProcessPhase>(initialTab);
  const [showDeleteAudioDialog, setShowDeleteAudioDialog] = useState(false);
  const { setHasAudio } = useReviewAudio();

  const [meeting, setMeeting] = useState<StoredMeeting | null>(null);
  const [transcript, setTranscript] = useState<StoredTranscript | null>(null);
  const [minutes, setMinutes] = useState<StoredMinutes | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const audioBlobUrlRef = useRef<string | null>(null);

  const loadData = useCallback(async () => {
    const [m, t, min] = await Promise.all([
      getMeeting(meetingId),
      getTranscript(meetingId),
      getMinutes(meetingId),
    ]);
    setMeeting(m);
    setTranscript(t);
    setMinutes(min);

    if (m && !m.audioDeleted) {
      const audioEntry = await getAudio(meetingId);
      if (audioEntry) {
        if (audioBlobUrlRef.current) URL.revokeObjectURL(audioBlobUrlRef.current);
        const url = URL.createObjectURL(audioEntry.blob);
        audioBlobUrlRef.current = url;
        setAudioUrl(url);
      } else {
        if (audioBlobUrlRef.current) URL.revokeObjectURL(audioBlobUrlRef.current);
        audioBlobUrlRef.current = null;
        setAudioUrl(undefined);
      }
    } else {
      if (audioBlobUrlRef.current) URL.revokeObjectURL(audioBlobUrlRef.current);
      audioBlobUrlRef.current = null;
      setAudioUrl(undefined);
    }

    setLoading(false);
  }, [meetingId]);

  useEffect(() => {
    loadData();
    return () => {
      if (audioBlobUrlRef.current) URL.revokeObjectURL(audioBlobUrlRef.current);
    };
  }, [loadData]);

  useEffect(() => {
    const hasAudio = activeTab === 'review' && !!audioUrl;
    setHasAudio(hasAudio);
    return () => setHasAudio(false);
  }, [activeTab, audioUrl, setHasAudio]);


  const switchTab = useCallback(
    (tab: ProcessPhase) => {
      if (tab === 'recording' && activeTab === 'review' && !!audioUrl) {
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
    [meetingId, activeTab, audioUrl],
  );

  if (loading) {
    return (
      <div style={{ padding: '48px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{
          display: 'inline-block', width: 20, height: 20, borderRadius: 999,
          border: '2px solid var(--line-2)', borderTopColor: 'var(--accent)',
          animation: 'spin 0.8s linear infinite',
        }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (!meeting) {
    return (
      <div style={{ padding: '48px' }}>
        <h1 style={{ fontSize: 'var(--t-h1)', fontWeight: 300 }}>Møde ikke fundet</h1>
        <p style={{ marginTop: 8, color: 'var(--muted)' }}>
          Dette møde eksisterer ikke i din lokale lagerplads.
        </p>
      </div>
    );
  }

  const completedPhases: ProcessPhase[] = (() => {
    const s = meeting.status;
    if (s === 'done') return ['recording', 'review', 'minutes'];
    if (s === 'minutes') return ['recording', 'review'];
    if (s === 'review') return ['recording'];
    return [];
  })();

  const isCompleted = meeting.status !== 'recording' && meeting.status !== 'processing';
  const isTeamsMeeting = meeting.source === 'teams';
  const audioFile = !meeting.audioDeleted && audioUrl
    ? { durationSeconds: meeting.audioDurationSeconds, sizeBytes: meeting.audioSizeBytes }
    : null;

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
          loadData();
          if (!transcript) {
            setActiveTab('recording');
            window.history.replaceState(null, '', `/meeting/${meetingId}`);
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
          onRecordingComplete={loadData}
        />
      )}

      {activeTab === 'review' && transcript && (
        <TranscriptReview
          meetingId={meetingId}
          initialSegments={transcript.segments}
          piiReplacements={transcript.piiReplacements}
          audioUrl={audioUrl}
          audioDurationSeconds={audioFile?.durationSeconds}
          audioDeleted={meeting.audioDeleted && meeting.status !== 'recording' && meeting.status !== 'processing'}
          initialChapters={transcript.chapters}
          participants={meeting.participants}
          onDataChange={loadData}
        />
      )}

      {activeTab === 'review' && !transcript && meeting.status === 'processing' && !isTeamsMeeting && (
        <ProcessingTranscription meetingId={meetingId} onComplete={loadData} />
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
          initialContent={minutes.content}
          version={minutes.version}
          versions={minutes.versions}
          onSaved={loadData}
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
