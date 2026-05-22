'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { VolumeBar } from './VolumeBar';
import { formatDuration, formatFileSize } from '@/lib/utils';

interface RecordingScreenProps {
  meetingId: string;
}

type RecordingState = 'idle' | 'recording' | 'paused' | 'stopped';

const BYTES_PER_SECOND_ESTIMATE = 16_000; // ~16 KB/s for webm/opus
const SILENCE_THRESHOLD_SECONDS = 5;
const SILENCE_VOLUME_THRESHOLD = 0.02;

export function RecordingScreen({ meetingId }: RecordingScreenProps) {
  const router = useRouter();
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [volumeLevel, setVolumeLevel] = useState(0);
  const [showSilenceWarning, setShowSilenceWarning] = useState(false);
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const silenceTimerRef = useRef<number>(0);
  const animFrameRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);
  const pausedDurationRef = useRef<number>(0);
  const pauseStartRef = useRef<number>(0);

  // Volume polling via AnalyserNode
  const pollVolume = useCallback(() => {
    if (!analyserRef.current) return;
    const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
    analyserRef.current.getByteTimeDomainData(dataArray);
    let sum = 0;
    for (const v of dataArray) {
      const normalized = v / 128 - 1;
      sum += normalized * normalized;
    }
    const rms = Math.sqrt(sum / dataArray.length);
    setVolumeLevel(Math.min(1, rms * 4));

    if (rms < SILENCE_VOLUME_THRESHOLD) {
      silenceTimerRef.current += 1 / 60;
      if (silenceTimerRef.current >= SILENCE_THRESHOLD_SECONDS) {
        setShowSilenceWarning(true);
      }
    } else {
      silenceTimerRef.current = 0;
      setShowSilenceWarning(false);
    }

    animFrameRef.current = requestAnimationFrame(pollVolume);
  }, []);

  async function startRecording() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Set up audio analyser
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      audioContextRef.current = ctx;
      analyserRef.current = analyser;

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.start(1000); // collect chunks every second
      startTimeRef.current = Date.now();
      pausedDurationRef.current = 0;

      setRecordingState('recording');
      setElapsed(0);

      timerRef.current = setInterval(() => {
        setElapsed(
          Math.floor((Date.now() - startTimeRef.current - pausedDurationRef.current) / 1000),
        );
      }, 500);

      animFrameRef.current = requestAnimationFrame(pollVolume);
    } catch {
      setError('Kunne ikke få adgang til mikrofonen. Tjek at tilladelsen er givet i browseren.');
    }
  }

  function pauseRecording() {
    if (!mediaRecorderRef.current) return;
    mediaRecorderRef.current.pause();
    pauseStartRef.current = Date.now();
    setRecordingState('paused');
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    setVolumeLevel(0);
  }

  function resumeRecording() {
    if (!mediaRecorderRef.current) return;
    mediaRecorderRef.current.resume();
    pausedDurationRef.current += Date.now() - pauseStartRef.current;
    setRecordingState('recording');
    animFrameRef.current = requestAnimationFrame(pollVolume);
  }

  async function stopAndSave() {
    if (!mediaRecorderRef.current) return;

    const recorder = mediaRecorderRef.current;
    if (timerRef.current) clearInterval(timerRef.current);
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);

    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      recorder.stop();
    });

    recorder.stream.getTracks().forEach((t) => t.stop());
    audioContextRef.current?.close();

    setRecordingState('stopped');
    setIsUploading(true);

    try {
      const mimeType = recorder.mimeType || 'audio/webm';
      const blob = new Blob(chunksRef.current, { type: mimeType });
      const formData = new FormData();
      formData.append('audio', blob, `recording.${mimeType.includes('mp4') ? 'm4a' : 'webm'}`);
      formData.append('meetingId', meetingId);
      formData.append('duration', String(elapsed));

      const res = await fetch('/api/transcribe', { method: 'POST', body: formData });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? 'Upload fejlede');
      }

      router.push(`/meeting/${meetingId}/review`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Noget gik galt under upload');
      setIsUploading(false);
      setRecordingState('stopped');
    }
  }

  async function cancelRecording() {
    if (mediaRecorderRef.current) {
      if (timerRef.current) clearInterval(timerRef.current);
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach((t) => t.stop());
      audioContextRef.current?.close();
    }
    // Delete the meeting
    await fetch(`/api/meetings/${meetingId}`, { method: 'DELETE' });
    router.push('/');
  }

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, []);

  const estimatedSize = elapsed * BYTES_PER_SECOND_ESTIMATE;

  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;
  const elapsedFormatted = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

  return (
    <div className="mx-auto max-w-[720px] px-6 py-12">
      {/* Error */}
      {error && (
        <div
          className="mb-8 rounded-[var(--radius)] border px-4 py-3 text-sm text-[var(--danger)]"
          style={{ backgroundColor: 'var(--danger-wash)', borderColor: 'var(--danger)' }}
        >
          {error}
        </div>
      )}

      {/* Header row: timer + file info left; volume meter right */}
      <div className="flex items-end justify-between mb-10">
        <div>
          <span
            className="text-[var(--ink)] tabular-nums"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '56px',
              fontWeight: 500,
              lineHeight: 1,
              letterSpacing: '-0.03em',
            }}
          >
            {elapsedFormatted}
          </span>
          <p
            className="mt-1 text-[var(--muted)]"
            style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--t-micro)' }}
          >
            {elapsed > 0 ? `${formatFileSize(estimatedSize)} · webm/opus` : 'Klar til optagelse'}
          </p>
        </div>
        <VolumeBar level={recordingState === 'recording' ? volumeLevel : 0} barCount={24} />
      </div>

      {/* Silence warning — inline amber stripe */}
      {showSilenceWarning && recordingState === 'recording' && (
        <div
          className="mb-6 rounded-[var(--radius-sm)] px-3 py-2 text-sm text-[var(--ink-2)]"
          style={{ backgroundColor: 'color-mix(in oklch, var(--warn) 10%, white)', borderLeft: '3px solid var(--warn)' }}
        >
          Vi kan ikke høre noget — er mikrofonen tændt?
        </div>
      )}

      {/* Controls row */}
      <div className="flex items-center justify-center gap-6 mb-8">
        {recordingState === 'idle' && (
          <button
            onClick={startRecording}
            style={{
              width: 72, height: 72, borderRadius: '50%',
              backgroundColor: 'var(--ink)', border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
            aria-label="Start optagelse"
          >
            <span style={{ width: 22, height: 22, borderRadius: '50%', backgroundColor: 'white', display: 'block' }} />
          </button>
        )}

        {(recordingState === 'recording' || recordingState === 'paused') && (
          <>
            <Button
              variant="outline"
              onClick={recordingState === 'recording' ? pauseRecording : resumeRecording}
              style={{ height: 44, minWidth: 90 }}
            >
              {recordingState === 'recording' ? 'Pause' : 'Fortsæt'}
            </Button>

            {/* Primary circular stop button */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
              <button
                onClick={stopAndSave}
                style={{
                  width: 72, height: 72, borderRadius: '50%',
                  backgroundColor: 'var(--ink)', border: 'none', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
                aria-label="Stop og gem"
              >
                <span style={{ width: 18, height: 18, backgroundColor: 'white', borderRadius: 3, display: 'block' }} />
              </button>
              <span style={{ fontSize: 'var(--t-micro)', color: 'var(--muted)' }}>Stop &amp; gem</span>
            </div>
          </>
        )}

        {(recordingState === 'stopped' || isUploading) && (
          <div className="flex items-center gap-2 text-sm text-[var(--muted)]">
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
            {isUploading ? 'Uploader og transskriberer…' : 'Behandler…'}
          </div>
        )}
      </div>

      {/* Tab-switch reassurance */}
      {(recordingState === 'recording' || recordingState === 'paused') && (
        <p className="text-center text-[var(--muted)] mb-8" style={{ fontSize: 'var(--t-small)' }}>
          Du kan trygt skifte fane. Optagelsen fortsætter.
        </p>
      )}

      {/* Cancel link */}
      {recordingState !== 'stopped' && !isUploading && (
        <div className="text-center mb-8">
          <button
            onClick={() => setShowCancelDialog(true)}
            className="text-[var(--muted)] hover:text-[var(--danger)] underline underline-offset-2 transition-colors"
            style={{ fontSize: 'var(--t-small)' }}
          >
            Annullér og slet
          </button>
        </div>
      )}

      {/* Compliance footer */}
      <p
        className="text-center text-[var(--muted)]"
        style={{ fontSize: 'var(--t-micro)', fontFamily: 'var(--font-mono)' }}
      >
        Lyden slettes automatisk efter 14 dage · PII fjernes inden referatet udarbejdes
      </p>

      {/* Cancel confirm dialog */}
      <Dialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Annullér optagelse?</DialogTitle>
            <DialogDescription>
              Optagelsen og mødet slettes permanent. Denne handling kan ikke fortrydes.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setShowCancelDialog(false)}>
              Tilbage
            </Button>
            <Button variant="destructive" onClick={cancelRecording}>
              Slet og annullér
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
