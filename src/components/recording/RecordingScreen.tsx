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

// ── PCM live-transcription helpers ───────────────────────────────────────────

// Commits words that agree at the same position across two consecutive
// hypotheses. Works correctly only when each call receives the FULL accumulated
// audio (so partial N is always a text prefix of partial N+1).
class LocalAgreementMerger {
  private prevWords: string[] = [];
  private committed: string[] = [];

  merge(newHyp: string): { committed: string; tail: string } {
    const newWords = newHyp.trim() ? newHyp.trim().split(/\s+/) : [];
    let agree = 0;
    while (agree < this.prevWords.length && agree < newWords.length &&
           this.prevWords[agree].toLowerCase() === newWords[agree].toLowerCase()) {
      agree++;
    }
    for (let i = this.committed.length; i < agree; i++) {
      this.committed.push(this.prevWords[i]);
    }
    this.prevWords = newWords;
    return {
      committed: this.committed.join(' '),
      tail: newWords.slice(this.committed.length).join(' '),
    };
  }

  forceCommit(): string {
    for (let i = this.committed.length; i < this.prevWords.length; i++) {
      this.committed.push(this.prevWords[i]);
    }
    const result = this.committed.join(' ');
    this.reset();
    return result;
  }

  reset() { this.prevWords = []; this.committed = []; }
}

function encodePcmToWav(frames: Int16Array[]): Blob {
  const sampleRate = 16_000;
  const totalSamples = frames.reduce((n, f) => n + f.length, 0);
  const dataBytes = totalSamples * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const ws = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true);
  ws(8, 'WAVE'); ws(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, dataBytes, true);
  let off = 44;
  for (const frame of frames) {
    for (let i = 0; i < frame.length; i++) { v.setInt16(off, frame[i], true); off += 2; }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// Encode a Float32Array slice (16 kHz, normalised −1..1) to a 16-bit PCM WAV blob.
// Used for final utterance transcription from the VAD-provided audio, which is
// guaranteed to be aligned with the VAD model's speech boundaries.
function float32ToWavBlob(samples: Float32Array, startSample = 0, endSample?: number): Blob {
  const src = samples.subarray(startSample, endSample);
  const numSamples = src.length;
  const dataBytes = numSamples * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const ws = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true);
  ws(8, 'WAVE'); ws(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16_000, true); v.setUint32(28, 32_000, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, dataBytes, true);
  let off = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, src[i]));
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([buf], { type: 'audio/wav' });
}

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
}

type RecordingState = 'idle' | 'recording' | 'paused' | 'stopped';

const BYTES_PER_SECOND_ESTIMATE = 16_000;
const SILENCE_THRESHOLD_SECONDS = 5;
const SILENCE_VOLUME_THRESHOLD = 0.02;
// How often quick partials fire during active speech (matches demo's 0.7 s interval).
const PARTIAL_INTERVAL_MS = 700;
// Maximum PCM frames per hviske call (16 kHz × 1024-sample frames = 64 ms/frame).
// 15 s × 16 000 / 1024 ≈ 235 frames → ~480 KB WAV. Beyond this hviske times out.
const MAX_PARTIAL_FRAMES = Math.ceil((16_000 * 15) / 1024);
// How often, while recording, we re-analyze the transcript for things to clarify.
const CLARIFY_INTERVAL_MS = 25_000;
// Tick cadence for the countdown bar to the next clarification refresh.
const CLARIFY_TICK_MS = 250;

export function RecordingScreen({ meetingId, existingRecording, onNavigateToReview }: RecordingScreenProps) {
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
  // True if VAD setup fails or utterance transcription errors out — the batch
  // transcript still works, but the live interim captions won't show.
  const [liveCaptionsUnavailable, setLiveCaptionsUnavailable] = useState(false);
  // True while a batch diarization pass is running (on pause) — the preview is
  // being repainted with authoritative speaker labels.
  const [isDiarizing, setIsDiarizing] = useState(false);

  // Live transcription
  const [liveSegments, setLiveSegments] = useState<LiveSegment[]>([]);
  const [interimText, setInterimText] = useState('');
  const [clarifications, setClarifications] = useState<ClarificationItem[]>([]);
  // Fraction (0–1) of time remaining until the next clarification refresh, for the
  // reverse countdown bar. Starts full (1) and drains to 0, then resets.
  const [clarifyRemaining, setClarifyRemaining] = useState(1);
  const liveSegmentsRef = useRef<LiveSegment[]>([]);
  const mimeTypeRef = useRef('audio/webm');
  const clarifyTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const nextClarifyAtRef = useRef<number>(0);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  const interimTextRef = useRef('');
  const recordingActiveRef = useRef(false);
  // Silero VAD instance (created in startVAD, destroyed on stop/cancel).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vadRef = useRef<any>(null);
  // Elapsed-seconds mark when VAD fires onSpeechStart, for accurate segment timestamps.
  const utteranceStartRef = useRef<number | null>(null);
  // Guard against overlapping utterance fetches.
  const utteranceInFlightRef = useRef(false);
  // Queue of utterances that ended while a fetch was in-flight. Stores the VAD-provided
  // Float32 audio directly so frame-index drift between AudioContexts cannot corrupt them.
  const pendingUtterancesRef = useRef<Array<{ start: number; end: number; audio: Float32Array }>>([]);
  const partialTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // PCM accumulation for live transcription (16 kHz Int16 frames from the AudioWorklet).
  const pcmFramesRef = useRef<Int16Array[]>([]);
  // Frame index into pcmFramesRef where the current utterance started (with pre-roll).
  const pcmSpeechStartFrameRef = useRef<number>(0);
  // AudioWorkletNode that emits 16 kHz Int16 frames.
  const pcmWorkletNodeRef = useRef<AudioWorkletNode | null>(null);
  // Tracks committed + tail display across consecutive partials of one utterance.
  const mergerRef = useRef(new LocalAgreementMerger());

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
    utteranceInFlightRef.current = false;
    pendingUtterancesRef.current = [];
    if (partialTimerRef.current) { clearInterval(partialTimerRef.current); partialTimerRef.current = null; }
    pcmFramesRef.current = [];
    pcmSpeechStartFrameRef.current = 0;
    mergerRef.current.reset();
    setLiveCaptionsUnavailable(false);
    setIsDiarizing(false);
    setClarifications([]);
    setClarifyRemaining(1);
  }

  // ── Live transcription (Silero VAD + hviske) ─────────────────────────────────

  function currentElapsed(): number {
    return Math.max(0, (Date.now() - startTimeRef.current - pausedDurationRef.current) / 1000);
  }

  // Push a finalized utterance into the live segments list. Splits multi-sentence text
  // into separate segments using word-count-proportional timestamps so they don't overlap.
  function commitUtterance(start: number, end: number, text: string) {
    interimTextRef.current = '';
    setInterimText('');
    if (!text.trim()) return;
    const duration = Math.max(0.1, end - start);
    const sentences = (text.trim().match(/[^.!?]+[.!?]+/g) ?? [text.trim()])
      .map(s => s.trim()).filter(Boolean);
    const wordCounts = sentences.map(s => s.split(/\s+/).filter(Boolean).length);
    const totalWords = Math.max(1, wordCounts.reduce((a, b) => a + b, 0));
    let elapsed = start;
    const newSegs: LiveSegment[] = sentences.map((sentence, i) => {
      const segEnd = elapsed + (wordCounts[i] / totalWords) * duration;
      const seg: LiveSegment = { speaker: '—', start: elapsed, end: segEnd, text: sentence };
      elapsed = segEnd;
      return seg;
    });
    const updated = [...liveSegmentsRef.current, ...newSegs];
    liveSegmentsRef.current = updated;
    setLiveSegments(updated);
    setTimeout(() => transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
  }

  // Start Silero VAD on the given stream. Uses raw 16 kHz PCM frames from the AudioWorklet.
  //   • Partials every 700 ms: growing window (speechStart → now), capped at 15 s.
  //     Below the cap, LocalAgreementMerger locks in stable words across partials.
  //     Above the cap, a sliding 15 s window is used and the merger is bypassed.
  //   • Finalization on onSpeechEnd: sends the exact utterance audio, split into 15 s
  //     chunks when necessary so hviske never exceeds its 12 s server timeout.
  async function startVAD(stream: MediaStream) {
    try {
      const { MicVAD } = await import('@ricky0123/vad-web');

      // Build WAV from PCM frames [fromFrame, toFrame). toFrame defaults to current length.
      // Returns null if no frames are available (worklet not loaded).
      function buildWavBlob(fromFrame: number, toFrame?: number): Blob | null {
        const frames = pcmFramesRef.current.slice(fromFrame, toFrame);
        if (frames.length === 0) return null;
        return encodePcmToWav(frames);
      }

      // POST a WAV blob to the utterance endpoint and return the transcribed text.
      async function postWav(blob: Blob): Promise<string> {
        const formData = new FormData();
        formData.append('audio', blob, 'utterance.wav');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);
        try {
          const res = await fetch(`/api/meetings/${meetingId}/utterance`, {
            method: 'POST',
            body: formData,
            signal: controller.signal,
          });
          if (res.ok) {
            const data = await res.json() as { text: string };
            return data.text ?? '';
          }
        } catch (err) {
          if (err instanceof Error && err.name !== 'AbortError') {
            console.error('[vad] utterance transcription failed:', err);
            setLiveCaptionsUnavailable(true);
          }
        } finally {
          clearTimeout(timeout);
        }
        return '';
      }

      // Finalize one utterance using the VAD-provided Float32Array. Using the library's
      // own audio guarantees the segment boundaries match exactly what the VAD model
      // analyzed — eliminating the clock-skew bug that occurred when using frame indices
      // from a separate AudioContext. For utterances longer than 15 s the audio is split
      // into chunks so hviske never exceeds its 12 s server timeout.
      const MAX_SAMPLES_PER_CHUNK = 16_000 * 15; // 15 s at 16 kHz
      async function finalize(uStart: number, uEnd: number, audio: Float32Array) {
        utteranceInFlightRef.current = true;
        // Preserve the partial timer's last hypothesis as a fallback. If postWav fails
        // (network blip, server restart), we commit the last known partial result rather
        // than silently dropping the utterance.
        const fallbackText = mergerRef.current.forceCommit();
        try {
          if (audio.length <= MAX_SAMPLES_PER_CHUNK) {
            // Short path: single hviske call. Fall back to last partial on failure.
            const wav = float32ToWavBlob(audio);
            const text = await postWav(wav) || fallbackText;
            commitUtterance(uStart, uEnd, text);
          } else {
            // Long path: split into 15 s chunks so hviske never times out.
            const totalDuration = uEnd - uStart;
            let sampleStart = 0;
            let chunkTimeStart = uStart;
            while (sampleStart < audio.length) {
              const sampleEnd = Math.min(sampleStart + MAX_SAMPLES_PER_CHUNK, audio.length);
              const chunkDuration = ((sampleEnd - sampleStart) / audio.length) * totalDuration;
              const chunkTimeEnd = chunkTimeStart + chunkDuration;
              const wav = float32ToWavBlob(audio, sampleStart, sampleEnd);
              const text = await postWav(wav);
              if (text.trim()) commitUtterance(chunkTimeStart, chunkTimeEnd, text);
              sampleStart = sampleEnd;
              chunkTimeStart = chunkTimeEnd;
            }
          }

          // Drain the ordered queue so no utterance is ever dropped.
          const next = pendingUtterancesRef.current.shift();
          if (next) {
            await finalize(next.start, next.end, next.audio);
          } else {
            // Queue empty and no active speech: trim old PCM frames to free memory.
            // Only safe here because no frame indices are in use.
            if (utteranceStartRef.current === null) {
              const KEEP = 10; // ~640 ms safety buffer for the next utterance's pre-roll
              const keepFrom = Math.max(0, pcmFramesRef.current.length - KEEP);
              if (keepFrom > 0) {
                pcmFramesRef.current = pcmFramesRef.current.slice(keepFrom);
                pcmSpeechStartFrameRef.current = 0;
              }
            }
          }
        } finally {
          utteranceInFlightRef.current = false;
        }
      }

      function startPartialTimer() {
        if (partialTimerRef.current) return;
        partialTimerRef.current = setInterval(() => {
          if (utteranceStartRef.current === null || utteranceInFlightRef.current) return;
          const speechStartFrame = pcmSpeechStartFrameRef.current;
          const currentFrame = pcmFramesRef.current.length;
          // Cap the partial window at MAX_PARTIAL_FRAMES so hviske never times out.
          // When we exceed the cap, switch to a sliding window (most recent 15 s).
          // The merger's "prefix" assumption breaks in sliding-window mode, so we reset
          // it and show raw text — stable committed text takes over from there.
          const framesInWindow = currentFrame - speechStartFrame;
          const sliding = framesInWindow > MAX_PARTIAL_FRAMES;
          const wavStartFrame = sliding
            ? currentFrame - MAX_PARTIAL_FRAMES
            : speechStartFrame;
          if (sliding) mergerRef.current.reset();
          const wav = buildWavBlob(wavStartFrame);
          if (!wav) return;
          utteranceInFlightRef.current = true;
          postWav(wav).then((text) => {
            if (utteranceStartRef.current === null) return; // utterance already ended
            let display: string;
            if (sliding) {
              display = text || '…';
            } else {
              const { committed, tail } = mergerRef.current.merge(text);
              display = committed && tail ? `${committed} ${tail}` : (committed || tail || '…');
            }
            interimTextRef.current = display;
            setInterimText(display);
          }).finally(() => {
            utteranceInFlightRef.current = false;
            // Drain any utterances that ended while this partial was in-flight.
            const next = pendingUtterancesRef.current.shift();
            if (next && utteranceStartRef.current === null) {
              void finalize(next.start, next.end, next.audio);
            }
          });
        }, PARTIAL_INTERVAL_MS);
      }

      function stopPartialTimer() {
        if (partialTimerRef.current) { clearInterval(partialTimerRef.current); partialTimerRef.current = null; }
      }

      const vad = await MicVAD.new({
        getStream: () => Promise.resolve(stream),
        pauseStream: async () => {},
        resumeStream: async (s) => s,
        baseAssetPath: '/',
        onnxWASMBasePath: '/',
        // Force single-threaded ORT — no SharedArrayBuffer (COOP/COEP) required.
        ortConfig: (ort: any) => { ort.env.wasm.numThreads = 1; },
        model: 'v5',
        // 600ms silence before declaring speech end — matches demo's SILENCE_TIMEOUT_MS.
        redemptionMs: 600,
        // 300ms pre-roll captures soft onsets; we also manually include pre-roll frames
        // when recording pcmSpeechStartFrameRef below.
        preSpeechPadMs: 300,
        positiveSpeechThreshold: 0.5,
        negativeSpeechThreshold: 0.35,
        onSpeechStart: () => {
          utteranceStartRef.current = currentElapsed();
          // Include ~300 ms of pre-roll (≈5 frames × 1024 samples @ 16 kHz) so hviske
          // doesn't miss soft onsets at the start of the utterance.
          const preRollFrames = Math.round(16_000 * 0.3 / 1024);
          pcmSpeechStartFrameRef.current = Math.max(0, pcmFramesRef.current.length - preRollFrames);
          mergerRef.current.reset();
          interimTextRef.current = '…';
          setInterimText('…');
          startPartialTimer();
        },
        // The VAD library passes the complete utterance audio as a Float32Array at 16 kHz,
        // including the configured preSpeechPadMs. Using this directly is more reliable
        // than slicing pcmFramesRef by index, because both use different AudioContexts
        // with independent clocks — the indices drift and produce wrong audio boundaries.
        onSpeechEnd: async (audio: Float32Array) => {
          stopPartialTimer();
          const uStart = utteranceStartRef.current ?? currentElapsed();
          const uEnd = currentElapsed();
          utteranceStartRef.current = null;
          interimTextRef.current = '';
          setInterimText('');

          if (utteranceInFlightRef.current) {
            // Push to queue — nothing is dropped even if multiple utterances pile up.
            pendingUtterancesRef.current.push({ start: uStart, end: uEnd, audio });
            return;
          }

          await finalize(uStart, uEnd, audio);
        },
        onVADMisfire: () => {
          stopPartialTimer();
          utteranceStartRef.current = null;
          mergerRef.current.reset();
          interimTextRef.current = '';
          setInterimText('');
        },
      });
      vadRef.current = vad;
      vad.start();
      setLiveCaptionsUnavailable(false);
    } catch (err) {
      console.error('[startVAD] setup failed:', err);
      setLiveCaptionsUnavailable(true);
    }
  }

  // Flush the recorder's buffered tail into chunksRef before reading it.
  function flushRecorder(recorder: MediaRecorder): Promise<void> {
    if (recorder.state !== 'recording') return Promise.resolve();
    return new Promise<void>((resolve) => {
      const onData = () => { recorder.removeEventListener('dataavailable', onData); resolve(); };
      recorder.addEventListener('dataavailable', onData);
      recorder.requestData();
    });
  }

  // Run the authoritative batch scribe_v2 pass over everything recorded so far and
  // repaint the preview with real speaker labels. Used at every pause.
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
      // Diarization is a checkpoint nicety — keep the realtime preview on failure.
      console.error('[diarize] failed:', err);
    } finally {
      setIsDiarizing(false);
    }
  }

  // ── Recording lifecycle ───────────────────────────────────────────────────────

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
      // Live clarifications are a non-critical enhancement — keep recording, just log.
      console.error('[clarifications] refresh failed:', err);
    }
  }

  // Drive the countdown bar and fire a refresh when it reaches zero. Runs only
  // while actively recording (started/stopped alongside the recorder).
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
    // Tracked outside try so the catch can release it if setup fails after getUserMedia
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: false },
      });

      // Volume meter + PCM capture worklet — non-critical. If Web Audio can't open the
      // hardware device recording still proceeds; live captions will be unavailable.
      try {
        const ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        const source = ctx.createMediaStreamSource(stream);
        source.connect(analyser);
        audioContextRef.current = ctx;
        analyserRef.current = analyser;
        // Chrome may start the context suspended (autoplay policy / autostart path).
        await ctx.resume();
        // Auto-recover if the system later suspends the context (e.g. macOS CoreAudio reset).
        ctx.onstatechange = () => {
          if (ctx.state === 'suspended' && recordingActiveRef.current) void ctx.resume();
        };

        // PCM downsampler worklet — emits 16 kHz Int16 frames used for live transcription.
        // Runs in the same AudioContext but fails independently; if unavailable the VAD still
        // works but live captions won't fire (batch transcription is unaffected).
        try {
          await ctx.audioWorklet.addModule('/asr-worklet.js');
          const workletNode = new AudioWorkletNode(ctx, 'asr-downsampler');
          workletNode.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
            pcmFramesRef.current.push(new Int16Array(e.data));
          };
          source.connect(workletNode);
          // Chrome silently drops AudioWorklet nodes that have no downstream sink
          // (https://github.com/WebAudio/web-audio-api/issues/345). Connecting to
          // destination keeps the node alive in the audio graph without audible output.
          workletNode.connect(ctx.destination);
          pcmWorkletNodeRef.current = workletNode;
        } catch (workletErr) {
          console.warn('[startRecording] PCM worklet unavailable, live captions disabled:', workletErr);
        }
      } catch (audioErr) {
        console.warn('[startRecording] AudioContext unavailable, volume meter disabled:', audioErr);
        audioContextRef.current = null;
        analyserRef.current = null;
      }

      // Pick a mime type the browser can actually record (iOS Safari needs mp4,
      // not webm). Empty string → let MediaRecorder choose its own default.
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

      void startVAD(stream);
    } catch (err) {
      // Release the mic if we acquired it but failed during setup — otherwise it stays locked
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
    // Freeze the clock + meter immediately so the UI feels responsive.
    pauseStartRef.current = Date.now();
    if (timerRef.current) clearInterval(timerRef.current);
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    stopClarifyTimer();
    setVolumeLevel(0);
    // Spin the pause button right away — it stays "loading" until diarization lands.
    setIsDiarizing(true);
    setRecordingState('paused');

    // Pause VAD processing, flush the recorded tail, then pause the recorder.
    if (partialTimerRef.current) { clearInterval(partialTimerRef.current); partialTimerRef.current = null; }
    vadRef.current?.pause();
    await flushRecorder(recorder);
    recorder.pause();
    // Suspend the AudioContext so it releases the hardware and stops generating errors
    void audioContextRef.current?.suspend();

    // Repaint the preview with authoritative speaker labels.
    await diarizeSoFar(recorder);
  }

  async function resumeRecording() {
    if (!mediaRecorderRef.current) return;
    const recorder = mediaRecorderRef.current;
    // Await the resume so the AudioContext is fully running before pollVolume starts reading
    await audioContextRef.current?.resume();
    recorder.resume();
    pausedDurationRef.current += Date.now() - pauseStartRef.current;
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current - pausedDurationRef.current) / 1000));
    }, 500);
    if (analyserRef.current) animFrameRef.current = requestAnimationFrame(pollVolume);
    startClarifyTimer();
    setRecordingState('recording');
    vadRef.current?.start();
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
    stopClarifyTimer();
  }

  async function stopAndSave() {
    if (!mediaRecorderRef.current) return;
    const recorder = mediaRecorderRef.current;
    recordingActiveRef.current = false;
    clearIntervals();
    vadRef.current?.destroy();
    vadRef.current = null;
    pcmWorkletNodeRef.current?.disconnect();
    pcmWorkletNodeRef.current = null;
    audioContextRef.current?.close();
    audioContextRef.current = null;

    // Resume before stopping so the recorder flushes its buffer into a
    // final ondataavailable event — paused recorders may not do this reliably.
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

    // Persist live segments immediately so the review page shows content while
    // audio processing completes in the background. Pass transcriptId to the
    // transcribe route so it takes the update path (PII only, no re-transcription).
    let savedTranscriptId: string | null = null;
    if (liveSegmentsRef.current.length > 0) {
      try {
        const saveRes = await fetch(`/api/meetings/${meetingId}/save-transcript`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ segments: liveSegmentsRef.current }),
        });
        if (saveRes.ok) {
          const data = await saveRes.json() as { transcriptId: string };
          savedTranscriptId = data.transcriptId;
        }
      } catch (saveErr) {
        console.warn('[stopAndSave] live segment save failed, falling back to batch STT:', saveErr);
      }
    }

    try {
      const formData = new FormData();
      formData.append('audio', blob, `recording.${extensionForMimeType(mimeType)}`);
      formData.append('meetingId', meetingId);
      formData.append('duration', String(elapsed));
      if (savedTranscriptId) formData.append('transcriptId', savedTranscriptId);
      const res = await fetch('/api/transcribe', { method: 'POST', body: formData });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
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
      recordingActiveRef.current = false;
      clearIntervals();
      vadRef.current?.destroy();
      vadRef.current = null;
      pcmWorkletNodeRef.current?.disconnect();
      pcmWorkletNodeRef.current = null;
      audioContextRef.current?.close();
      audioContextRef.current = null;
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach((t) => t.stop());
    }
    await fetch(`/api/meetings/${meetingId}`, { method: 'DELETE' });
    router.push('/dashboard');
  }

  useEffect(() => {
    return () => {
      recordingActiveRef.current = false;
      clearIntervals();
      vadRef.current?.destroy();
      vadRef.current = null;
      pcmWorkletNodeRef.current?.disconnect();
      pcmWorkletNodeRef.current = null;
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

  const showLivePanel = recordingState === 'recording' || recordingState === 'paused' || liveSegments.length > 0;

  // ── Completed state (navigated back after recording) ─────────────────────────
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

  // ── Active recording / idle ───────────────────────────────────────────────────
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

        {/* Signal bars (live volume) */}
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

      {/* Live captions unavailable (e.g. iOS Safari) — recording still works */}
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
                animation: (recordingState === 'recording' || isDiarizing) ? 'protoPulse 1.4s ease-in-out infinite' : 'none',
              }} />
              {isDiarizing ? 'finder talere…' : recordingState === 'recording' ? 'transskriberer live' : recordingState === 'paused' ? 'pause' : 'klar'}
            </span>
            {recordingState === 'recording' && !isDiarizing && <span>· hviske live</span>}
          </div>

          {/* Transcript rows */}
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
                {recordingState === 'idle' ? 'Tryk optag for at starte…' : 'Lytter…'}
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
                {/* Interim row: realtime partial text, finalized into a committed segment */}
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
                {/* Cursor on last confirmed segment when no interim text */}
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

          {/* Speakers (only shown after batch processing; live has no speaker labels) */}
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

          {/* Live clarifications — things worth nailing down, refreshed on a countdown */}
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
        {recordingState === 'idle' && (
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
            transskriberer og gemmer…
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
      `}</style>
    </div>
  );
}
