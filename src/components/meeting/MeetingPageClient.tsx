'use client';

import React, { useState, useCallback } from 'react';
import { ProcessStrip, ProcessPhase } from '@/components/layout/ProcessStrip';
import { RecordingScreen } from '@/components/recording/RecordingScreen';
import { TranscriptReview } from '@/components/transcript/TranscriptReview';
import { MinutesEditor } from '@/components/minutes/MinutesEditor';
import { ExportTab } from '@/components/meeting/ExportTab';
import type { MeetingPageData } from '@/lib/data/meeting-page';

interface MeetingPageClientProps {
  meetingId: string;
  initialTab: ProcessPhase;
  data: MeetingPageData;
}

export function MeetingPageClient({ meetingId, initialTab, data }: MeetingPageClientProps) {
  const [activeTab, setActiveTab] = useState<ProcessPhase>(initialTab);

  const switchTab = useCallback(
    (tab: ProcessPhase) => {
      setActiveTab(tab);
      const path =
        tab === 'recording'
          ? `/meeting/${meetingId}`
          : `/meeting/${meetingId}/${tab}`;
      window.history.replaceState(null, '', path);
    },
    [meetingId],
  );

  const { meeting, audioFile, transcript, minutes } = data;

  const completedPhases: ProcessPhase[] = (() => {
    const s = meeting.status;
    if (s === 'done') return ['recording', 'review', 'minutes'];
    if (s === 'minutes') return ['recording', 'review'];
    if (s === 'review') return ['recording'];
    return [];
  })();

  const isCompleted = meeting.status !== 'recording' && meeting.status !== 'processing';

  return (
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
        />
      )}

      {activeTab === 'review' && transcript && (
        <TranscriptReview
          meetingId={meetingId}
          transcriptId={transcript.id}
          initialSegments={transcript.segments}
          piiReplacements={transcript.piiReplacements}
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
  );
}
