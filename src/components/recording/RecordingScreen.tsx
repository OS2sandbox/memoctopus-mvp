'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
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
import { useIsMobile } from '@/lib/use-is-mobile';
import { pickRecordingMimeType, extensionForMimeType } from '@/lib/audio/recording-format';
import { RealtimeTranscriptionStream } from '@/lib/audio/realtime-stream';
import { saveAudio, deleteAudio, saveTranscript, updateMeeting } from '@/lib/storage';
import type { TranscriptSegment, PiiReplacement } from '@/types';
import type { TranscriptChapter } from '@/lib/ai/chapters';

interface LiveSegment {
  speaker: string;
  start: number;
  end: number;
  text: string;
}

interface ClarificationItem {
  question: string;
  context?: string;
}

interface RecordingScreenProps {
  meetingId: string;
  existingRecording?: { durationSeconds: number | null; sizeBytes: number };
  onNavigateToReview?: () => void;
  onRecordingComplete?: () => void;
}

type RecordingState = 'idle' | 'recording' | 'paused' | 'stopped';

const BYTES_PER_SECOND_ESTIMATE = 16_000;
const SILENCE_THRESHOLD_SECONDS = 5;
const SILENCE_VOLUME_THRESHOLD = 0.02;
const CLARIFY_INTERVAL_MS = 25_000;
const CLARIFY_TICK_MS = 250;

export function RecordingScreen({ meetingId, existingRecording, onNavigateToReview, onRecordingComplete }: RecordingScreenProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isMobile = useIsMobile();
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [volumeLevel, setVolumeLevel] = useState(0);
  const [showSilenceWarning, setShowSilenceWarning] = useState(false);
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [showOverwriteDialog, setShowOverwriteDialog] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isOverwriting, setIsOverwriting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveCaptionsUnavailable, setLiveCaptionsUnavailable] = useState(false);
  const [isDiarizing, setIsDiarizing] = useState(false);

  const [liveSegments, setLiveSegments] = useState<LiveSegment[]>([]);
  const [interimText, setInterimText] = useState('');
  const [clarifications, setClarifications] = useState<ClarificationItem[]>([]);
  const [clarifyRemaining, setClarifyRemaining] = useState(1);
  const liveSegmentsRef = useRef<LiveSegment[]>([]);
  const mimeTypeRef = useRef('audio/webm');
  const clarifyTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const nextClarifyAtRef = useRef<number>(0);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  const interimTextRef = useRef('');
  const recordingActiveRef = useRef(false);
  const streamRef = useRef<RealtimeTranscriptionStream | null>(null);
  const utteranceStartRef = useRef<number | null>(null);

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
      if (silenceTimerRef.current >= SILENCE_THRESHOLD_SECONDS) setShowSilenceWarning(true);
    } else {
      silenceTimerRef.current = 0;
      setShowSilenceWarning(false);
    }
    animFrameRef.current = requestAnimationFrame(pollVolume);
  }, []);

  function resetLiveState() {
    liveSegmentsRef.current = [];
    setLiveSegments([]);
    interimTextRef.current = '';
    setInterimText('');
    utteranceStartRef.current = null;
    setLiveCaptionsUnavailable(false);
    setIsDiarizing(false);
    setClarifications([]);
    setClarifyRemaining(1);
  }

  function currentElapsed(): number {
    return Math.max(0, (Date.now() - startTimeRef.current - pausedDurationRef.current) / 1000);
  }

  async function startRealtime(stream: MediaStream) {
    const ctl = new RealtimeTranscriptionStream(meetingId, {
      onPartial: (text) => {
        setLiveCaptionsUnavailable(false);
        if (interimTextRef.current === '' && utteranceStartRef.current === null) {
          utteranceStartRef.current = currentElapsed();
        }
        interimTextRef.current = text;
        setInterimText(text);
        setTimeout(() => transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
      },
      onCommitted: (text) => {
        setLiveCaptionsUnavailable(false);
        const seg: LiveSegment = {
          speaker: '—',
          start: utteranceStartRef.current ?? currentElapsed(),
          end: currentElapsed(),
          text,
        };
        utteranceStartRef.current = null;
        interimTextRef.current = '';
        setInterimText('');
        liveSegmentsRef.current = [...liveSegmentsRef.current, seg];
        setLiveSegments([...liveSegmentsRef.current]);
        setTimeout(() => transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
      },
      onError: () => { setLiveCaptionsUnavailable(true); },
    });
    streamRef.current = ctl;
    await ctl.start(stream);
  }

  function flushRecorder(recorder: MediaRecorder): Promise<void> {
    if (recorder.state !== 'recording') return Promise.resolve();
    return new Promise<void>((resolve) => {
      const onData = () => { recorder.removeEventListener('dataavailable', onData); resolve(); };
      recorder.addEventListener('dataavailable', onData);
      recorder.requestData();
    });
  }

  async function diarizeSoFar(recorder: MediaRecorder) {
    setIsDiarizing(true);
    try {
      const mimeType = recorder.mimeType || mimeTypeRef.current;
      const blob = new Blob(chunksRef.current, { type: mimeType });
      if (blob.size < 10_000) return;
      const formData = new FormData();
      formData.append('audio', blob, `segment.${extensionForMimeType(mimeType)}`);
      const res = await fetch(`/api/meetings/${meetingId}/live-transcribe`, { method: 'POST', body: formData });
      if (!res.ok) return;
      const data = await res.json() as { segments: LiveSegment[]; text: string };
      if (data.segments?.length) {
        liveSegmentsRef.current = data.segments;
        setLiveSegments(data.segments);
        interimTextRef.current = '';
        setInterimText('');
        utteranceStartRef.current = null;
      }
    } catch (err) {
      console.error('[diarize] failed:', err);
    } finally {
      setIsDiarizing(false);
    }
  }

  async function refreshClarifications() {
    if (liveSegmentsRef.current.length === 0) return;
    const text = liveSegmentsRef.current.map((s) => s.text).join(' ');
    try {
      const res = await fetch(`/api/meetings/${meetingId}/clarifications`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: text }),
      });
      if (!res.ok) return;
      const data = await res.json() as { clarifications?: ClarificationItem[] };
      setClarifications(data.clarifications ?? []);
    } catch (err) {
      console.error('[clarifications] refresh failed:', err);
    }
  }

  function startClarifyTimer() {
    nextClarifyAtRef.current = Date.now() + CLARIFY_INTERVAL_MS;
    setClarifyRemaining(1);
    clarifyTickRef.current = setInterval(() => {
      const remaining = nextClarifyAtRef.current - Date.now();
      if (remaining <= 0) {
        nextClarifyAtRef.current = Date.now() + CLARIFY_INTERVAL_MS;
        setClarifyRemaining(1);
        void refreshClarifications();
      } else {
        setClarifyRemaining(remaining / CLARIFY_INTERVAL_MS);
      }
    }, CLARIFY_TICK_MS);
  }

  function stopClarifyTimer() {
    if (clarifyTickRef.current) clearInterval(clarifyTickRef.current);
    clarifyTickRef.current = null;
  }

  async function startRecording() {
    setError(null);
    resetLiveState();
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      try {
        const ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(stream).connect(analyser);
        audioContextRef.current = ctx;
        analyserRef.current = analyser;
        await ctx.resume();
        ctx.onstatechange = () => {
          if (ctx.state === 'suspended' && recordingActiveRef.current) void ctx.resume();
        };
      } catch (audioErr) {
        console.warn('[startRecording] AudioContext unavailable:', audioErr);
        audioContextRef.current = null;
        analyserRef.current = null;
      }

      const mimeType = pickRecordingMimeType();
      mimeTypeRef.current = mimeType || 'audio/webm';

      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.start(1000);
      startTimeRef.current = Date.now();
      pausedDurationRef.current = 0;
      recordingActiveRef.current = true;
      setRecordingState('recording');
      setElapsed(0);

      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startTimeRef.current - pausedDurationRef.current) / 1000));
      }, 500);

      animFrameRef.current = requestAnimationFrame(pollVolume);
      startClarifyTimer();

      void startRealtime(stream);
    } catch (err) {
      stream?.getTracks().forEach((t) => t.stop());
      audioContextRef.current?.close();
      audioContextRef.current = null;
      analyserRef.current = null;
      console.error('[startRecording]', err);

      if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) {
        setError('Mikrofonens tilladelse er afvist. Tillad adgang i browserens adresselinje og prøv igen.');
      } else if (err instanceof DOMException && (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError')) {
        setError('Ingen mikrofon fundet. Er en mikrofon tilsluttet? På Mac: kør "sudo killall coreaudiod" i Terminal og prøv igen.');
      } else {
        setError(`Optagelse fejlede: ${err instanceof Error ? err.message : String(err)}. Prøv at genindlæse siden.`);
      }
    }
  }

  async function pauseRecording() {
    if (!mediaRecorderRef.current) return;
    const recorder = mediaRecorderRef.current;
    pauseStartRef.current = Date.now();
    if (timerRef.current) clearInterval(timerRef.current);
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    stopClarifyTimer();
    setVolumeLevel(0);
    setIsDiarizing(true);
    setRecordingState('paused');

    await streamRef.current?.stop();
    streamRef.current = null;
    await flushRecorder(recorder);
    recorder.pause();
    void audioContextRef.current?.suspend();

    await diarizeSoFar(recorder);
  }

  async function resumeRecording() {
    if (!mediaRecorderRef.current) return;
    const recorder = mediaRecorderRef.current;
    await audioContextRef.current?.resume();
    recorder.resume();
    pausedDurationRef.current += Date.now() - pauseStartRef.current;
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current - pausedDurationRef.current) / 1000));
    }, 500);
    if (analyserRef.current) animFrameRef.current = requestAnimationFrame(pollVolume);
    startClarifyTimer();
    setRecordingState('recording');
    void startRealtime(recorder.stream);
  }

  const didAutostart = useRef(false);
  useEffect(() => {
    if (didAutostart.current) return;
    if (existingRecording) return;
    if (searchParams.get('autostart') === '1') {
      didAutostart.current = true;
      startRecording();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function clearIntervals() {
    if (timerRef.current) clearInterval(timerRef.current);
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    stopClarifyTimer();
  }

  async function stopAndSave() {
    if (!mediaRecorderRef.current) return;
    const recorder = mediaRecorderRef.current;
    recordingActiveRef.current = false;
    clearIntervals();
    await streamRef.current?.stop();
    streamRef.current = null;
    audioContextRef.current?.close();
    audioContextRef.current = null;

    if (recorder.state === 'paused') recorder.resume();

    await new Promise<void>((resolve) => {
      recorder.addEventListener('stop', () => resolve(), { once: true });
      recorder.stop();
    });
    recorder.stream.getTracks().forEach((t) => t.stop());

    setRecordingState('stopped');
    setIsUploading(true);

    const mimeType = recorder.mimeType || 'audio/webm';
    const blob = new Blob(chunksRef.current, { type: mimeType });

    // Store audio blob in IndexedDB first
    await saveAudio(meetingId, blob, mimeType);
    await updateMeeting(meetingId, {
      status: 'processing',
      audioSizeBytes: blob.size,
      audioDurationSeconds: elapsed > 0 ? elapsed : null,
    });

    try {
      const formData = new FormData();
      formData.append('audio', blob, `recording.${extensionForMimeType(mimeType)}`);
      formData.append('meetingId', meetingId);

      const res = await fetch('/api/transcribe', { method: 'POST', body: formData });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? 'Transskription fejlede');
      }

      const data = await res.json() as {
        segments: TranscriptSegment[];
        piiReplacements: PiiReplacement[];
        rawText: string;
        chapters: TranscriptChapter[];
      };

      await saveTranscript(meetingId, {
        rawText: data.rawText,
        segments: data.segments,
        chapters: data.chapters ?? [],
        piiReplacements: data.piiReplacements ?? [],
      });

      await updateMeeting(meetingId, { status: 'review' });
      onRecordingComplete?.();
      router.push(`/meeting/${meetingId}/review`);
    } catch (err) {
      // On failure: store empty transcript so user can see the review page
      await saveTranscript(meetingId, {
        rawText: '',
        segments: [],
        chapters: [],
        piiReplacements: [],
      });
      await updateMeeting(meetingId, { status: 'review' });
      setError(err instanceof Error ? err.message : 'Noget gik galt under behandling');
      onRecordingComplete?.();
      router.push(`/meeting/${meetingId}/review`);
    }
  }

  async function confirmOverwrite() {
    setIsOverwriting(true);
    await deleteAudio(meetingId);
    await updateMeeting(meetingId, { status: 'recording', audioDeleted: false, audioSizeBytes: 0, audioDurationSeconds: null });
    setShowOverwriteDialog(false);
    setIsOverwriting(false);
    startRecording();
  }

  async function cancelRecording() {
    if (mediaRecorderRef.current) {
      recordingActiveRef.current = false;
      clearIntervals();
      void streamRef.current?.stop();
      streamRef.current = null;
      audioContextRef.current?.close();
      audioContextRef.current = null;
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach((t) => t.stop());
    }
    // Import deleteMeeting lazily to avoid circular dep issues
    const { deleteMeeting } = await import('@/lib/storage');
    await deleteMeeting(meetingId);
    router.push('/dashboard');
  }

  useEffect(() => {
    return () => {
      recordingActiveRef.current = false;
      clearIntervals();
      void streamRef.current?.stop();
      streamRef.current = null;
      audioContextRef.current?.close();
      audioContextRef.current = null;
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      mediaRecorderRef.current?.stream.getTracks().forEach((t) => t.stop());
      mediaRecorderRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const estimatedSize = elapsed * BYTES_PER_SECOND_ESTIMATE;
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;
  const elapsedFormatted = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

  // ── Completed state ───────────────────────────────────────────────────────
  if (existingRecording && recordingState === 'idle') {
    const dur = existingRecording.durationSeconds;
    const durFormatted = dur != null ? formatDuration(dur) : null;

    return (
      <div style={{ minHeight: 'calc(100vh - 56px - 47px)', padding: isMobile ? '24px 20px 24px' : '32px 48px 24px', display: 'flex', flexDirection: 'column' }}>
        <div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', letterSpacing: 0.4 }}>01 · optagelse</div>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: isMobile ? 44 : 64, fontWeight: 500,
            letterSpacing: '-0.04em', color: 'var(--ink)',
            fontVariantNumeric: 'tabular-nums', lineHeight: 1, marginTop: 8,
          }}>
            {durFormatted ?? '—'}
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--ink-2)', marginTop: 6 }}>
            optagelse gemt · webm/opus · lokal
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 32 }}>
          <button
            onClick={() => onNavigateToReview?.()}
            style={{
              fontFamily: 'var(--mono)', fontSize: 13.5, fontWeight: 500,
              padding: '8px 14px', borderRadius: 'var(--radius)',
              background: 'var(--ink)', color: 'var(--bg)',
              border: '1px solid var(--ink)', cursor: 'pointer',
            }}
          >
            gå til gennemgang →
          </button>
          <button
            onClick={() => setShowOverwriteDialog(true)}
            style={{
              fontFamily: 'var(--mono)', fontSize: 13.5, fontWeight: 500,
              padding: '8px 14px', borderRadius: 'var(--radius)',
              border: '1px solid var(--line-2)', background: 'transparent',
              color: 'var(--ink)', cursor: 'pointer',
            }}
          >
            optag igen
          </button>
        </div>
        <Dialog open={showOverwriteDialog} onOpenChange={setShowOverwriteDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Optag igen?</DialogTitle>
              <DialogDescription>
                Den eksisterende optagelse og transskription overskrives.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setShowOverwriteDialog(false)} disabled={isOverwriting}>Annullér</Button>
              <Button variant="destructive" onClick={confirmOverwrite} disabled={isOverwriting}>
                {isOverwriting ? 'Forbereder…' : 'Ja, optag igen'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  // ── Active recording / idle ───────────────────────────────────────────────
  const uniqueSpeakers = Array.from(new Set(liveSegments.map((s) => s.speaker).filter((s) => s !== '—')));
  const speakerCount = (sp: string) => liveSegments.filter((s) => s.speaker === sp).length;
  const fmtSec = (s: number) => {
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };

  return (
    <div style={{ height: isMobile ? 'auto' : 'calc(100vh - 56px - 47px)', minHeight: isMobile ? 'calc(100vh - 56px - 47px)' : undefined, padding: isMobile ? '24px 20px 40px' : '32px 48px 64px', display: 'flex', flexDirection: 'column' }}>

      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: isMobile ? 16 : 28, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', letterSpacing: 0.4 }}>01 · optagelse</div>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: isMobile ? 44 : 64, fontWeight: 500,
            letterSpacing: '-0.04em', color: 'var(--ink)',
            fontVariantNumeric: 'tabular-nums', lineHeight: 1, marginTop: 8,
          }}>
            {elapsedFormatted}
          </div>
        </div>

        <div style={{ paddingBottom: 6 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', marginBottom: 8, letterSpacing: 0.4 }}>signal</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 30 }}>
            {Array.from({ length: isMobile ? 20 : 36 }).map((_, i) => {
              const barHeight = recordingState === 'recording'
                ? Math.max(4, Math.round(volumeLevel * 28 + Math.sin(i * 0.8 + elapsed) * 4))
                : 4;
              return <span key={i} style={{ width: 2, height: barHeight, background: 'var(--ink-2)', opacity: 0.8, display: 'block' }} />;
            })}
          </div>
        </div>

        <div style={{ marginLeft: 'auto', textAlign: 'right', paddingBottom: 6 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', letterSpacing: 0.4 }}>lagring</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--ink-2)', marginTop: 6 }}>
            {elapsed > 0 ? `${formatFileSize(estimatedSize)} · webm/opus · lokal` : 'klar til optagelse'}
          </div>
        </div>
      </div>

      {error && (
        <div style={{
          marginTop: 16, padding: '12px 16px', borderRadius: 'var(--radius)',
          background: 'var(--kill-wash)', borderLeft: '3px solid var(--kill)',
          fontSize: 13.5, color: 'var(--kill)',
        }}>
          {error}
        </div>
      )}

      {liveCaptionsUnavailable && (recordingState === 'recording' || recordingState === 'paused') && (
        <div style={{
          marginTop: 16, padding: '10px 14px', borderRadius: 'var(--radius)',
          borderLeft: '3px solid var(--accent)',
          background: 'var(--accent-wash)',
          fontSize: 13.5, color: 'var(--ink-2)',
        }}>
          Live-tekst er ikke tilgængelig lige nu. Optagelsen transskriberes fuldt ud, og talere genkendes, når du sætter på pause eller gemmer.
        </div>
      )}

      {showSilenceWarning && recordingState === 'recording' && (
        <div style={{
          marginTop: 16, padding: '10px 14px', borderRadius: 'var(--radius)',
          borderLeft: '3px solid var(--warn)',
          background: 'color-mix(in oklch, var(--warn) 10%, white)',
          fontSize: 13.5, color: 'var(--ink-2)',
        }}>
          Vi kan ikke høre noget — er mikrofonen tændt?
        </div>
      )}

      <div style={{
        marginTop: 28, display: 'grid',
        gridTemplateColumns: isMobile ? '1fr' : '1fr 280px',
        gap: isMobile ? 24 : 32, flex: 1,
        overflow: isMobile ? 'visible' : 'hidden',
        minHeight: isMobile ? 320 : undefined,
      }}>

        {/* Transcript stream */}
        <div style={{
          display: 'flex', flexDirection: 'column',
          border: '1px solid var(--line-2)', borderRadius: 'var(--radius)',
          background: 'var(--surface)', overflow: 'hidden',
        }}>
          <div style={{
            padding: '12px 18px', borderBottom: '1px solid var(--line)',
            display: 'flex', alignItems: 'center', gap: 12,
            fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted)',
          }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{
                width: 7, height: 7, borderRadius: 999, flexShrink: 0,
                background: recordingState === 'paused' ? 'var(--muted)' : (recordingState === 'recording' ? 'var(--keep)' : 'var(--muted-2)'),
                animation: (recordingState === 'recording' || isDiarizing) ? 'protoPulse 1.4s ease-in-out infinite' : 'none',
              }} />
              {isDiarizing ? 'finder talere…' : recordingState === 'recording' ? 'transskriberer live' : recordingState === 'paused' ? 'pause' : (isUploading ? 'behandler…' : 'klar')}
            </span>
            {recordingState === 'recording' && !isDiarizing && <span>· scribe v2 realtime</span>}
          </div>

          <div style={{
            flex: 1, overflow: 'auto', padding: '14px 0',
            maskImage: 'linear-gradient(to bottom, black 82%, transparent 100%)',
            WebkitMaskImage: 'linear-gradient(to bottom, black 82%, transparent 100%)',
          }}>
            {liveSegments.length === 0 && !interimText ? (
              <div style={{
                padding: '20px 18px', fontFamily: 'var(--mono)', fontSize: 12.5,
                color: 'var(--muted)', fontStyle: 'italic',
              }}>
                {recordingState === 'idle' ? (isUploading ? 'Behandler og transskriberer optagelse…' : 'Tryk optag for at starte…') : 'Lytter…'}
              </div>
            ) : (
              <>
                {liveSegments.map((seg, i) => {
                  const showSpeaker = seg.speaker !== '—';
                  return (
                    <div key={i} style={{
                      display: 'grid', gridTemplateColumns: isMobile ? '44px 64px 1fr 14px' : '60px 90px 1fr 20px',
                      gap: 12, padding: '5px 18px',
                      opacity: 0.5 + Math.min(0.5, i * 0.06),
                      fontFamily: 'var(--mono)', fontSize: 12.5, lineHeight: 1.65,
                    }}>
                      <span style={{ color: 'var(--accent)' }}>{fmtSec(seg.start)}</span>
                      <span style={{ color: 'var(--ink)', fontWeight: 500 }}>
                        {showSpeaker ? `${seg.speaker.toLowerCase()}:` : '·'}
                      </span>
                      <span style={{ color: 'var(--ink-2)' }}>{seg.text}</span>
                      <span style={{ color: 'var(--muted-2)', textAlign: 'right' }}>★</span>
                    </div>
                  );
                })}
                {interimText && recordingState === 'recording' && (
                  <div style={{
                    display: 'grid', gridTemplateColumns: isMobile ? '44px 64px 1fr 14px' : '60px 90px 1fr 20px',
                    gap: 12, padding: '5px 18px',
                    opacity: 0.75,
                    fontFamily: 'var(--mono)', fontSize: 12.5, lineHeight: 1.65,
                  }}>
                    <span style={{ color: 'var(--accent)' }}>{fmtSec(utteranceStartRef.current ?? elapsed)}</span>
                    <span style={{ color: 'var(--ink)', fontWeight: 500 }}>·</span>
                    <span style={{ color: 'var(--ink-2)', fontStyle: 'italic' }}>
                      {interimText}
                      <span style={{
                        display: 'inline-block', width: 7, height: 14,
                        background: 'var(--accent)', verticalAlign: 'middle', marginLeft: 3,
                        animation: 'protoBlink 0.9s steps(2) infinite',
                      }} />
                    </span>
                    <span />
                  </div>
                )}
                {!interimText && recordingState === 'recording' && liveSegments.length > 0 && (
                  <div style={{ padding: '2px 18px' }}>
                    <span style={{
                      display: 'inline-block', width: 7, height: 14,
                      background: 'var(--accent)', verticalAlign: 'middle',
                      animation: 'protoBlink 0.9s steps(2) infinite',
                    }} />
                  </div>
                )}
              </>
            )}
            <div ref={transcriptEndRef} />
          </div>
        </div>

        {/* Sidebar */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 28, paddingLeft: 8, overflow: 'auto' }}>

          {uniqueSpeakers.length > 0 && (
            <div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', letterSpacing: 0.4, marginBottom: 10 }}>
                talere · {uniqueSpeakers.length}
              </div>
              {uniqueSpeakers.map((sp) => (
                <div key={sp} style={{
                  padding: '8px 0', borderTop: '1px solid var(--line)',
                  display: 'flex', alignItems: 'center', gap: 10,
                }}>
                  <span style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--accent)', opacity: 0.7, flexShrink: 0 }} />
                  <span style={{ flex: 1, fontSize: 13.5, color: 'var(--ink)' }}>{sp}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--muted)' }}>{speakerCount(sp)}</span>
                </div>
              ))}
            </div>
          )}

          {(recordingState === 'recording' || clarifications.length > 0) && (
            <div>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10,
                fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', letterSpacing: 0.4,
              }}>
                <span style={{ flexShrink: 0 }}>afklar · live</span>
                {recordingState === 'recording' && (
                  <span
                    style={{ flex: 1, height: 2, background: 'var(--line)', borderRadius: 999, overflow: 'hidden' }}
                    aria-hidden
                  >
                    <span style={{
                      display: 'block', height: '100%',
                      width: `${Math.round(clarifyRemaining * 100)}%`,
                      background: 'var(--accent)', opacity: 0.6,
                      transition: 'width 0.25s linear',
                    }} />
                  </span>
                )}
              </div>
              {clarifications.length > 0 ? (
                clarifications.map((c, i) => (
                  <div key={i} style={{ padding: '8px 0', borderTop: '1px solid var(--line)' }}>
                    <div style={{ fontSize: 13, color: 'var(--ink)', lineHeight: 1.45 }}>{c.question}</div>
                    {c.context && (
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--muted)', marginTop: 3 }}>
                        {c.context}
                      </div>
                    )}
                  </div>
                ))
              ) : (
                <div style={{
                  padding: '8px 0', borderTop: '1px solid var(--line)',
                  fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)', fontStyle: 'italic',
                }}>
                  leder efter punkter at afklare…
                </div>
              )}
            </div>
          )}

        </div>
      </div>

      {/* Footer controls */}
      <div style={{
        marginTop: 20, paddingTop: 18, borderTop: '1px solid var(--line)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16,
        position: 'relative',
      }}>
        {recordingState === 'idle' && !isUploading && (
          <>
            <button
              onClick={startRecording}
              style={{
                width: 56, height: 56, borderRadius: 999,
                background: 'var(--ink)', border: 'none', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
              aria-label="Start optagelse"
            >
              <span style={{ width: 18, height: 18, borderRadius: 999, background: 'var(--bg)', display: 'block' }} />
            </button>
            <button
              onClick={() => setShowCancelDialog(true)}
              style={{
                fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted-2)',
                background: 'none', border: 'none', cursor: 'pointer',
                textDecoration: 'underline', textUnderlineOffset: 3,
                position: 'absolute', right: isMobile ? 16 : 48,
              }}
            >
              annullér
            </button>
          </>
        )}

        {(recordingState === 'recording' || recordingState === 'paused') && (
          <>
            <button
              onClick={() => setShowCancelDialog(true)}
              style={{
                fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted-2)',
                background: 'none', border: 'none', cursor: 'pointer',
                textDecoration: 'underline', textUnderlineOffset: 3,
                position: 'absolute', left: isMobile ? 16 : 48,
              }}
            >
              annullér
            </button>
            <button
              onClick={recordingState === 'recording' ? pauseRecording : resumeRecording}
              disabled={isDiarizing}
              aria-busy={isDiarizing}
              style={{
                width: 56, height: 56, borderRadius: 999,
                background: 'var(--ink)', border: 'none',
                cursor: isDiarizing ? 'default' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
              aria-label={isDiarizing ? 'Finder talere…' : recordingState === 'recording' ? 'Pause' : 'Fortsæt'}
            >
              {isDiarizing ? (
                <span style={{
                  display: 'inline-block', width: 20, height: 20, borderRadius: 999,
                  border: '2px solid var(--bg)', borderTopColor: 'transparent',
                  animation: 'spin 0.8s linear infinite',
                }} />
              ) : recordingState === 'recording' ? (
                <span style={{ display: 'flex', gap: 4 }}>
                  <span style={{ width: 4, height: 16, background: 'var(--bg)', borderRadius: 2 }} />
                  <span style={{ width: 4, height: 16, background: 'var(--bg)', borderRadius: 2 }} />
                </span>
              ) : (
                <span style={{
                  width: 0, height: 0,
                  borderTop: '8px solid transparent',
                  borderBottom: '8px solid transparent',
                  borderLeft: '14px solid var(--bg)',
                  marginLeft: 3,
                }} />
              )}
            </button>
            <button
              onClick={stopAndSave}
              style={{
                fontFamily: 'var(--mono)', fontSize: 13.5, fontWeight: 500,
                padding: '8px 14px', borderRadius: 'var(--radius)',
                border: '1px solid var(--line-2)', background: 'transparent',
                color: 'var(--ink)', cursor: 'pointer',
                position: 'absolute', right: isMobile ? 16 : 48,
              }}
            >
              gem &amp; fortsæt
            </button>
          </>
        )}

        {(recordingState === 'stopped' || isUploading) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--muted)' }}>
            <span style={{
              display: 'inline-block', width: 14, height: 14, borderRadius: 999,
              border: '2px solid var(--accent)', borderTopColor: 'transparent',
              animation: 'spin 0.8s linear infinite',
            }} />
            behandler og transskriberer…
          </div>
        )}
      </div>

      {/* Dialogs */}
      <Dialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Annullér optagelse?</DialogTitle>
            <DialogDescription>
              Optagelsen og mødet slettes permanent. Denne handling kan ikke fortrydes.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setShowCancelDialog(false)}>Tilbage</Button>
            <Button variant="destructive" onClick={cancelRecording}>Slet og annullér</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showOverwriteDialog} onOpenChange={setShowOverwriteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Optag igen?</DialogTitle>
            <DialogDescription>
              Den eksisterende optagelse og transskription overskrives.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowOverwriteDialog(false)} disabled={isOverwriting}>Annullér</Button>
            <Button variant="destructive" onClick={confirmOverwrite} disabled={isOverwriting}>
              {isOverwriting ? 'Forbereder…' : 'Ja, optag igen'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <style>{`
        @keyframes protoPulse { 0%,100%{opacity:1} 50%{opacity:.35} }
        @keyframes protoBlink { 0%,49%{opacity:1} 50%,100%{opacity:0} }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
