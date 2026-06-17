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
  deleteAudio,
  updateMeeting,
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
  // Tracks whether the meeting currently has stored audio that should be purged
  // on leaving the page. Read inside the cleanup below so it reflects the live
  // value, not a stale closure. Stays false until audio has actually loaded —
  // which is why StrictMode's mount→cleanup→mount (it fires before the async
  // load resolves) can't trigger a premature deletion.
  const audioDeletableRef = useRef(false);
  audioDeletableRef.current = !!audioUrl && !!meeting && !meeting.audioDeleted;
  // True only for the live recording session that will save its audio and route
  // to /review. That handoff (this instance unmounts on the router.push) must not
  // purge the freshly saved audio; every other view purges on leave. Captured
  // once on first load — see loadData.
  const activeRecorderRef = useRef(false);
  const initialLoadDoneRef = useRef(false);

  const loadData = useCallback(async () => {
    const [m, t, min] = await Promise.all([
      getMeeting(meetingId),
      getTranscript(meetingId),
      getMinutes(meetingId),
    ]);
    setMeeting(m);
    setTranscript(t);
    setMinutes(min);

    // Mark this instance as the live recorder if it opened the recording route on
    // an in-progress meeting. Such a session saves audio and navigates to /review,
    // so its unmount must not purge that handoff. Any other view (review, the
    // recording look-back, an abandoned recording reopened from the Arkiv) purges.
    if (!initialLoadDoneRef.current) {
      initialLoadDoneRef.current = true;
      activeRecorderRef.current =
        initialTab === 'recording' && !!m && (m.status === 'recording' || m.status === 'processing');
    }

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
  }, [meetingId, initialTab]);

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

  // Privacy: audio must never linger for a meeting reopened from the Arkiv. The
  // recording is purged either when the referat is generated (handled in
  // TranscriptReview) or when the user leaves the meeting entirely — navigating
  // back to the Arkiv, opening another meeting, or closing the tab. This unmount
  // cleanup covers every tab (the Gennemgang/review view, the recording look-back,
  // and an abandoned recording), so no meeting in the Arkiv keeps stored audio.
  // It runs once (no activeTab/audioUrl deps), so in-page tab switches and the
  // routine blob-URL refresh in loadData never trigger a deletion mid-session;
  // only the real unmount does. The live recording session is the sole exception
  // (activeRecorderRef) — it saves audio and hands it to /review.
  useEffect(() => {
    return () => {
      if (activeRecorderRef.current) return;
      if (!audioDeletableRef.current) return;
      void deleteAudio(meetingId).catch(() => {});
      void updateMeeting(meetingId, { audioDeleted: true }).catch(() => {});
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId]);

  // Catch the cases an unmount cleanup can't reliably handle — closing the tab or
  // a hard reload — whenever deletable audio is present on any tab.
  useEffect(() => {
    if (!audioUrl) return;
    const purge = () => {
      if (activeRecorderRef.current || !audioDeletableRef.current) return;
      void deleteAudio(meetingId).catch(() => {});
    };
    window.addEventListener('pagehide', purge);
    return () => window.removeEventListener('pagehide', purge);
  }, [audioUrl, meetingId]);


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
          botSession={meeting.botSession ?? null}
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
          initialDiarizing={transcript.diarizationStatus === 'pending'}
          onDataChange={loadData}
        />
      )}

      {activeTab === 'review' && !transcript && meeting.status === 'processing' && (
        <ProcessingTranscription meetingId={meetingId} onComplete={loadData} />
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
          meetingTitle={meeting.title}
          initialContent={minutes.content}
          version={minutes.version}
          activeVersionId={minutes.activeVersionId}
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
