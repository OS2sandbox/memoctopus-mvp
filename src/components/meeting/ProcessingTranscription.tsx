'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  newVadBatchState, sealCurrentBatch, splitTextWithIntervals,
  runWithConcurrency, BATCH_DURATION_S, BATCH_CONCURRENCY,
} from '@/lib/audio/vad-batch';
import type { TranscriptSegment } from '@/types';

interface Props {
  meetingId: string;
}

type Phase = 'downloading' | 'analyzing' | 'transcribing' | 'saving' | 'error';

interface BatchProgress {
  completed: number;
  total: number;
  completedSeconds: number;
  totalSeconds: number;
}

// Simple energy-based VAD. Avoids onnxruntime-web entirely — no WASM, no
// dynamic module imports, no asset path issues in Next.js.
// Yields speech segments as Float32Array slices at the input sample rate,
// with start/end in seconds relative to the original audio timeline.
function* energyVAD(
  audio: Float32Array,
  sampleRate: number,
): Generator<{ audio: Float32Array; start: number; end: number }> {
  const frameSamples   = Math.round(sampleRate * 0.03);   // 30ms per frame
  const threshold      = 0.01;                             // RMS speech threshold
  const prePad         = Math.round(sampleRate * 0.25);   // 250ms pre-roll
  const postPad        = Math.round(sampleRate * 0.40);   // 400ms post-roll
  const minSpeech      = Math.round(sampleRate * 0.10);   // 100ms min speech
  const minSilFrames   = Math.ceil(sampleRate * 0.80 / frameSamples); // 800ms silence to close

  const numFrames = Math.ceil(audio.length / frameSamples);
  const isSpeech: boolean[] = new Array(numFrames);
  for (let i = 0; i < numFrames; i++) {
    const s = i * frameSamples;
    const e = Math.min(s + frameSamples, audio.length);
    let sum = 0;
    for (let j = s; j < e; j++) sum += audio[j] * audio[j];
    isSpeech[i] = Math.sqrt(sum / (e - s)) >= threshold;
  }

  let segStart = -1;
  let silFrames = 0;

  for (let i = 0; i < numFrames; i++) {
    if (isSpeech[i]) {
      if (segStart === -1) segStart = i;
      silFrames = 0;
    } else if (segStart !== -1) {
      if (++silFrames >= minSilFrames) {
        const from = Math.max(0, segStart * frameSamples - prePad);
        const to   = Math.min(audio.length, (i - silFrames) * frameSamples + postPad);
        if (to - from >= minSpeech) {
          yield { audio: audio.slice(from, to), start: from / sampleRate, end: to / sampleRate };
        }
        segStart = -1;
        silFrames = 0;
      }
    }
  }

  if (segStart !== -1) {
    const from = Math.max(0, segStart * frameSamples - prePad);
    const to   = Math.min(audio.length, audio.length + postPad);
    if (to - from >= minSpeech) {
      yield { audio: audio.slice(from, to), start: from / sampleRate, end: to / sampleRate };
    }
  }
}

// Resample a mono Float32Array to 16 kHz using OfflineAudioContext.
async function resampleTo16k(audio: Float32Array, fromRate: number): Promise<Float32Array> {
  if (fromRate === 16_000) return audio;
  const length = Math.ceil(audio.length * 16_000 / fromRate);
  const offCtx = new OfflineAudioContext({ numberOfChannels: 1, length, sampleRate: 16_000 });
  const buf = offCtx.createBuffer(1, audio.length, fromRate);
  buf.getChannelData(0).set(audio);
  const src = offCtx.createBufferSource();
  src.buffer = buf;
  src.connect(offCtx.destination);
  src.start();
  const out = await offCtx.startRendering();
  return out.getChannelData(0);
}

export function ProcessingTranscription({ meetingId }: Props) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('downloading');
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const didStart = useRef(false);

  useEffect(() => {
    if (didStart.current) return;
    didStart.current = true;
    void run();

    async function run() {
      try {
        // 1. Download the archived audio
        setPhase('downloading');
        const audioRes = await fetch(`/api/meetings/${meetingId}/audio`);
        if (!audioRes.ok) throw new Error(`Lydfil ikke fundet (${audioRes.status})`);
        const arrayBuffer = await audioRes.arrayBuffer();

        // 2. Decode and downmix to mono at native rate, then resample to 16 kHz
        setPhase('analyzing');
        const audioCtx = new AudioContext();
        const decoded = await audioCtx.decodeAudioData(arrayBuffer);
        await audioCtx.close();

        let nativeMono: Float32Array;
        if (decoded.numberOfChannels === 1) {
          nativeMono = decoded.getChannelData(0);
        } else {
          nativeMono = new Float32Array(decoded.length);
          for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
            const chData = decoded.getChannelData(ch);
            for (let i = 0; i < nativeMono.length; i++) nativeMono[i] += chData[i];
          }
          const scale = 1 / decoded.numberOfChannels;
          for (let i = 0; i < nativeMono.length; i++) nativeMono[i] *= scale;
        }

        // Resample to 16 kHz so VAD segments are already at the right rate for
        // float32ToWavBlob (which writes a 16 kHz WAV header).
        const mono16k = await resampleTo16k(nativeMono, decoded.sampleRate);

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
        const segments = segmentArrays.flat().sort((a, b) => a.start - b.start);

        // 5. Save transcript
        setPhase('saving');
        const saveRes = await fetch(`/api/meetings/${meetingId}/save-transcript`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ segments }),
        });
        if (!saveRes.ok) throw new Error('Gem fejlede');

        router.refresh();
      } catch (err) {
        console.error('[ProcessingTranscription]', err);
        setError(err instanceof Error ? err.message : 'Transskription fejlede');
        setPhase('error');
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId]);

  const pct = batchProgress && batchProgress.totalSeconds > 0
    ? Math.min(100, Math.round((batchProgress.completedSeconds / batchProgress.totalSeconds) * 100))
    : 0;

  const label = phase === 'downloading' ? 'henter lydfil…'
    : phase === 'analyzing' ? 'analyserer og opdeler tale…'
    : phase === 'saving' ? 'gemmer transskription…'
    : batchProgress && batchProgress.total > 0
      ? `transskriberer ${batchProgress.completed} / ${batchProgress.total} segmenter…`
      : 'transskriberer…';

  if (phase === 'error') {
    return (
      <div className="mx-auto max-w-[720px] px-6 py-12">
        <h1 className="text-xl font-semibold text-[var(--ink)]">Transskription fejlede</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">{error}</p>
        <button
          onClick={() => { didStart.current = false; setPhase('downloading'); setError(null); setBatchProgress(null); }}
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
