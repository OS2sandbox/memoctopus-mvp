'use client';

import { useEffect, useState } from 'react';
import {
  newVadBatchState, sealCurrentBatch, splitTextWithIntervals,
  runWithConcurrency, BATCH_DURATION_S, BATCH_CONCURRENCY,
} from '@/lib/audio/vad-batch';
import { energyVAD, decodeAndResampleTo16k } from '@/lib/audio/vad-client';
import { assignSpeakers } from '@/lib/audio/merge-speakers';
import { diarizeFromMono16k } from '@/lib/audio/diarize-client';
import { getAudio, saveTranscript, updateMeeting } from '@/lib/storage';
import type { TranscriptSegment } from '@/types';

interface Props {
  meetingId: string;
  onComplete?: () => void;
}

type Phase = 'downloading' | 'analyzing' | 'transcribing' | 'diarizing' | 'saving' | 'error';

interface BatchProgress {
  completed: number;
  total: number;
  completedSeconds: number;
  totalSeconds: number;
}

export function ProcessingTranscription({ meetingId, onComplete }: Props) {
  const [phase, setPhase] = useState<Phase>('downloading');
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    void run();

    async function run() {
      try {
        // 1. Load the archived audio from IndexedDB
        setPhase('downloading');
        const audioEntry = await getAudio(meetingId);
        if (!audioEntry) throw new Error('Lydfil ikke fundet');
        const arrayBuffer = await audioEntry.blob.arrayBuffer();

        // 2. Decode, downmix to mono, and resample to 16 kHz in 60-second chunks.
        setPhase('analyzing');
        const mono16k = await decodeAndResampleTo16k(arrayBuffer);

        // Kick off speaker diarization in parallel with transcription. It runs as a
        // single acoustic pass over the WHOLE recording (speaker identity is global),
        // so we send one WAV of the full audio and merge the turns onto the segments
        // afterwards. Fail-soft: any error yields no turns and segments keep 'Taler 1'.
        const diarizationPromise = diarizeFromMono16k(meetingId, mono16k);

        // 3. Energy VAD: find speech regions and accumulate into ~27s batches.
        // Timestamps from energyVAD are in seconds at 16 kHz — these become the
        // VadInterval wall-clock positions used for transcript timestamp mapping.
        const batchState = newVadBatchState();
        for (const { audio, start, end } of energyVAD(mono16k, 16_000)) {
          const wavOffset   = batchState.pendingWavDuration;
          const wavDuration = audio.length / 16_000;
          batchState.pendingAudio.push(audio);
          batchState.pendingIntervals.push({ originalStart: start, originalEnd: end, wavOffset, wavDuration });
          batchState.pendingWavDuration += wavDuration;
          if (batchState.pendingWavDuration >= BATCH_DURATION_S) sealCurrentBatch(batchState);
        }
        sealCurrentBatch(batchState);

        // 4. Transcribe all batches in parallel
        setPhase('transcribing');
        const batches = batchState.readyBatches;
        const totalSeconds = batches.reduce((s, b) => s + b.totalWavDuration, 0);
        setBatchProgress({ completed: 0, total: batches.length, completedSeconds: 0, totalSeconds });

        let done = 0;
        let completedSeconds = 0;
        const tasks = batches.map((batch) => async (): Promise<TranscriptSegment[]> => {
          try {
            const fd = new FormData();
            fd.append('audio', batch.wav, 'batch.wav');
            const res = await fetch(`/api/meetings/${meetingId}/utterance`, {
              method: 'POST',
              body: fd,
              signal: AbortSignal.timeout(60_000),
            });
            if (!res.ok) return [];
            const { text } = await res.json() as { text: string };
            return text?.trim() ? splitTextWithIntervals(text, batch.intervals, batch.totalWavDuration) : [];
          } catch (err) {
            console.error('[ProcessingTranscription] batch failed:', err);
            return [];
          } finally {
            completedSeconds += batch.totalWavDuration;
            setBatchProgress({ completed: ++done, total: batches.length, completedSeconds, totalSeconds });
          }
        });

        const segmentArrays = await runWithConcurrency(tasks, BATCH_CONCURRENCY);
        const sorted = segmentArrays.flat().sort((a, b) => a.start - b.start);

        // 5. Merge speaker labels from the diarization pass (started above, in parallel).
        setPhase('diarizing');
        const turns = await diarizationPromise;
        const segments = assignSpeakers(sorted, turns);

        // 6. Save transcript to IndexedDB and advance to review
        setPhase('saving');
        const rawText = segments.map((s) => s.text).join(' ');
        await saveTranscript(meetingId, { rawText, segments, chapters: [], piiReplacements: [] });
        await updateMeeting(meetingId, { status: 'review' });

        onComplete?.();
      } catch (err) {
        console.error('[ProcessingTranscription]', err);
        setError(err instanceof Error ? err.message : 'Transskription fejlede');
        setPhase('error');
      }
    }
  }, [meetingId, retryCount]);

  const pct = batchProgress && batchProgress.totalSeconds > 0
    ? Math.min(100, Math.round((batchProgress.completedSeconds / batchProgress.totalSeconds) * 100))
    : 0;

  const phaseLabels: Record<Phase, string> = {
    downloading: 'henter lydfil…',
    analyzing: 'analyserer og opdeler tale…',
    transcribing: batchProgress && batchProgress.total > 0
      ? `transskriberer ${batchProgress.completed} / ${batchProgress.total} segmenter…`
      : 'transskriberer…',
    diarizing: 'genkender talere…',
    saving: 'gemmer transskription…',
    error: '',
  };
  const label = phaseLabels[phase];

  if (phase === 'error') {
    return (
      <div className="mx-auto max-w-[720px] px-6 py-12">
        <h1 className="text-xl font-semibold text-[var(--ink)]">Transskription fejlede</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">{error}</p>
        <button
          onClick={() => { setPhase('downloading'); setError(null); setBatchProgress(null); setRetryCount(c => c + 1); }}
          style={{
            marginTop: 16, padding: '8px 16px', borderRadius: 8,
            background: 'var(--ink)', color: 'var(--bg)', border: 'none',
            fontSize: 13, cursor: 'pointer', fontFamily: 'var(--mono)',
          }}
        >
          Prøv igen
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[720px] px-6 py-12">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{
          width: 8, height: 8, borderRadius: 999, background: 'var(--accent)', flexShrink: 0,
          animation: 'processingPulse 1.4s ease-in-out infinite',
        }} />
        <h1 className="text-xl font-semibold text-[var(--ink)]">Transskription er i gang…</h1>
      </div>
      <p className="mt-2 text-sm text-[var(--muted)]">
        Lydfilen analyseres og transskriberes. Vent venligst.
      </p>
      <div style={{ marginTop: 20, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 7 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{
              display: 'inline-block', width: 11, height: 11, borderRadius: 999, flexShrink: 0,
              border: '2px solid var(--accent)', borderTopColor: 'transparent',
              animation: 'spin 0.8s linear infinite',
            }} />
            <span>{label}</span>
          </div>
          {batchProgress && batchProgress.total > 0 && (
            <span style={{ color: 'var(--accent)', fontWeight: 500 }}>{pct}%</span>
          )}
        </div>
        <div style={{ height: 3, borderRadius: 999, background: 'var(--line)', overflow: 'hidden' }}>
          <div style={{
            height: '100%', borderRadius: 999, background: 'var(--accent)',
            width: phase === 'downloading' || phase === 'analyzing' ? '0%'
              : phase === 'saving' ? '100%'
              : `${pct}%`,
            transition: 'width 0.5s ease-out',
          }} />
        </div>
      </div>
      <style>{`
        @keyframes processingPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
