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
import type { TranscriptSegment } from '@/types';

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
  preRevealedWords: number;
}

// ── VAD batch transcription helpers ──────────────────────────────────────────
// After recording stops, the accumulated VAD utterances are grouped into ~27 s
// speech batches (matching the model's training window), encoded as WAV, and
// transcribed in parallel. Silences between utterances are dropped, avoiding
// hallucinations and maximising GPU utilisation.

type VadInterval = {
  originalStart: number;  // wall-clock seconds at speech start
  originalEnd:   number;  // wall-clock seconds at speech end
  wavOffset:     number;  // cumulative speech-seconds before this utterance in the batch WAV
  wavDuration:   number;  // speech duration of this utterance in the WAV
};

type ReadyBatch = {
  wav: Blob;
  intervals: VadInterval[];
  totalWavDuration: number;
};

type VadBatchState = {
  pendingAudio:       Float32Array[];
  pendingIntervals:   VadInterval[];
  pendingWavDuration: number;
  readyBatches:       ReadyBatch[];
};

function newVadBatchState(): VadBatchState {
  return { pendingAudio: [], pendingIntervals: [], pendingWavDuration: 0, readyBatches: [] };
}

function sealCurrentBatch(state: VadBatchState): void {
  if (state.pendingAudio.length === 0) return;
  const totalSamples = state.pendingAudio.reduce((n, a) => n + a.length, 0);
  const combined = new Float32Array(totalSamples);
  let off = 0;
  for (const a of state.pendingAudio) { combined.set(a, off); off += a.length; }
  const wav = float32ToWavBlob(combined);
  state.readyBatches.push({ wav, intervals: state.pendingIntervals, totalWavDuration: state.pendingWavDuration });
  state.pendingAudio = [];
  state.pendingIntervals = [];
  state.pendingWavDuration = 0;
}

function mapWavTime(wavT: number, intervals: VadInterval[]): number {
  for (const iv of intervals) {
    if (iv.wavDuration === 0) continue;
    if (wavT >= iv.wavOffset && wavT <= iv.wavOffset + iv.wavDuration) {
      return iv.originalStart + ((wavT - iv.wavOffset) / iv.wavDuration) * (iv.originalEnd - iv.originalStart);
    }
  }
  if (intervals.length === 0) return 0;
  if (wavT <= intervals[0].wavOffset) return intervals[0].originalStart;
  return intervals[intervals.length - 1].originalEnd;
}

function splitTextWithIntervals(
  text: string,
  intervals: VadInterval[],
  totalWavDuration: number,
): TranscriptSegment[] {
  if (!text.trim() || intervals.length === 0) return [];
  const punctChunks = (text.trim().match(/[^.!?]+[.!?]+/g) ?? [text.trim()]).map(s => s.trim()).filter(Boolean);
  const sentences: string[] = [];
  for (const chunk of punctChunks) {
    const words = chunk.split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i += MAX_WORDS_PER_LINE) {
      sentences.push(words.slice(i, i + MAX_WORDS_PER_LINE).join(' '));
    }
  }
  if (sentences.length === 0) return [];
  const wordCounts = sentences.map(s => s.split(/\s+/).filter(Boolean).length);
  const totalWords = Math.max(1, wordCounts.reduce((a, b) => a + b, 0));
  let elapsed = 0;
  return sentences.map((sentence, i) => {
    const segDur = (wordCounts[i] / totalWords) * totalWavDuration;
    const wavStart = elapsed;
    elapsed += segDur;
    return {
      speaker: 'Taler 1',
      start: mapWavTime(wavStart, intervals),
      end: mapWavTime(elapsed, intervals),
      text: sentence,
    };
  });
}

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  const queue = tasks.map((task, i) => ({ task, i }));
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    let item: typeof queue[0] | undefined;
    while ((item = queue.shift()) !== undefined) {
      results[item.i] = await item.task();
    }
  });
  await Promise.all(workers);
  return results;
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
// 15 s at 16 kHz — max audio per hviske call, also the early-commit threshold.
const MAX_CHUNK_SAMPLES = 16_000 * 15;
// Max words per committed live segment — keeps lines readable even without punctuation.
const MAX_WORDS_PER_LINE = 20;
// Minimum frames before triggering an auto-commit. The actual commit is adaptive —
// all frames accumulated since the last commit (up to MAX_COMMIT_FRAMES) are sent
// in one request so the window grows instead of queuing when the server is slow.
const COMMIT_WINDOW_FRAMES = Math.ceil((16_000 * 3) / 1024);
// Ceiling for one adaptive commit (9 s). Keeps the cascade damage of a single timeout
// bounded: at most 9 s of audio is lost per timeout, not the full MAX_CHUNK_SAMPLES.
const MAX_COMMIT_FRAMES = COMMIT_WINDOW_FRAMES * 3;
// Partial interim uses a trailing 4 s lookback instead of the full growing window.
// This means the partial only ever shows NEW audio — no hindsight re-transcription.
const PARTIAL_LOOKBACK_FRAMES = Math.ceil((16_000 * 4) / 1024);
// Slower partial ticks — less impatient, more accurate with longer context.
const PARTIAL_INTERVAL_MS = 1000;
// Max rate at which committed segment words are revealed left-to-right.
const WORDS_PER_SECOND = 10;
// Max speech-seconds per post-recording batch (matches model training window).
const BATCH_DURATION_S = 27;
// Concurrent hviske calls during post-recording batch transcription.
const BATCH_CONCURRENCY = 5;
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
  const [batchProgress, setBatchProgress] = useState<{ completed: number; total: number } | null>(null);
  // True if VAD setup fails or utterance transcription errors out — the batch
  // transcript still works, but the live interim captions won't show.
  const [liveCaptionsUnavailable, setLiveCaptionsUnavailable] = useState(false);
  // True while a batch diarization pass is running (on pause) — the preview is
  // being repainted with authoritative speaker labels.

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
  // Guard against running two finalize calls concurrently. Window auto-commits use
  // windowCommitControllerRef instead, keeping finalization independent.
  const finalizeInFlightRef = useRef(false);
  // Separate guard for partial-timer requests — keeps partials from blocking finalization.
  const partialInFlightRef = useRef(false);
  // AbortController for the single in-flight rolling-window commit. Null when idle.
  // Using one-at-a-time (not fire-and-forget) enforces backpressure so the server
  // never queues multiple window requests. Aborted on pause to release hviske capacity.
  const windowCommitControllerRef = useRef<AbortController | null>(null);
  // Count consecutive empty transcription responses. After 5 in a row we flip
  // liveCaptionsUnavailable so the user knows the server isn't returning text.
  const emptyTranscriptCountRef = useRef(0);
  // Queue of utterances that ended while a fetch was in-flight. Stores the VAD-provided
  // Float32 audio directly so frame-index drift between AudioContexts cannot corrupt them.
  // skip/windowStart are captured at speech-end so a later onSpeechStart reset cannot corrupt them.
  const pendingUtterancesRef = useRef<Array<{
    start: number; end: number; audio: Float32Array;
    skip: number; windowStart: number;
    partialWords: number; speechEndMs: number;
  }>>([]);
  const partialTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // VAD batch state for post-recording parallel transcription.
  const vadBatchStateRef = useRef<VadBatchState>(newVadBatchState());
  // PCM accumulation for live transcription (16 kHz Int16 frames from the AudioWorklet).
  const pcmFramesRef = useRef<Int16Array[]>([]);
  // Frame index into pcmFramesRef where the current utterance started (with pre-roll).
  const pcmSpeechStartFrameRef = useRef<number>(0);
  // AudioWorkletNode that emits 16 kHz Int16 frames.
  const pcmWorkletNodeRef = useRef<AudioWorkletNode | null>(null);
  // Tracks committed + tail display across consecutive partials of one utterance.
  const mergerRef = useRef(new LocalAgreementMerger());
  // PCM frame index where the current uncommitted rolling window starts.
  const windowStartFrameRef = useRef(0);
  // Elapsed-second timestamp when the current window started.
  const windowStartTimeRef = useRef(0);
  // Total 16 kHz samples already committed via window auto-commits (finalize skips these).
  const committedSamplesRef = useRef(0);

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
    vadBatchStateRef.current = newVadBatchState();
    setBatchProgress(null);
    liveSegmentsRef.current = [];
    setLiveSegments([]);
    interimTextRef.current = '';
    setInterimText('');
    utteranceStartRef.current = null;
    finalizeInFlightRef.current = false;
    partialInFlightRef.current = false;
    windowCommitControllerRef.current?.abort();
    windowCommitControllerRef.current = null;
    pendingUtterancesRef.current = [];
    if (partialTimerRef.current) { clearInterval(partialTimerRef.current); partialTimerRef.current = null; }
    pcmFramesRef.current = [];
    pcmSpeechStartFrameRef.current = 0;
    mergerRef.current.reset();
    windowStartFrameRef.current = 0;
    windowStartTimeRef.current = 0;
    committedSamplesRef.current = 0;
    emptyTranscriptCountRef.current = 0;
    setLiveCaptionsUnavailable(false);
    setClarifications([]);
    setClarifyRemaining(1);
  }

  // ── Live transcription (Silero VAD + hviske) ─────────────────────────────────

  function currentElapsed(): number {
    return Math.max(0, (Date.now() - startTimeRef.current - pausedDurationRef.current) / 1000);
  }

  // Push a finalized utterance into the live segments list. Splits text first by
  // sentence-ending punctuation, then further caps each chunk at MAX_WORDS_PER_LINE
  // so unpunctuated Danish speech still produces readable rows rather than one giant line.
  function commitUtterance(start: number, end: number, text: string, preRevealedWords = 0) {
    interimTextRef.current = '';
    setInterimText('');
    if (!text.trim()) return;
    const duration = Math.max(0.1, end - start);

    // Split on sentence boundaries, then sub-split any chunk that exceeds the word cap.
    const punctChunks = (text.trim().match(/[^.!?]+[.!?]+/g) ?? [text.trim()])
      .map(s => s.trim()).filter(Boolean);
    const sentences: string[] = [];
    for (const chunk of punctChunks) {
      const words = chunk.split(/\s+/).filter(Boolean);
      for (let i = 0; i < words.length; i += MAX_WORDS_PER_LINE) {
        sentences.push(words.slice(i, i + MAX_WORDS_PER_LINE).join(' '));
      }
    }

    const wordCounts = sentences.map(s => s.split(/\s+/).filter(Boolean).length);
    const totalWords = Math.max(1, wordCounts.reduce((a, b) => a + b, 0));
    let t = start;
    let wordsAssigned = 0;
    const newSegs: LiveSegment[] = sentences.map((sentence, i) => {
      const segEnd = t + (wordCounts[i] / totalWords) * duration;
      // First sentence inherits the full pre-revealed offset. Subsequent sentences
      // subtract the words already assigned so only genuinely new words animate.
      const segPreRevealed = Math.max(0, preRevealedWords - wordsAssigned);
      wordsAssigned += wordCounts[i];
      const seg: LiveSegment = { speaker: '—', start: t, end: segEnd, text: sentence, preRevealedWords: segPreRevealed };
      t = segEnd;
      return seg;
    });
    const updated = [...liveSegmentsRef.current, ...newSegs].sort((a, b) => a.start - b.start);
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
      async function postWav(blob: Blob, externalSignal?: AbortSignal): Promise<string> {
        const formData = new FormData();
        formData.append('audio', blob, 'utterance.wav');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 22_000);
        if (externalSignal) {
          externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
        }
        try {
          const res = await fetch(`/api/meetings/${meetingId}/utterance`, {
            method: 'POST',
            body: formData,
            signal: controller.signal,
          });
          if (res.ok) {
            const data = await res.json() as { text: string; latencyMs?: number };
            if (data.latencyMs != null) {
              console.log(`[hviske] server latency: ${data.latencyMs}ms`);
            }
            const text = data.text ?? '';
            if (text.trim()) {
              emptyTranscriptCountRef.current = 0;
              setLiveCaptionsUnavailable(false);
            } else {
              emptyTranscriptCountRef.current += 1;
              if (emptyTranscriptCountRef.current >= 5) setLiveCaptionsUnavailable(true);
            }
            return text;
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

      // Finalize one utterance. skipSamples/wsTime are captured at speech-end so that a
      // later onSpeechStart (which resets committedSamplesRef) cannot corrupt the slice.
      async function finalize(
        uStart: number, uEnd: number, audio: Float32Array,
        skipSamples: number, wsTime: number,
        partialWords: number, speechEndMs: number,
      ) {
        finalizeInFlightRef.current = true;
        const remaining = skipSamples > 0 ? audio.slice(skipSamples) : audio;
        const remainingStart = skipSamples > 0 ? wsTime : uStart;
        try {
          if (remaining.length === 0) {
            // All audio was committed by window auto-commits.
          } else if (remaining.length <= MAX_CHUNK_SAMPLES) {
            const text = await postWav(float32ToWavBlob(remaining));
            const networkElapsed = Date.now() - speechEndMs;
            const preRevealed = partialWords + Math.floor(networkElapsed / Math.round(1000 / WORDS_PER_SECOND));
            commitUtterance(remainingStart, uEnd, text, preRevealed);
          } else {
            const totalDuration = uEnd - remainingStart;
            let sampleStart = 0, chunkTimeStart = remainingStart;
            let firstChunk = true;
            while (sampleStart < remaining.length) {
              const sampleEnd = Math.min(sampleStart + MAX_CHUNK_SAMPLES, remaining.length);
              const chunkDuration = ((sampleEnd - sampleStart) / remaining.length) * totalDuration;
              const chunkTimeEnd = chunkTimeStart + chunkDuration;
              const text = await postWav(float32ToWavBlob(remaining, sampleStart, sampleEnd));
              if (text.trim()) {
                const networkElapsed = Date.now() - speechEndMs;
                const preRevealed = firstChunk
                  ? partialWords + Math.floor(networkElapsed / Math.round(1000 / WORDS_PER_SECOND))
                  : 0;
                commitUtterance(chunkTimeStart, chunkTimeEnd, text, preRevealed);
              }
              firstChunk = false;
              sampleStart = sampleEnd;
              chunkTimeStart = chunkTimeEnd;
            }
          }

          const next = pendingUtterancesRef.current.shift();
          if (next) {
            await finalize(next.start, next.end, next.audio, next.skip, next.windowStart, next.partialWords, next.speechEndMs);
          } else {
            if (utteranceStartRef.current === null) {
              const KEEP = 10;
              const keepFrom = Math.max(0, pcmFramesRef.current.length - KEEP);
              if (keepFrom > 0) {
                pcmFramesRef.current = pcmFramesRef.current.slice(keepFrom);
                pcmSpeechStartFrameRef.current = 0;
              }
            }
          }
        } finally {
          finalizeInFlightRef.current = false;
        }
      }

      function startPartialTimer() {
        if (partialTimerRef.current) return;
        partialTimerRef.current = setInterval(() => {
          if (utteranceStartRef.current === null) return;
          const currentFrame = pcmFramesRef.current.length;
          const framesInWindow = currentFrame - windowStartFrameRef.current;

          // Auto-commit: wait for the previous commit to finish (backpressure), then
          // send all accumulated frames in one adaptive-size request (2–15 s). This
          // prevents server queue build-up when hviske is slower than the window size —
          // the window simply grows to cover the gap instead of stacking requests.
          if (framesInWindow >= COMMIT_WINDOW_FRAMES && !windowCommitControllerRef.current) {
            const commitFrames = Math.min(framesInWindow, MAX_COMMIT_FRAMES);
            const commitEndFrame = windowStartFrameRef.current + commitFrames;
            const wav = buildWavBlob(windowStartFrameRef.current, commitEndFrame);
            if (!wav) return;
            const commitStart = windowStartTimeRef.current;
            const commitEnd = commitStart + (commitFrames * 1024) / 16_000;
            // Advance window synchronously so committedSamplesRef is correct when
            // onSpeechEnd fires and captures it for finalize's skip calculation.
            windowStartFrameRef.current = commitEndFrame;
            windowStartTimeRef.current = commitEnd;
            committedSamplesRef.current += commitFrames * 1024;
            interimTextRef.current = '…';
            setInterimText('…');
            const ctl = new AbortController();
            const t0 = Date.now();
            const audioDurS = (commitFrames * 1024 / 16_000).toFixed(1);
            windowCommitControllerRef.current = ctl;
            postWav(wav, ctl.signal).then((text) => {
              console.log(`[window-commit] ${audioDurS}s audio → ${Date.now() - t0}ms round-trip`);
              if (text.trim()) commitUtterance(commitStart, commitEnd, text);
            }).catch(() => {}).finally(() => {
              if (windowCommitControllerRef.current === ctl) windowCommitControllerRef.current = null;
            });
            return;
          }

          // Partial: trailing 2 s lookback so we only show genuinely new audio.
          // This prevents the growing-window "hindsight edit" where the model
          // re-transcribes earlier frames and subtly changes what was displayed.
          // Suppress partials while a window commit is in-flight — both compete for
          // the same hviske GPU capacity, and concurrent requests are the primary cause
          // of latency spikes. The '…' placeholder shown during commit is enough UX.
          if (partialInFlightRef.current || framesInWindow === 0 || windowCommitControllerRef.current) return;
          const partialStart = Math.max(windowStartFrameRef.current, currentFrame - PARTIAL_LOOKBACK_FRAMES);
          const capturedWindowStart = windowStartFrameRef.current;
          const wav = buildWavBlob(partialStart, currentFrame);
          if (!wav) return;
          partialInFlightRef.current = true;
          postWav(wav).then((text) => {
            if (utteranceStartRef.current === null) return;
            // Discard if the window already advanced (auto-commit fired while in-flight).
            if (windowStartFrameRef.current !== capturedWindowStart) return;
            interimTextRef.current = text || '…';
            setInterimText(text || '…');
          }).finally(() => {
            partialInFlightRef.current = false;
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
        // 900ms silence before declaring speech end — patient enough to handle natural
        // mid-sentence pauses without prematurely cutting the utterance.
        redemptionMs: 900,
        // 300ms pre-roll captures soft onsets; we also manually include pre-roll frames
        // when recording pcmSpeechStartFrameRef below.
        preSpeechPadMs: 300,
        positiveSpeechThreshold: 0.5,
        // Slightly higher threshold gives natural pauses more room before ending speech.
        negativeSpeechThreshold: 0.35,
        onSpeechStart: () => {
          utteranceStartRef.current = currentElapsed();
          // Include ~300 ms of pre-roll (≈5 frames × 1024 samples @ 16 kHz) so hviske
          // doesn't miss soft onsets at the start of the utterance.
          const preRollFrames = Math.round(16_000 * 0.3 / 1024);
          pcmSpeechStartFrameRef.current = Math.max(0, pcmFramesRef.current.length - preRollFrames);
          mergerRef.current.reset();
          windowStartFrameRef.current = pcmSpeechStartFrameRef.current;
          windowStartTimeRef.current = utteranceStartRef.current;
          committedSamplesRef.current = 0;
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
          // Snapshot committed state NOW — onSpeechStart for the next utterance will
          // reset committedSamplesRef/windowStartTimeRef, corrupting any deferred finalize.
          const capturedSkip = committedSamplesRef.current;
          const capturedWindowStart = windowStartTimeRef.current;
          // Capture partial state before clearing — used to pre-reveal words already shown.
          const capturedPartialWords = (interimTextRef.current && interimTextRef.current !== '…')
            ? interimTextRef.current.split(/\s+/).filter(Boolean).length
            : 0;
          const capturedSpeechEndMs = Date.now();
          utteranceStartRef.current = null;
          interimTextRef.current = '';
          setInterimText('');

          if (finalizeInFlightRef.current) {
            // Another finalize is running — queue this one; it will be drained when that finalize completes.
            pendingUtterancesRef.current.push({ start: uStart, end: uEnd, audio, skip: capturedSkip, windowStart: capturedWindowStart, partialWords: capturedPartialWords, speechEndMs: capturedSpeechEndMs });
            return;
          }

          await finalize(uStart, uEnd, audio, capturedSkip, capturedWindowStart, capturedPartialWords, capturedSpeechEndMs);

          // Batch accumulation for post-recording parallel transcription. Runs after
          // the live-caption finalize so it doesn't block it. Uses the same uStart/uEnd
          // captured above (before utteranceStartRef was cleared).
          const batchState = vadBatchStateRef.current;
          const wavOffset = batchState.pendingWavDuration;
          const wavDuration = audio.length / 16_000;
          batchState.pendingAudio.push(audio);
          batchState.pendingIntervals.push({ originalStart: uStart, originalEnd: uEnd, wavOffset, wavDuration });
          batchState.pendingWavDuration += wavDuration;
          if (batchState.pendingWavDuration >= BATCH_DURATION_S) sealCurrentBatch(batchState);
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
            if (!recordingActiveRef.current) return;
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
    setRecordingState('paused');

    // Pause VAD processing, flush the recorded tail, then pause the recorder.
    if (partialTimerRef.current) { clearInterval(partialTimerRef.current); partialTimerRef.current = null; }
    windowCommitControllerRef.current?.abort();
    windowCommitControllerRef.current = null;
    vadRef.current?.pause();
    await flushRecorder(recorder);
    recorder.pause();
    // Clear the flag BEFORE suspending so the onstatechange auto-resume handler
    // doesn't immediately undo the suspend (it guards on recordingActiveRef).
    recordingActiveRef.current = false;
    await audioContextRef.current?.suspend();
  }

  async function resumeRecording() {
    if (!mediaRecorderRef.current) return;
    const recorder = mediaRecorderRef.current;
    // Update pausedDuration FIRST — before any async gap — so currentElapsed() is
    // correct from the moment VAD's onSpeechStart fires. The previous order
    // (update after await) caused a race where onSpeechStart captured a timestamp
    // inflated by the full pause duration.
    pausedDurationRef.current += Date.now() - pauseStartRef.current;
    // Restore the flag BEFORE resuming so the onstatechange handler can auto-recover
    // from any future system-initiated suspensions once we're recording again.
    recordingActiveRef.current = true;
    // Await the resume so the AudioContext is fully running before pollVolume starts reading
    await audioContextRef.current?.resume();
    recorder.resume();
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

    // Compute accurate duration from refs before resuming the recorder (which would
    // change recorder.state). The React `elapsed` state may be up to 500 ms stale,
    // and doesn't account for the ongoing pause when stopped while paused.
    const ongoingPauseMs = recorder.state === 'paused' ? Date.now() - pauseStartRef.current : 0;
    const durationSeconds = Math.max(0, Math.floor(
      (Date.now() - startTimeRef.current - pausedDurationRef.current - ongoingPauseMs) / 1000
    ));

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

    // Seal any remaining speech into the final partial batch.
    sealCurrentBatch(vadBatchStateRef.current);
    const batches = vadBatchStateRef.current.readyBatches;

    // Archive the full WebM for storage — fire and forget, do NOT await before navigating.
    // storageOnly=true tells the server to skip background transcription; the client
    // handles transcription below and calls save-transcript directly.
    const archiveFormData = new FormData();
    archiveFormData.append('audio', blob, `recording.${extensionForMimeType(mimeType)}`);
    archiveFormData.append('meetingId', meetingId);
    archiveFormData.append('duration', String(durationSeconds));
    archiveFormData.append('storageOnly', 'true');
    const archivePromise = fetch('/api/transcribe', { method: 'POST', body: archiveFormData })
      .catch((err) => console.error('[archive] upload failed:', err));

    try {
      // Transcribe all VAD speech batches in parallel, then save the assembled transcript.
      setBatchProgress({ completed: 0, total: batches.length });
      let done = 0;
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
          console.error('[batch] transcription failed:', err);
          return [];
        } finally {
          setBatchProgress({ completed: ++done, total: batches.length });
        }
      });

      const segmentArrays = await runWithConcurrency(tasks, BATCH_CONCURRENCY);
      const segments = segmentArrays.flat().sort((a, b) => a.start - b.start);

      const saveRes = await fetch(`/api/meetings/${meetingId}/save-transcript`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segments }),
      });
      if (!saveRes.ok) throw new Error('Gem fejlede');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Noget gik galt under transskription');
      setIsUploading(false);
      setBatchProgress(null);
      return;
    }

    // Release batch memory before navigating.
    vadBatchStateRef.current = newVadBatchState();
    await archivePromise;
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

      {/* Live captions unavailable — recording still works */}
      {liveCaptionsUnavailable && (recordingState === 'recording' || recordingState === 'paused') && (
        <div style={{
          marginTop: 16, padding: '10px 14px', borderRadius: 'var(--radius)',
          borderLeft: '3px solid var(--accent)',
          background: 'var(--accent-wash)',
          fontSize: 13.5, color: 'var(--ink-2)',
        }}>
          Live-transskription er ikke tilgængelig — transskriptionsserveren svarer ikke. Optagelsen gemmes og kan transskriberes, når serveren er klar igen.
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
                animation: recordingState === 'recording' ? 'protoPulse 1.4s ease-in-out infinite' : 'none',
              }} />
              {recordingState === 'recording' ? 'transskriberer live' : recordingState === 'paused' ? 'pause' : 'klar'}
            </span>
            {recordingState === 'recording' && <span>· hviske live</span>}
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
                {liveSegments.map((seg) => {
                  const showSpeaker = seg.speaker !== '—';
                  return (
                    <div key={seg.start} style={{
                      display: 'grid', gridTemplateColumns: isMobile ? '44px 64px 1fr 14px' : '60px 90px 1fr 20px',
                      gap: 12, padding: '5px 18px',
                      fontFamily: 'var(--mono)', fontSize: 12.5, lineHeight: 1.65,
                    }}>
                      <span style={{ color: 'var(--accent)', animation: 'wordFadeIn 0.25s ease-out both' }}>{fmtSec(seg.start)}</span>
                      <span style={{ color: 'var(--ink)', fontWeight: 500, animation: 'wordFadeIn 0.25s ease-out both', animationDelay: '30ms' }}>
                        {showSpeaker ? `${seg.speaker.toLowerCase()}:` : '·'}
                      </span>
                      <span style={{ color: 'var(--ink-2)' }}>
                        {seg.text.split(' ').map((word, wi) => {
                          const delayMs = Math.max(0, (wi - seg.preRevealedWords) * Math.round(1000 / WORDS_PER_SECOND));
                          return (
                            <span key={wi} style={{
                              animation: 'wordFadeIn 0.25s ease-out both',
                              animationDelay: `${delayMs}ms`,
                            }}>{word}{' '}</span>
                          );
                        })}
                      </span>
                      <span style={{ color: 'var(--muted-2)', textAlign: 'right', animation: 'wordFadeIn 0.25s ease-out both', animationDelay: `${Math.max(0, (seg.text.split(' ').length - seg.preRevealedWords) * Math.round(1000 / WORDS_PER_SECOND))}ms` }}>★</span>
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
              style={{
                width: 56, height: 56, borderRadius: 999,
                background: 'var(--ink)', border: 'none',
                cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
              aria-label={recordingState === 'recording' ? 'Pause' : 'Fortsæt'}
            >
              {recordingState === 'recording' ? (
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
            {batchProgress && batchProgress.total > 0
              ? `transskriberer ${batchProgress.completed} / ${batchProgress.total} segmenter…`
              : 'transskriberer og gemmer…'}
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
        @keyframes wordFadeIn { from { opacity:0; } to { opacity:1; } }
      `}</style>
    </div>
  );
}
