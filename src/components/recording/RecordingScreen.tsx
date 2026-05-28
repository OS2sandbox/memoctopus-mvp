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
import { pendingUpload } from '@/lib/pending-upload';

interface LiveSegment {
  speaker: string;
  start: number;
  end: number;
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
  const searchParams = useSearchParams();
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

    // Compute how far into the recording this chunk starts.
    // Whisper timestamps are relative to each chunk's start, so we offset them
    // to make them recording-relative.
    const elapsedSec = (Date.now() - startTimeRef.current - pausedDurationRef.current) / 1000;
    const chunkOffset = Math.max(0, elapsedSec - newChunks.length);

    try {
      const res = await fetch(`/api/meetings/${meetingId}/live-transcribe`, { method: 'POST', body: form });
      if (!res.ok) return;
      const data = await res.json() as { segments?: LiveSegment[] };
      const segs = (data.segments ?? []).map((seg) => ({
        ...seg,
        start: (seg.start ?? 0) + chunkOffset,
        end: (seg.end ?? 0) + chunkOffset,
      }));
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
    if (timerRef.current) clearInterval(timerRef.current);
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    setVolumeLevel(0);
    setRecordingState('paused');
  }

  function resumeRecording() {
    if (!mediaRecorderRef.current) return;
    mediaRecorderRef.current.resume();
    pausedDurationRef.current += Date.now() - pauseStartRef.current;
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current - pausedDurationRef.current) / 1000));
    }, 500);
    animFrameRef.current = requestAnimationFrame(pollVolume);
    setRecordingState('recording');
  }

  // Auto-start when navigated here from the home page record button
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
    if (chunkIntervalRef.current) clearInterval(chunkIntervalRef.current);
    if (topicIntervalRef.current) clearInterval(topicIntervalRef.current);
  }

  async function stopAndSave() {
    if (!mediaRecorderRef.current) return;
    const recorder = mediaRecorderRef.current;
    clearIntervals();

    // Resume before stopping so the recorder flushes its buffer into a
    // final ondataavailable event — paused recorders may not do this reliably.
    if (recorder.state === 'paused') recorder.resume();

    await new Promise<void>((resolve) => {
      recorder.addEventListener('stop', () => resolve(), { once: true });
      recorder.stop();
    });
    recorder.stream.getTracks().forEach((t) => t.stop());
    audioContextRef.current?.close();

    setRecordingState('stopped');
    setIsUploading(true);

    const mimeType = recorder.mimeType || 'audio/webm';
    const blob = new Blob(chunksRef.current, { type: mimeType });

    if (liveSegmentsRef.current.length >= 3) {
      // Fast path: save live segments to DB immediately, then navigate.
      // The audio blob is uploaded with a progress bar from Gennemgang.
      try {
        const res = await fetch(`/api/meetings/${meetingId}/save-transcript`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ segments: liveSegmentsRef.current }),
        });
        if (!res.ok) throw new Error('Kunne ikke gemme transskriptionen');
      } catch {
        // Even on failure, store what we have and navigate — Gennemgang handles recovery.
      }
      pendingUpload.set({ meetingId, blob, elapsed });
      router.push(`/meeting/${meetingId}/review`);
      return;
    }

    // Slow path: no live segments — run full Whisper transcription.
    // Still navigate on error so the user is never stuck on the recording screen.
    try {
      const formData = new FormData();
      formData.append('audio', blob, `recording.${mimeType.includes('mp4') ? 'm4a' : 'webm'}`);
      formData.append('meetingId', meetingId);
      formData.append('duration', String(elapsed));

      const res = await fetch('/api/transcribe', { method: 'POST', body: formData });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? 'Upload fejlede');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Noget gik galt under upload');
    }
    router.push(`/meeting/${meetingId}/review`);
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

    return (
      <div style={{ minHeight: 'calc(100vh - 56px - 47px)', padding: '32px 48px 24px', display: 'flex', flexDirection: 'column' }}>
        <div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', letterSpacing: 0.4 }}>01 · optagelse</div>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 64, fontWeight: 500,
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
            onClick={() => router.push(`/meeting/${meetingId}/review`)}
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

  // ── Active recording / idle ───────────────────────────────────────────────────
  const uniqueSpeakers = Array.from(new Set(liveSegments.map((s) => s.speaker)));
  const speakerCount = (sp: string) => liveSegments.filter((s) => s.speaker === sp).length;
  const fmtSec = (s: number) => {
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };

  return (
    <div style={{ minHeight: 'calc(100vh - 56px - 47px)', padding: '32px 48px 24px', display: 'flex', flexDirection: 'column' }}>

      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 28 }}>
        <div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', letterSpacing: 0.4 }}>01 · optagelse</div>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 64, fontWeight: 500,
            letterSpacing: '-0.04em', color: 'var(--ink)',
            fontVariantNumeric: 'tabular-nums', lineHeight: 1, marginTop: 8,
          }}>
            {elapsedFormatted}
          </div>
        </div>

        {/* Signal bars (live volume) */}
        <div style={{ paddingBottom: 6 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', marginBottom: 8, letterSpacing: 0.4 }}>signal</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 30 }}>
            {Array.from({ length: 36 }).map((_, i) => {
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

      {/* Error */}
      {error && (
        <div style={{
          marginTop: 16, padding: '12px 16px', borderRadius: 'var(--radius)',
          background: 'var(--kill-wash)', borderLeft: '3px solid var(--kill)',
          fontSize: 13.5, color: 'var(--kill)',
        }}>
          {error}
        </div>
      )}

      {/* Silence warning */}
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

      {/* Body — transcript + sidebar */}
      <div style={{
        marginTop: 28, display: 'grid', gridTemplateColumns: '1fr 280px',
        gap: 32, flex: 1, overflow: 'hidden',
      }}>

        {/* Transcript stream */}
        <div style={{
          display: 'flex', flexDirection: 'column',
          border: '1px solid var(--line-2)', borderRadius: 'var(--radius)',
          background: 'var(--surface)', overflow: 'hidden',
        }}>
          {/* Transcript header */}
          <div style={{
            padding: '12px 18px', borderBottom: '1px solid var(--line)',
            display: 'flex', alignItems: 'center', gap: 12,
            fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted)',
          }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{
                width: 7, height: 7, borderRadius: 999, flexShrink: 0,
                background: recordingState === 'paused' ? 'var(--muted)' : (recordingState === 'recording' ? 'var(--keep)' : 'var(--muted-2)'),
                animation: recordingState === 'recording' ? 'protoPulse 1.4s ease-in-out infinite' : 'none',
              }} />
              {recordingState === 'recording' ? 'hviske transskriberer' : recordingState === 'paused' ? 'pause' : 'klar'}
            </span>
            {recordingState === 'recording' && <span>· ~3 sek. forsinkelse</span>}
          </div>

          {/* Transcript rows */}
          <div style={{ flex: 1, overflow: 'auto', padding: '14px 0' }}>
            {liveSegments.length === 0 ? (
              <div style={{
                padding: '20px 18px', fontFamily: 'var(--mono)', fontSize: 12.5,
                color: 'var(--muted)', fontStyle: 'italic',
              }}>
                {recordingState === 'idle' ? 'Tryk optag for at starte…' : 'Lytter…'}
              </div>
            ) : (
              liveSegments.map((seg, i) => {
                const isLast = i === liveSegments.length - 1;
                return (
                  <div key={i} style={{
                    display: 'grid', gridTemplateColumns: '60px 90px 1fr 20px',
                    gap: 12, padding: '5px 18px',
                    opacity: 0.5 + Math.min(0.5, i * 0.06),
                    fontFamily: 'var(--mono)', fontSize: 12.5, lineHeight: 1.65,
                  }}>
                    <span style={{ color: 'var(--accent)' }}>{fmtSec(seg.start)}</span>
                    <span style={{ color: 'var(--ink)', fontWeight: 500 }}>{seg.speaker.toLowerCase()}:</span>
                    <span style={{ color: 'var(--ink-2)' }}>
                      {seg.text}
                      {isLast && recordingState === 'recording' && (
                        <span style={{
                          display: 'inline-block', width: 7, height: 14,
                          background: 'var(--accent)', verticalAlign: 'middle', marginLeft: 3,
                          animation: 'protoBlink 0.9s steps(2) infinite',
                        }} />
                      )}
                    </span>
                    <span style={{ color: 'var(--muted-2)', textAlign: 'right' }}>★</span>
                  </div>
                );
              })
            )}
            <div ref={transcriptEndRef} />
          </div>
        </div>

        {/* Sidebar */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 28, paddingLeft: 8, overflow: 'auto' }}>

          {/* Speakers */}
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

          {/* Live key points */}
          {topics.length > 0 && (
            <div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', letterSpacing: 0.4, marginBottom: 10 }}>
                nøglepunkter · live
              </div>
              {topics.map((t, i) => (
                <div key={i} style={{
                  padding: '8px 0', borderTop: '1px solid var(--line)',
                  fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.5,
                }}>
                  {t.topic}
                </div>
              ))}
            </div>
          )}

          {/* Compliance note */}
          <div style={{ marginTop: 'auto', paddingTop: 16 }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--muted)', lineHeight: 1.8 }}>
              lyden slettes automatisk efter 14 dage<br />
              PII fjernes inden referatet udarbejdes
            </div>
          </div>
        </div>
      </div>

      {/* Footer controls */}
      <div style={{
        marginTop: 20, paddingTop: 18, borderTop: '1px solid var(--line)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16,
      }}>
        {recordingState === 'idle' && (
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
        )}

        {(recordingState === 'recording' || recordingState === 'paused') && (
          <>
            <button
              onClick={recordingState === 'recording' ? pauseRecording : resumeRecording}
              style={{
                fontFamily: 'var(--mono)', fontSize: 13.5, fontWeight: 500,
                padding: '8px 14px', borderRadius: 'var(--radius)',
                border: '1px solid var(--line-2)', background: 'transparent',
                color: 'var(--ink)', cursor: 'pointer',
              }}
            >
              {recordingState === 'recording' ? 'pause' : 'fortsæt'}
            </button>
            <button
              onClick={stopAndSave}
              style={{
                width: 56, height: 56, borderRadius: 999,
                background: 'var(--ink)', border: 'none', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
              aria-label="Stop og gem"
            >
              <span style={{ width: 14, height: 14, background: 'var(--bg)', display: 'block' }} />
            </button>
            <button
              onClick={stopAndSave}
              style={{
                fontFamily: 'var(--mono)', fontSize: 13.5, fontWeight: 500,
                padding: '8px 14px', borderRadius: 'var(--radius)',
                border: '1px solid var(--line-2)', background: 'transparent',
                color: 'var(--ink)', cursor: 'pointer',
              }}
            >
              stop &amp; gem
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
            gemmer og navigerer…
          </div>
        )}

        {recordingState !== 'stopped' && !isUploading && (
          <button
            onClick={() => setShowCancelDialog(true)}
            style={{
              fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted-2)',
              background: 'none', border: 'none', cursor: 'pointer',
              textDecoration: 'underline', textUnderlineOffset: 3,
              position: 'absolute', right: 48,
            }}
          >
            annullér
          </button>
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
      `}</style>
    </div>
  );
}
