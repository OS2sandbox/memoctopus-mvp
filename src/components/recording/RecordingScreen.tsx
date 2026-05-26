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

interface LiveSegment {
  speaker: string;
  text: string;
}

interface TopicItem {
  topic: string;
  followUps: string[];
}

interface RecordingScreenProps {
  meetingId: string;
  existingRecording?: { durationSeconds: number | null; sizeBytes: number };
}

type RecordingState = 'idle' | 'recording' | 'paused' | 'stopped';

const BYTES_PER_SECOND_ESTIMATE = 16_000;
const SILENCE_THRESHOLD_SECONDS = 5;
const SILENCE_VOLUME_THRESHOLD = 0.02;
const LIVE_CHUNK_INTERVAL = 15_000;
const TOPIC_INTERVAL = 25_000;

export function RecordingScreen({ meetingId, existingRecording }: RecordingScreenProps) {
  const router = useRouter();
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [volumeLevel, setVolumeLevel] = useState(0);
  const [showSilenceWarning, setShowSilenceWarning] = useState(false);
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [showOverwriteDialog, setShowOverwriteDialog] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isOverwriting, setIsOverwriting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live transcription
  const [liveSegments, setLiveSegments] = useState<LiveSegment[]>([]);
  const [topics, setTopics] = useState<TopicItem[]>([]);
  const liveSegmentsRef = useRef<LiveSegment[]>([]);
  const headerChunkRef = useRef<Blob | null>(null);
  const lastChunkIndexRef = useRef(0);
  const mimeTypeRef = useRef('audio/webm');
  const chunkIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const topicIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

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
    setTopics([]);
    lastChunkIndexRef.current = 0;
    headerChunkRef.current = null;
  }

  async function sendLiveChunk() {
    const chunks = chunksRef.current;
    const from = lastChunkIndexRef.current;
    const newChunks = chunks.slice(from);
    if (newChunks.length < 5 || !headerChunkRef.current) return;
    lastChunkIndexRef.current = chunks.length;

    const parts = from === 0 ? newChunks : [headerChunkRef.current, ...newChunks];
    const blob = new Blob(parts, { type: mimeTypeRef.current });
    const ext = mimeTypeRef.current.includes('mp4') ? 'm4a' : 'webm';
    const form = new FormData();
    form.append('audio', blob, `live.${ext}`);

    try {
      const res = await fetch(`/api/meetings/${meetingId}/live-transcribe`, { method: 'POST', body: form });
      if (!res.ok) return;
      const data = await res.json() as { segments?: LiveSegment[] };
      const segs = data.segments ?? [];
      if (segs.length > 0) {
        liveSegmentsRef.current = [...liveSegmentsRef.current, ...segs];
        setLiveSegments([...liveSegmentsRef.current]);
        setTimeout(() => transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
      }
    } catch {}
  }

  async function refreshTopics() {
    if (liveSegmentsRef.current.length === 0) return;
    const text = liveSegmentsRef.current.map((s) => `[${s.speaker}]: ${s.text}`).join('\n');
    try {
      const res = await fetch(`/api/meetings/${meetingId}/topics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: text }),
      });
      if (!res.ok) return;
      const data = await res.json() as { topics?: TopicItem[] };
      setTopics(data.topics ?? []);
    } catch {}
  }

  async function startRecording() {
    setError(null);
    resetLiveState();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
      mimeTypeRef.current = mimeType;

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          if (chunksRef.current.length === 0) headerChunkRef.current = e.data;
          chunksRef.current.push(e.data);
        }
      };

      recorder.start(1000);
      startTimeRef.current = Date.now();
      pausedDurationRef.current = 0;
      setRecordingState('recording');
      setElapsed(0);

      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startTimeRef.current - pausedDurationRef.current) / 1000));
      }, 500);

      animFrameRef.current = requestAnimationFrame(pollVolume);
      chunkIntervalRef.current = setInterval(sendLiveChunk, LIVE_CHUNK_INTERVAL);
      topicIntervalRef.current = setInterval(refreshTopics, TOPIC_INTERVAL);
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

  function clearIntervals() {
    if (timerRef.current) clearInterval(timerRef.current);
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    if (chunkIntervalRef.current) clearInterval(chunkIntervalRef.current);
    if (topicIntervalRef.current) clearInterval(topicIntervalRef.current);
  }

  async function stopAndSave() {
    if (!mediaRecorderRef.current) return;
    const recorder = mediaRecorderRef.current;
    clearIntervals();

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

  async function confirmOverwrite() {
    setIsOverwriting(true);
    await fetch(`/api/meetings/${meetingId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'recording' }),
    });
    setShowOverwriteDialog(false);
    setIsOverwriting(false);
    startRecording();
  }

  async function cancelRecording() {
    if (mediaRecorderRef.current) {
      clearIntervals();
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach((t) => t.stop());
      audioContextRef.current?.close();
    }
    await fetch(`/api/meetings/${meetingId}`, { method: 'DELETE' });
    router.push('/');
  }

  useEffect(() => {
    return () => {
      clearIntervals();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const estimatedSize = elapsed * BYTES_PER_SECOND_ESTIMATE;
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;
  const elapsedFormatted = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

  const showLivePanel = recordingState === 'recording' || recordingState === 'paused' || liveSegments.length > 0;

  // ── Completed state (navigated back after recording) ─────────────────────────
  if (existingRecording && recordingState === 'idle') {
    const dur = existingRecording.durationSeconds;
    const durFormatted = dur != null ? formatDuration(dur) : null;
    const sizeFormatted = formatFileSize(existingRecording.sizeBytes);

    return (
      <div className="mx-auto max-w-[720px] px-6 py-12">
        <div className="mb-10">
          <p className="text-[var(--muted)] mb-1" style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--t-micro)' }}>
            Optagelse gemt
          </p>
          <span
            className="text-[var(--ink)] tabular-nums"
            style={{ fontFamily: 'var(--font-mono)', fontSize: '56px', fontWeight: 500, lineHeight: 1, letterSpacing: '-0.03em' }}
          >
            {durFormatted ?? '—'}
          </span>
          {sizeFormatted && (
            <p className="mt-1 text-[var(--muted)]" style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--t-micro)' }}>
              {sizeFormatted} · webm/opus
            </p>
          )}
        </div>

        <div className="flex items-center gap-3">
          <Button onClick={() => router.push(`/meeting/${meetingId}/review`)}>
            Gå til Gennemgang →
          </Button>
          <Button variant="outline" onClick={() => setShowOverwriteDialog(true)}>
            Optag igen
          </Button>
        </div>

        <p className="mt-12 text-center text-[var(--muted)]" style={{ fontSize: 'var(--t-micro)', fontFamily: 'var(--font-mono)' }}>
          Lyden slettes automatisk efter 14 dage · PII fjernes inden referatet udarbejdes
        </p>

        <Dialog open={showOverwriteDialog} onOpenChange={setShowOverwriteDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Optag igen?</DialogTitle>
              <DialogDescription>
                Den eksisterende optagelse og transskription overskrives. Eventuelt referat slettes ikke, men vil være baseret på den nye transskription.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setShowOverwriteDialog(false)} disabled={isOverwriting}>
                Annullér
              </Button>
              <Button variant="destructive" onClick={confirmOverwrite} disabled={isOverwriting}>
                {isOverwriting ? 'Forbereder…' : 'Ja, optag igen'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  // ── Active recording / idle ───────────────────────────────────────────────────
  return (
    <div className="mx-auto px-6 py-12" style={{ maxWidth: showLivePanel ? 1040 : 720 }}>
      <div className={showLivePanel ? 'flex gap-8 items-start' : ''}>

        {/* Controls — sticky left column when live, centered column when idle */}
        <div className={showLivePanel ? 'w-72 shrink-0 sticky top-6' : ''}>
          {error && (
            <div
              className="mb-8 rounded-[var(--radius)] border px-4 py-3 text-sm text-[var(--danger)]"
              style={{ backgroundColor: 'var(--danger-wash)', borderColor: 'var(--danger)' }}
            >
              {error}
            </div>
          )}

          <div className="flex items-end justify-between mb-10">
            <div>
              <span
                className="text-[var(--ink)] tabular-nums"
                style={{ fontFamily: 'var(--font-mono)', fontSize: '56px', fontWeight: 500, lineHeight: 1, letterSpacing: '-0.03em' }}
              >
                {elapsedFormatted}
              </span>
              <p className="mt-1 text-[var(--muted)]" style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--t-micro)' }}>
                {elapsed > 0 ? `${formatFileSize(estimatedSize)} · webm/opus` : 'Klar til optagelse'}
              </p>
            </div>
            <VolumeBar level={recordingState === 'recording' ? volumeLevel : 0} barCount={24} />
          </div>

          {showSilenceWarning && recordingState === 'recording' && (
            <div
              className="mb-6 rounded-[var(--radius-sm)] px-3 py-2 text-sm text-[var(--ink-2)]"
              style={{ backgroundColor: 'color-mix(in oklch, var(--warn) 10%, white)', borderLeft: '3px solid var(--warn)' }}
            >
              Vi kan ikke høre noget — er mikrofonen tændt?
            </div>
          )}

          <div className="flex items-center justify-center gap-6 mb-8">
            {recordingState === 'idle' && (
              <button
                onClick={startRecording}
                style={{ width: 72, height: 72, borderRadius: '50%', backgroundColor: 'var(--ink)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                aria-label="Start optagelse"
              >
                <span style={{ width: 22, height: 22, borderRadius: '50%', backgroundColor: 'white', display: 'block' }} />
              </button>
            )}

            {(recordingState === 'recording' || recordingState === 'paused') && (
              <>
                <Button variant="outline" onClick={recordingState === 'recording' ? pauseRecording : resumeRecording} style={{ height: 44, minWidth: 90 }}>
                  {recordingState === 'recording' ? 'Pause' : 'Fortsæt'}
                </Button>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                  <button
                    onClick={stopAndSave}
                    style={{ width: 72, height: 72, borderRadius: '50%', backgroundColor: 'var(--ink)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
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

          {(recordingState === 'recording' || recordingState === 'paused') && (
            <p className="text-center text-[var(--muted)] mb-8" style={{ fontSize: 'var(--t-small)' }}>
              Du kan trygt skifte fane. Optagelsen fortsætter.
            </p>
          )}

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

          <p className="text-center text-[var(--muted)]" style={{ fontSize: 'var(--t-micro)', fontFamily: 'var(--font-mono)' }}>
            Lyden slettes automatisk efter 14 dage · PII fjernes inden referatet udarbejdes
          </p>
        </div>

        {/* Right column: topics at top, transcript below */}
        {showLivePanel && (
          <div className="flex-1 min-w-0">
            {/* Topics — always at the top of this column */}
            <div className="mb-4">
              <p className="font-medium text-[var(--ink)] mb-2" style={{ fontSize: 'var(--t-small)' }}>
                Mødeoverblik
              </p>
              <div className="border border-[var(--line)] rounded-[var(--radius)] bg-[var(--surface)] overflow-hidden">
                {topics.length === 0 ? (
                  <p className="text-[var(--muted)] italic px-4 py-3" style={{ fontSize: 'var(--t-small)', fontFamily: 'var(--font-mono)' }}>
                    Lytter…
                  </p>
                ) : (
                  <div className="divide-y divide-[var(--line)]">
                    {topics.map((t, i) => (
                      <div key={i} className="px-4 py-3">
                        <p className="font-medium text-[var(--ink)] mb-1.5" style={{ fontSize: 'var(--t-small)' }}>
                          {t.topic}
                        </p>
                        {t.followUps.map((q, j) => (
                          <p key={j} className="text-[var(--muted)] mb-1 last:mb-0" style={{ fontSize: 'var(--t-micro)' }}>
                            → {q}
                          </p>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Live transcript — grows below topics */}
            <div>
              <p className="font-medium text-[var(--ink)] mb-2" style={{ fontSize: 'var(--t-small)' }}>
                Live transskription
              </p>
              <div
                className="border border-[var(--line)] rounded-[var(--radius)] bg-[var(--surface)] overflow-y-auto"
                style={{ maxHeight: 400, padding: '12px 16px' }}
              >
                {liveSegments.length === 0 ? (
                  <p className="text-[var(--muted)] italic" style={{ fontSize: 'var(--t-small)', fontFamily: 'var(--font-mono)' }}>
                    Lytter…
                  </p>
                ) : (
                  <div className="space-y-3">
                    {liveSegments.map((seg, i) => (
                      <div key={i} className="flex gap-2">
                        <span
                          className="shrink-0 text-[var(--muted)] tabular-nums"
                          style={{ fontSize: 'var(--t-micro)', fontFamily: 'var(--font-mono)', paddingTop: 2, minWidth: 48 }}
                        >
                          {seg.speaker}
                        </span>
                        <p className="text-[var(--ink)]" style={{ fontSize: 'var(--t-small)', lineHeight: 1.6 }}>
                          {seg.text}
                        </p>
                      </div>
                    ))}
                    <div ref={transcriptEndRef} />
                  </div>
                )}
              </div>
            </div>
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
              Den eksisterende optagelse og transskription overskrives. Eventuelt referat slettes ikke, men vil være baseret på den nye transskription.
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
