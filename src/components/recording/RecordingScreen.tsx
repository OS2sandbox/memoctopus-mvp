'use client';

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
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
import { WaitingForTranscriptionPanel } from './WaitingForTranscriptionPanel';
import { InterruptedRecordingPanel } from './InterruptedRecordingPanel';
import { OnboardingHint } from '@/components/onboarding/OnboardingHint';
import { OnboardingTooltip } from '@/components/onboarding/OnboardingTooltip';
import { formatDuration, formatFileSize } from '@/lib/utils';
import { useIsMobile } from '@/lib/use-is-mobile';
import { pickRecordingMimeType } from '@/lib/audio/recording-format';
import {
  saveAudio, updateMeeting, deleteMeeting, getMeeting, getTranscript, getAudio,
  getRecordingSummary, listBatches, finalizeRecordingToTranscript,
} from '@/lib/storage';
import { startDiarization, finishDiarization } from '@/lib/audio/diarize-client';
import {
  float32ToWavBlob, newVadBatchState, sealCurrentBatch,
  BATCH_DURATION_S, MAX_WORDS_PER_LINE,
  type VadBatchState,
} from '@/lib/audio/vad-batch';
import { getBatchQueue } from '@/lib/recording/batch-queue';
import { connectivity, useConnectivity } from '@/lib/recording/connectivity';
import { setLeaveGuard } from '@/lib/recording/leave-guard';
import { finishRecording } from '@/lib/recording/finish';

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
  // Bulk-copy each Int16 frame through a typed-array view (44-byte header is
  // 2-byte aligned) instead of a per-sample DataView loop.
  const out = new Int16Array(buf, 44, totalSamples);
  let off = 0;
  for (const frame of frames) { out.set(frame, off); off += frame.length; }
  return new Blob([buf], { type: 'audio/wav' });
}

// The VAD's model and runtime load from the server. Without the VAD nothing is cut
// into batches, so a recording started without it would yield no transcript at all.
class VadUnavailableError extends Error {}

interface LiveSegment {
  speaker: string;
  start: number;
  end: number;
  text: string;
  preRevealedWords: number;
  waveElapsedAtCommitMs: number;
  waveIntervalMs: number;
}

// What the ledger says about an interrupted recording, which resuming continues.
type RecordingSummary = NonNullable<Awaited<ReturnType<typeof getRecordingSummary>>>;

interface ClarificationItem {
  question: string;
  context?: string;
}

interface RecordingScreenProps {
  meetingId: string;
  existingRecording?: { durationSeconds: number | null; sizeBytes: number };
  // True when this is a live, in-progress recording session (meeting status
  // 'recording'). A hard refresh of such a session loses the in-memory recording.
  // When the ledger holds its batches the screen offers to resume or finish it;
  // with no rows there is nothing to resume, so we send the user to the dashboard
  // rather than auto-starting a new one.
  isActiveRecording?: boolean;
  onNavigateToReview?: () => void;
  onRecordingComplete?: () => void;
}

type RecordingState = 'idle' | 'recording' | 'paused' | 'stopped';

const BYTES_PER_SECOND_ESTIMATE = 16_000;
const SILENCE_THRESHOLD_SECONDS = 5;
const SILENCE_VOLUME_THRESHOLD = 0.02;
// 15 s at 16 kHz — max audio per hviske call, also the early-commit threshold.
const MAX_CHUNK_SAMPLES = 16_000 * 15;
// Minimum frames before triggering an auto-commit. The actual commit is adaptive —
// all frames accumulated since the last commit (up to MAX_COMMIT_FRAMES) are sent
// in one request so the window grows instead of queuing when the server is slow.
const COMMIT_WINDOW_FRAMES = Math.ceil((16_000 * 4) / 1024);
// Ceiling for one adaptive commit (9 s). Keeps the cascade damage of a single timeout
// bounded: at most 9 s of audio is lost per timeout, not the full MAX_CHUNK_SAMPLES.
const MAX_COMMIT_FRAMES = COMMIT_WINDOW_FRAMES * 3;
// Partial interim uses a trailing 4 s lookback instead of the full growing window.
// This means the partial only ever shows NEW audio — no hindsight re-transcription.
const PARTIAL_LOOKBACK_FRAMES = Math.ceil((16_000 * 4) / 1024);
// Slower partial ticks — less impatient, more accurate with longer context.
const PARTIAL_INTERVAL_MS = 1500;
// Max rate at which committed segment words are revealed left-to-right (no prior partial).
const WORDS_PER_SECOND = 10;
// Slower wave rate for the continuous live wave (interim → final carry-over).
// Must be slow enough that the wave is visibly in-progress when interim text first appears.
const LIVE_WAVE_INTERVAL_MS = 300;
// How often, while recording, we re-analyze the transcript for things to clarify.
const CLARIFY_INTERVAL_MS = 25_000;
// Tick cadence for the countdown bar to the next clarification refresh.
const CLARIFY_TICK_MS = 250;
const SAVED_RECORDING_UNREADABLE = 'Den gemte optagelse kunne ikke indlæses. Genindlæs siden, og prøv igen.';

export function RecordingScreen({ meetingId, existingRecording, isActiveRecording, onNavigateToReview, onRecordingComplete }: RecordingScreenProps) {
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
  // Stopped, with batches the queue has not sent yet: the waiting panel shows.
  const [waitingForQueue, setWaitingForQueue] = useState(false);
  // Opened on a recording that was left mid-meeting; the screen offers to resume,
  // finish or delete it until one is chosen.
  const [interrupted, setInterrupted] = useState<RecordingSummary | null>(null);
  // True when the transcription server keeps answering with no text — the batch
  // transcript still works, but the live interim captions won't show. A lost
  // connection is reported by connectivity instead.
  const [liveCaptionsUnavailable, setLiveCaptionsUnavailable] = useState(false);
  const online = useConnectivity();
  // One queue per meeting, outliving this screen; it owns sending the sealed batches.
  const queue = getBatchQueue(meetingId);
  const queueState = useSyncExternalStore(queue.subscribe, queue.getState, queue.getState);
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
  // Silero VAD instance (created by loadVAD and assigned in startRecording,
  // destroyed on stop/cancel).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vadRef = useRef<any>(null);
  // Elapsed-seconds mark when VAD fires onSpeechStart, for accurate segment timestamps.
  const utteranceStartRef = useRef<number | null>(null);
  // Wall-clock ms when the current utterance (wave) started.
  // Shifted forward whenever the wave idles past the last visible word (see wave-pause logic).
  const waveStartMsRef = useRef<number | null>(null);
  // Word count of the most recent partial, used to detect wave over-run.
  const prevInterimWordCountRef = useRef(0);
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
    partialWords: number; speechEndMs: number; waveStartMs: number;
  }>>([]);
  const partialTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // VAD batch state for post-recording parallel transcription.
  const vadBatchStateRef = useRef<VadBatchState>(newVadBatchState());
  // The seq the batch being recorded gets when it is sealed, which is also how many
  // batches have been sealed so far.
  const nextSeqRef = useRef(0);
  // The ledger's session number for this recording: 0, then one more per resume.
  const sessionRef = useRef(0);
  // Where this session starts on the meeting's timeline when it resumed an
  // interrupted recording. Its audio covers only this session, so it is diarized
  // from here and not kept for playback.
  const resumedAtRef = useRef<number | undefined>(undefined);
  // Ledger writes (checkpoints and sealed batches) in the order they were made. Stop
  // and unmount wait for it before reading the ledger.
  const batchWritesRef = useRef<Promise<void>>(Promise.resolve());
  // What saving needs once the queue has sent everything, possibly long after stop.
  const stoppedRef = useRef<{
    blob: Blob; mimeType: string; durationSeconds: number;
    diarization: ReturnType<typeof startDiarization> | null;
  } | null>(null);
  const settlingRef = useRef(false);
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
    nextSeqRef.current = 0;
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
  function commitUtterance(start: number, end: number, text: string, preRevealedWords = 0, waveElapsedAtCommitMs = 0) {
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
    // Use the live wave interval when there was a prior partial wave; otherwise the
    // faster per-word rate for utterances that were too short for any partial to appear.
    const segIntervalMs = waveElapsedAtCommitMs > 0 ? LIVE_WAVE_INTERVAL_MS : Math.round(1000 / WORDS_PER_SECOND);
    let t = start;
    let wordsAssigned = 0;
    const newSegs: LiveSegment[] = sentences.map((sentence, i) => {
      const segEnd = t + (wordCounts[i] / totalWords) * duration;
      // First sentence inherits the full pre-revealed offset. Subsequent sentences
      // subtract the words already assigned so only genuinely new words animate.
      const segPreRevealed = Math.max(0, preRevealedWords - wordsAssigned);
      // waveElapsedAtCommitMs is adjusted per sentence: words already assigned to prior
      // sentences have already been swept by the wave, so shift the elapsed time forward.
      const segWaveElapsed = waveElapsedAtCommitMs - wordsAssigned * segIntervalMs;
      wordsAssigned += wordCounts[i];
      const seg: LiveSegment = { speaker: '—', start: t, end: segEnd, text: sentence, preRevealedWords: segPreRevealed, waveElapsedAtCommitMs: segWaveElapsed, waveIntervalMs: segIntervalMs };
      t = segEnd;
      return seg;
    });
    const updated = [...liveSegmentsRef.current, ...newSegs].sort((a, b) => a.start - b.start);
    liveSegmentsRef.current = updated;
    setLiveSegments(updated);
    setTimeout(() => transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
  }

  // Load Silero VAD on the given stream (started by the caller). Uses raw 16 kHz PCM frames from the AudioWorklet.
  //   • Partials every 700 ms: growing window (speechStart → now), capped at 15 s.
  //     Below the cap, LocalAgreementMerger locks in stable words across partials.
  //     Above the cap, a sliding 15 s window is used and the merger is bypassed.
  //   • Finalization on onSpeechEnd: sends the exact utterance audio, split into 15 s
  //     chunks when necessary so hviske never exceeds its 12 s server timeout.
  async function loadVAD(stream: MediaStream) {
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
      // Offline, live captions pause: nothing is sent and the text is empty.
      async function postWav(blob: Blob, externalSignal?: AbortSignal): Promise<string> {
        if (!connectivity.isOnline()) return '';
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
          connectivity.reportSuccess();
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
            connectivity.reportNetworkFailure();
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
        partialWords: number, speechEndMs: number, waveStartMs: number,
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
            // Absorb any idle overshoot between speech-end and API return so the wave
            // resumes from the partial frontier rather than the real elapsed time.
            const maxWaveMs = partialWords * LIVE_WAVE_INTERVAL_MS;
            const rawElapsed = Date.now() - waveStartMs;
            const waveElapsed = Math.min(rawElapsed, maxWaveMs);
            commitUtterance(remainingStart, uEnd, text, preRevealed, waveElapsed);
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
                const maxWaveMs = (firstChunk ? partialWords : 0) * LIVE_WAVE_INTERVAL_MS;
                const rawElapsed = Date.now() - waveStartMs;
                const waveElapsed = firstChunk ? Math.min(rawElapsed, maxWaveMs) : rawElapsed;
                commitUtterance(chunkTimeStart, chunkTimeEnd, text, preRevealed, waveElapsed);
              }
              firstChunk = false;
              sampleStart = sampleEnd;
              chunkTimeStart = chunkTimeEnd;
            }
          }

          const next = pendingUtterancesRef.current.shift();
          if (next) {
            await finalize(next.start, next.end, next.audio, next.skip, next.windowStart, next.partialWords, next.speechEndMs, next.waveStartMs);
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
          // Safety cleanup: if finalize completed without calling commitUtterance
          // (e.g. remaining.length === 0, or postWav threw) and no new speech started,
          // clear any stale interim text that was kept visible during the in-flight period.
          if (utteranceStartRef.current === null && interimTextRef.current) {
            interimTextRef.current = '';
            setInterimText('');
          }
        }
      }

      function startPartialTimer() {
        if (partialTimerRef.current) return;
        partialTimerRef.current = setInterval(() => {
          if (utteranceStartRef.current === null || !connectivity.isOnline()) return;
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
              if (text.trim()) {
                const waveElapsed = waveStartMsRef.current !== null ? Date.now() - waveStartMsRef.current : 0;
                commitUtterance(commitStart, commitEnd, text, 0, waveElapsed);
              }
            }).catch((err) => {
              console.error('[window-commit] postWav failed:', err);
            }).finally(() => {
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
            if (text && waveStartMsRef.current === null) waveStartMsRef.current = Date.now();
            // Wave-pause: if the wave ran past the previous word frontier while waiting
            // for this partial, absorb the idle overshoot so the new words continue
            // from position 0 (one LIVE_WAVE_INTERVAL_MS after the last revealed word).
            if (text && waveStartMsRef.current !== null) {
              const newWordCount = text.split(/\s+/).filter(Boolean).length;
              const prevCount = prevInterimWordCountRef.current;
              if (newWordCount > prevCount) {
                const realElapsed = Date.now() - waveStartMsRef.current;
                const maxWaveMs = prevCount * LIVE_WAVE_INTERVAL_MS;
                const excess = Math.max(0, realElapsed - maxWaveMs);
                if (excess > 0) waveStartMsRef.current += excess;
              }
              prevInterimWordCountRef.current = newWordCount;
            }
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
        // 1200ms silence before declaring speech end — patient enough to ride out
        // natural mid-sentence pauses so the VAD doesn't chop utterances into short,
        // imprecise fragments.
        redemptionMs: 1200,
        // 300ms pre-roll captures soft onsets; we also manually include pre-roll frames
        // when recording pcmSpeechStartFrameRef below.
        preSpeechPadMs: 300,
        // Higher start threshold makes the VAD less twitchy — it won't fire on faint
        // background noise, only on clear speech.
        positiveSpeechThreshold: 0.6,
        // Slightly higher threshold gives natural pauses more room before ending speech.
        negativeSpeechThreshold: 0.35,
        onSpeechStart: () => {
          utteranceStartRef.current = currentElapsed();
          waveStartMsRef.current = null; // set when first real partial text appears
          prevInterimWordCountRef.current = 0;
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
          const capturedWaveStartMs = waveStartMsRef.current ?? capturedSpeechEndMs;
          utteranceStartRef.current = null;
          waveStartMsRef.current = null;
          // Into the batch transcript first: it must not wait on, or depend on, the
          // live caption below (queued behind another finalize, or paused offline).
          accumulateBatch(uStart, uEnd, audio);
          // Keep interim text visible while the final transcription is in-flight so
          // there is no blank gap between partial display and committed segment arrival.

          if (finalizeInFlightRef.current) {
            // Another finalize is running — queue this one; it will be drained when that finalize completes.
            pendingUtterancesRef.current.push({ start: uStart, end: uEnd, audio, skip: capturedSkip, windowStart: capturedWindowStart, partialWords: capturedPartialWords, speechEndMs: capturedSpeechEndMs, waveStartMs: capturedWaveStartMs });
            return;
          }

          await finalize(uStart, uEnd, audio, capturedSkip, capturedWindowStart, capturedPartialWords, capturedSpeechEndMs, capturedWaveStartMs);
        },
        onVADMisfire: () => {
          stopPartialTimer();
          utteranceStartRef.current = null;
          waveStartMsRef.current = null;
          prevInterimWordCountRef.current = 0;
          mergerRef.current.reset();
          interimTextRef.current = '';
          setInterimText('');
        },
      });
      return vad;
    } catch (err) {
      console.error('[loadVAD] setup failed:', err);
      throw new VadUnavailableError();
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
    if (liveSegmentsRef.current.length === 0 || !connectivity.isOnline()) return;
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

  async function startRecording(resume?: {
    nextSeq: number; session: number; timelineEnd: number; earlier: LiveSegment[];
  }) {
    setError(null);
    // The VAD loads from the server, and a recording without it yields nothing.
    if (!connectivity.isOnline()) {
      setError('Optagelsen kan ikke starte uden forbindelse til serveren. Prøv igen, når du er online.');
      return;
    }
    resetLiveState();
    sessionRef.current = resume?.session ?? 0;
    resumedAtRef.current = resume?.timelineEnd;
    if (resume) {
      nextSeqRef.current = resume.nextSeq;
      liveSegmentsRef.current = resume.earlier;
      setLiveSegments(resume.earlier);
    }
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

      vadRef.current = await loadVAD(stream);

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
      // Surface a recorder fault (e.g. another app — a screen/video recorder —
      // grabbing the audio device mid-recording) instead of letting it silently
      // corrupt or truncate the final blob.
      recorder.onerror = (e) => {
        console.error('[recorder] error:', e);
        // Stop recording cleanly and surface the fault so the user knows the
        // recording was interrupted (rather than seeing a silently empty result).
        recordingActiveRef.current = false;
        clearIntervals();
        vadRef.current?.destroy();
        vadRef.current = null;
        pcmWorkletNodeRef.current?.disconnect();
        pcmWorkletNodeRef.current = null;
        audioContextRef.current?.close();
        audioContextRef.current = null;
        setRecordingState('stopped');
        setError('Optagelsen blev afbrudt af en fejl i lydenheden. Gem hvad der er optaget, eller start forfra.');
      };

      recorder.start(1000);
      // A resumed recording goes on from where the interrupted one reached, so its
      // timestamps continue the meeting's timeline, as they do after a pause.
      const resumedAt = resume?.timelineEnd ?? 0;
      startTimeRef.current = Date.now() - resumedAt * 1000;
      pausedDurationRef.current = 0;
      recordingActiveRef.current = true;
      setRecordingState('recording');
      setElapsed(Math.floor(resumedAt));

      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startTimeRef.current - pausedDurationRef.current) / 1000));
      }, 500);

      animFrameRef.current = requestAnimationFrame(pollVolume);
      startClarifyTimer();

      vadRef.current.start();
    } catch (err) {
      // Release the mic if we acquired it but failed during setup — otherwise it stays locked
      stream?.getTracks().forEach((t) => t.stop());
      vadRef.current?.destroy();
      vadRef.current = null;
      pcmWorkletNodeRef.current?.disconnect();
      pcmWorkletNodeRef.current = null;
      audioContextRef.current?.close();
      audioContextRef.current = null;
      analyserRef.current = null;
      console.error('[startRecording]', err);

      if (err instanceof VadUnavailableError) {
        setError('Optagelsen blev ikke startet, fordi talegenkendelsen ikke kunne indlæses. Genindlæs siden, og prøv igen.');
      } else if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) {
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

  // Auto-start when navigated here from the home page record button. The
  // autostart flag is then stripped from the URL so a hard refresh doesn't start a
  // brand-new recording. Otherwise the ledger decides: rows on a `recording` meeting
  // are an interrupted recording, offered for resuming; rows on a `processing` one
  // are a stopped recording still waiting for transcription. A live recording that
  // left no rows has nothing to resume, so we send the user back to the dashboard.
  const didAutostart = useRef(false);
  useEffect(() => {
    if (didAutostart.current) return;
    didAutostart.current = true;
    if (existingRecording) return;
    if (searchParams.get('autostart') === '1') {
      // Autostart does not read the ledger: on a meeting with rows it would start over at seq 0 and write over them.
      // shortcut: autostart skips the ledger, revisit if ?autostart=1 is ever used on anything but a brand-new meeting
      startRecording();
      router.replace(`/meeting/${meetingId}`, { scroll: false });
      return;
    }
    void (async () => {
      const [meeting, summary] = await Promise.all([getMeeting(meetingId), getRecordingSummary(meetingId)]);
      if (summary) nextSeqRef.current = summary.nextSeq;
      if (summary && meeting?.status === 'recording') setInterrupted(summary);
      else if (summary && meeting?.status === 'processing') await finishWithoutAudio();
      else if (isActiveRecording) router.replace('/dashboard');
    })().catch((err: unknown) => {
      console.error('[RecordingScreen] reading the recording ledger failed:', err);
      setError(SAVED_RECORDING_UNREADABLE);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Continues an interrupted recording as a new session: the earlier text stays on
  // screen, and batches the interruption left untranscribed are sent again.
  async function resumeInterrupted(summary: RecordingSummary) {
    let earlier: LiveSegment[];
    try {
      await queue.adoptPersisted();
      earlier = (await listBatches(meetingId)).flatMap((batch) => batch.segments ?? []).map((segment) => ({
        speaker: '—', start: segment.start, end: segment.end, text: segment.text,
        // Already said, so shown at once rather than revealed word by word.
        preRevealedWords: 0, waveElapsedAtCommitMs: 250, waveIntervalMs: 0,
      }));
    } catch (err) {
      console.error('[RecordingScreen] loading the interrupted recording failed:', err);
      setError(SAVED_RECORDING_UNREADABLE);
      return;
    }
    await startRecording({
      nextSeq: summary.nextSeq, session: summary.nextSession, timelineEnd: summary.timelineEnd, earlier,
    });
  }

  // Finishes a recording that has no audio here to diarize or keep: an interrupted
  // one finished without resuming, or a stopped one opened again while batches still
  // wait. Once the queue has sent everything, the ledger becomes the transcript the
  // way RecordingRecovery does it; finalizeRecordingToTranscript is idempotent, so
  // both may do it.
  async function finishWithoutAudio() {
    if (settlingRef.current) return;
    settlingRef.current = true;
    setInterrupted(null);
    setRecordingState('stopped');
    setIsUploading(true);
    try {
      await queue.adoptPersisted();
      if (queue.getState().waiting > 0) {
        // shortcut: a reopened waiting recording shows no earlier text, revisit if users find the waiting screen confusing
        await updateMeeting(meetingId, { status: 'processing' });
        setWaitingForQueue(true);
        return;
      }
      setWaitingForQueue(false);
      // Written before the transcript moves the meeting to `review`.
      await updateMeeting(meetingId, { audioDeleted: true });
      await finalizeRecordingToTranscript(meetingId, { diarizationStatus: 'done' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Noget gik galt under transskription');
      setIsUploading(false);
      return;
    } finally {
      settlingRef.current = false;
    }
    onRecordingComplete?.();
    router.push(`/meeting/${meetingId}/review`);
  }

  function clearIntervals() {
    if (timerRef.current) clearInterval(timerRef.current);
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    stopClarifyTimer();
  }

  // ── Batches: checkpointed while open, queued for transcription once sealed ────

  function writeBatch(write: () => Promise<void>) {
    // The queue reports its own write failures; what can fail here is reading the
    // WAV out of its Blob, which loses that one batch. The chain must go on.
    batchWritesRef.current = batchWritesRef.current.then(write).catch((err: unknown) => {
      console.error('[batch] reading a sealed batch\'s audio failed, the batch is lost:', err);
    });
  }

  // Hand every sealed batch to the queue, which stores it with its audio and sends it
  // until it has its text, also after this screen is gone.
  function enqueueSealedBatches() {
    for (const batch of vadBatchStateRef.current.readyBatches.splice(0)) {
      const seq = nextSeqRef.current++;
      writeBatch(async () => queue.enqueue({
        seq,
        session: sessionRef.current,
        wav: await batch.wav.arrayBuffer(),
        intervals: batch.intervals,
        totalWavDuration: batch.totalWavDuration,
      }));
    }
  }

  // Store the batch still being recorded, so a closed tab loses at most the
  // utterance in progress.
  function checkpointOpenBatch() {
    const { pendingAudio, pendingIntervals, pendingWavDuration } = vadBatchStateRef.current;
    if (pendingAudio.length === 0) return;
    const samples = new Float32Array(pendingAudio.reduce((n, a) => n + a.length, 0));
    let offset = 0;
    for (const a of pendingAudio) { samples.set(a, offset); offset += a.length; }
    const wav = float32ToWavBlob(samples);
    const seq = nextSeqRef.current;
    const intervals = [...pendingIntervals];
    writeBatch(async () => queue.checkpoint({
      seq, session: sessionRef.current, wav: await wav.arrayBuffer(), intervals, totalWavDuration: pendingWavDuration,
    }));
  }

  // Accumulate one finalized utterance into the batch transcript. Called for EVERY
  // utterance the VAD ends, before its live caption is requested, so the final
  // transcript never depends on the caption path (queued under load, or paused offline).
  function accumulateBatch(uStart: number, uEnd: number, audio: Float32Array) {
    const batchState = vadBatchStateRef.current;
    const wavOffset = batchState.pendingWavDuration;
    const wavDuration = audio.length / 16_000;
    batchState.pendingAudio.push(audio);
    batchState.pendingIntervals.push({ originalStart: uStart, originalEnd: uEnd, wavOffset, wavDuration });
    batchState.pendingWavDuration += wavDuration;
    if (batchState.pendingWavDuration >= BATCH_DURATION_S) {
      sealCurrentBatch(batchState);
      enqueueSealedBatches();
    } else {
      checkpointOpenBatch();
    }
  }

  // If we stopped (or left) MID-UTTERANCE, the VAD's onSpeechEnd never fired, so this
  // utterance was shown live (via the window-commit path) but never added to the
  // batch transcript. That's why a long, pause-free recording produced an empty
  // final transcript while short clips (which end on a natural pause → onSpeechEnd)
  // worked. Flush the in-progress utterance's raw PCM into the batch now, in
  // <=BATCH_DURATION_S chunks so each stays within hviske's window.
  function flushUtteranceInProgress() {
    if (utteranceStartRef.current === null) return;
    const startFrame = pcmSpeechStartFrameRef.current;
    const int16Frames = pcmFramesRef.current.slice(startFrame);
    const totalSamples = int16Frames.reduce((n, f) => n + f.length, 0);
    if (totalSamples > 0) {
      const uStart = utteranceStartRef.current;
      const uEnd = currentElapsed();
      const all = new Float32Array(totalSamples);
      let off = 0;
      for (const fr of int16Frames) { for (let i = 0; i < fr.length; i++) all[off++] = fr[i] / 32768; }
      const samplesPerChunk = 16_000 * BATCH_DURATION_S;
      for (let s = 0; s < all.length; s += samplesPerChunk) {
        const chunk = all.slice(s, Math.min(s + samplesPerChunk, all.length));
        const cStart = uStart + (s / all.length) * (uEnd - uStart);
        const cEnd = uStart + ((s + chunk.length) / all.length) * (uEnd - uStart);
        accumulateBatch(cStart, cEnd, chunk);
      }
    }
    utteranceStartRef.current = null;
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

    // Wait for the recorder to flush its final chunk, but NEVER hang on it. A
    // recorder whose audio device was disrupted mid-recording (e.g. another app —
    // a screen/video recorder — grabbed the mic) can already be 'inactive' or
    // never emit 'stop', and recorder.stop() then throws InvalidStateError. The
    // final transcript comes from the VAD batches (not this blob), so a stuck
    // recorder must not block transcript assembly + diarization below.
    await new Promise<void>((resolve) => {
      if (recorder.state === 'inactive') { resolve(); return; }
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      recorder.addEventListener('stop', finish, { once: true });
      recorder.addEventListener('error', finish, { once: true });
      setTimeout(finish, 5000); // fallback: a stuck recorder can't hang the flow
      try { recorder.stop(); } catch { finish(); }
    });
    recorder.stream.getTracks().forEach((t) => t.stop());

    setRecordingState('stopped');
    setIsUploading(true);

    const mimeType = recorder.mimeType || 'audio/webm';
    const blob = new Blob(chunksRef.current, { type: mimeType });
    // Diarize the full recording in parallel with transcription, but DON'T block on
    // it — the transcript is saved and shown with default labels, and speaker labels
    // are patched in (and the review screen refreshed) when diarization lands.
    // Offline, it is started once the transcript is saved.
    stoppedRef.current = {
      blob, mimeType, durationSeconds,
      diarization: connectivity.isOnline() ? startDiarization(meetingId, blob) : null,
    };

    // Seal the remaining speech into the final partial batch. Earlier batches were
    // queued as they sealed, so most of them usually have their text already.
    flushUtteranceInProgress();
    sealCurrentBatch(vadBatchStateRef.current);
    enqueueSealedBatches();
    await batchWritesRef.current;
    vadBatchStateRef.current = newVadBatchState();

    await settleStoppedRecording();
  }

  // Saves the stopped recording once every batch has its text. Until then the
  // meeting is `processing` and the waiting panel shows; the effect below calls this
  // again when the queue has sent everything, however long that takes.
  async function settleStoppedRecording() {
    const stopped = stoppedRef.current;
    if (!stopped || settlingRef.current) return;
    settlingRef.current = true;
    const resumedAt = resumedAtRef.current;
    try {
      // Written before the transcript moves the meeting to `review`.
      if (resumedAt !== undefined) await updateMeeting(meetingId, { audioDeleted: true });
      const outcome = await finishRecording(meetingId);
      setWaitingForQueue(outcome === 'waiting');
      if (outcome === 'waiting') return;
      stoppedRef.current = null;
      if (outcome === 'empty') {
        setError('Ingen tale fundet i optagelsen. Var mikrofonen aktiv og ikke slået fra?');
        setIsUploading(false);
        return;
      }
      // The transcript is saved with diarizationStatus 'pending'; patch in speaker
      // labels (and clear the pending state) once diarization finishes.
      void (stopped.diarization ?? startDiarization(meetingId, stopped.blob))
        .then((turns) => finishDiarization(meetingId, turns, resumedAt));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Noget gik galt under transskription');
      setIsUploading(false);
      return;
    } finally {
      settlingRef.current = false;
    }

    // A resumed recording's earlier sessions have no audio left, so none is kept.
    if (resumedAt !== undefined) {
      onRecordingComplete?.();
      router.push(`/meeting/${meetingId}/review`);
      return;
    }

    // Now that a transcript exists, archive the audio for playback during review.
    try {
      await saveAudio(meetingId, stopped.blob, stopped.mimeType);
      await updateMeeting(meetingId, { audioSizeBytes: stopped.blob.size, audioDurationSeconds: stopped.durationSeconds });
    } catch (err) {
      // The transcript is already saved; only the audio archive failed (e.g. quota
      // exceeded or private-browsing). Warn so the user knows playback may not work,
      // but the review is still available via the transcript.
      console.error('[archive] save failed:', err);
      setError('Transskriptionen er gemt, men lydfilen kunne ikke gemmes lokalt (muligvis fuld lageropbevaring). Gennemgang er stadig tilgængelig.');
      setIsUploading(false);
      return;
    }
    onRecordingComplete?.();
    router.push(`/meeting/${meetingId}/review`);
  }

  useEffect(() => {
    if (!waitingForQueue || queueState.waiting > 0) return;
    void (stoppedRef.current ? settleStoppedRecording() : finishWithoutAudio());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingForQueue, queueState.waiting]);

  // Leaving while recording interrupts it: the browser asks first, and so does the app's own navigation.
  useEffect(() => {
    setLeaveGuard(recordingState === 'recording' || recordingState === 'paused');
  }, [recordingState]);

  // A hidden tab may be closed or discarded without warning; store the open batch first.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && mediaRecorderRef.current?.state === 'recording') {
        checkpointOpenBatch();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function confirmOverwrite() {
    setIsOverwriting(true);
    await updateMeeting(meetingId, {
      status: 'recording',
      audioDeleted: false,
      audioSizeBytes: 0,
      audioDurationSeconds: null,
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
    // A batch write still in progress would otherwise put rows back after the delete.
    await batchWritesRef.current;
    await deleteMeeting(meetingId);
    router.push('/dashboard');
  }

  // Leaving mid-recording keeps what was recorded: the open batch, with the
  // utterance in progress, is sealed and queued (the queue outlives this screen),
  // and the meeting stays `recording` with ledger rows, i.e. interrupted. Only a
  // recording that left nothing behind — no transcript, no saved audio and no
  // ledger rows — is deleted, so it doesn't clutter the Arkiv. The async read also
  // doubles as a StrictMode guard: dev's mount→cleanup→mount remounts before the
  // read resolves, so instanceMountedRef is true again and we skip.
  const instanceMountedRef = useRef(false);
  useEffect(() => {
    instanceMountedRef.current = true;
    return () => {
      instanceMountedRef.current = false;
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        flushUtteranceInProgress();
        sealCurrentBatch(vadBatchStateRef.current);
        enqueueSealedBatches();
      }
      setLeaveGuard(false);
      recordingActiveRef.current = false;
      clearIntervals();
      vadRef.current?.destroy();
      vadRef.current = null;
      pcmWorkletNodeRef.current?.disconnect();
      pcmWorkletNodeRef.current = null;
      audioContextRef.current?.close();
      audioContextRef.current = null;
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      recorder?.stream.getTracks().forEach((t) => t.stop());
      mediaRecorderRef.current = null;

      void (async () => {
        await batchWritesRef.current;
        const [m, t, a, ledger] = await Promise.all([
          getMeeting(meetingId), getTranscript(meetingId), getAudio(meetingId), getRecordingSummary(meetingId),
        ]);
        if (instanceMountedRef.current) return; // remounted (StrictMode) — not a real unmount
        if (m && m.status === 'recording' && !t && !a && !ledger) {
          await deleteMeeting(meetingId).catch((err) => {
            console.error('[RecordingScreen] abandoned-meeting cleanup failed:', err);
          });
        }
      })();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const estimatedSize = elapsed * BYTES_PER_SECOND_ESTIMATE;
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;
  const elapsedFormatted = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

  const showLivePanel = recordingState === 'recording' || recordingState === 'paused' || liveSegments.length > 0;

  const cancelDialog = (
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
  );

  // ── Interrupted (reopened after leaving mid-recording) ───────────────────────
  // Stays until a session has started, so a failed resume shows its error here.
  if (interrupted && recordingState === 'idle') {
    return (
      <div style={{ minHeight: 'calc(100vh - 56px - 47px)', padding: isMobile ? '24px 20px 24px' : '32px 48px 24px' }}>
        <InterruptedRecordingPanel
          savedSeconds={interrupted.timelineEnd}
          onResume={() => void resumeInterrupted(interrupted)}
          onFinish={() => void finishWithoutAudio()}
          onDelete={() => setShowCancelDialog(true)}
        />
        {error && (
          <div style={{
            marginTop: 16, padding: '12px 16px', borderRadius: 'var(--radius)',
            background: 'var(--kill-wash)', borderLeft: '3px solid var(--kill)',
            fontSize: 13.5, color: 'var(--kill)',
          }}>
            {error}
          </div>
        )}
        {cancelDialog}
      </div>
    );
  }

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
        <OnboardingTooltip stepId="recording.signal-bars">
          <div tabIndex={0} style={{ paddingBottom: 6 }}>
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
        </OnboardingTooltip>

        <div style={{ marginLeft: 'auto', textAlign: 'right', paddingBottom: 6 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', letterSpacing: 0.4 }}>lagring</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--ink-2)', marginTop: 6 }}>
            {elapsed > 0 ? `${formatFileSize(estimatedSize)} · webm/opus · lokal` : 'klar til optagelse'}
          </div>
        </div>
      </div>

      {/* Audio lifecycle notice (direct-microphone path) */}
      <OnboardingHint stepId="recording.audio-lifecycle">
        <div style={{ marginTop: 8, fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted)' }}>
          lyden gemmes lokalt og slettes automatisk, når referatet er lavet
        </div>
      </OnboardingHint>

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

      {/* Offline — recording continues, live captions wait for the connection */}
      {!online && (recordingState === 'recording' || recordingState === 'paused') && (
        <div role="status" style={{
          marginTop: 16, padding: '10px 14px', borderRadius: 'var(--radius)',
          borderLeft: '3px solid var(--accent)',
          background: 'var(--accent-wash)',
          fontSize: 13.5, color: 'var(--ink-2)',
        }}>
          Ingen forbindelse til serveren. Optagelsen fortsætter, og live-transskriptionen er sat på pause, indtil du er online igen.
        </div>
      )}

      {/* Live captions unavailable — recording still works */}
      {liveCaptionsUnavailable && online && (recordingState === 'recording' || recordingState === 'paused') && (
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
                  return (
                    <div key={seg.start} style={{
                      display: 'grid', gridTemplateColumns: isMobile ? '44px 1fr 14px' : '60px 1fr 20px',
                      gap: 12, padding: '5px 18px',
                      fontFamily: 'var(--mono)', fontSize: 12.5, lineHeight: 1.65,
                    }}>
                      <span style={{ color: 'var(--accent)', animation: 'wordFadeIn 0.25s ease-out both' }}>{fmtSec(seg.start)}</span>
                      <span style={{ color: 'var(--ink-2)' }}>
                        {seg.text.split(' ').map((word, wi) => {
                          const rawDelay = wi * seg.waveIntervalMs - seg.waveElapsedAtCommitMs;
                          if (rawDelay <= -250) {
                            return <span key={wi}>{word}{' '}</span>;
                          }
                          return (
                            <span key={wi} style={{
                              animation: 'wordFadeIn 0.25s ease-out both',
                              animationDelay: `${Math.max(-250, rawDelay)}ms`,
                            }}>{word}{' '}</span>
                          );
                        })}
                      </span>
                      <OnboardingTooltip stepId="recording.star-marker">
                        <span tabIndex={0} style={{ color: 'var(--muted-2)', textAlign: 'right', animation: 'wordFadeIn 0.25s ease-out both', animationDelay: `${Math.max(0, seg.text.split(' ').length * seg.waveIntervalMs - seg.waveElapsedAtCommitMs)}ms` }}>★</span>
                      </OnboardingTooltip>
                    </div>
                  );
                })}
                {/* Interim row: realtime partial text, finalized into a committed segment */}
                {interimText && recordingState === 'recording' && (
                  <div style={{
                    display: 'grid', gridTemplateColumns: isMobile ? '44px 1fr 14px' : '60px 1fr 20px',
                    gap: 12, padding: '5px 18px',
                    opacity: 0.75,
                    fontFamily: 'var(--mono)', fontSize: 12.5, lineHeight: 1.65,
                  }}>
                    <span style={{ color: 'var(--accent)' }}>{fmtSec(utteranceStartRef.current ?? elapsed)}</span>
                    <span style={{ color: 'var(--ink-2)', fontStyle: 'italic' }}>
                      {interimText === '…' ? interimText : interimText.split(/\s+/).filter(Boolean).map((word, wi) => {
                        const waveElapsed = waveStartMsRef.current !== null ? Date.now() - waveStartMsRef.current : 0;
                        const rawDelay = wi * LIVE_WAVE_INTERVAL_MS - waveElapsed;
                        if (rawDelay <= -250) {
                          return <span key={wi}>{word}{' '}</span>;
                        }
                        return (
                          <span key={wi} style={{
                            animation: 'wordFadeIn 0.25s ease-out both',
                            animationDelay: `${Math.max(-250, rawDelay)}ms`,
                          }}>{word}{' '}</span>
                        );
                      })}
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
            <OnboardingHint stepId="recording.clarify-panel">
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
            </OnboardingHint>
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
            <OnboardingHint stepId="recording.start-button">
              <button
                onClick={() => startRecording()}
                style={{
                  width: 56, height: 56, borderRadius: 999,
                  background: 'var(--ink)', border: 'none', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
                aria-label="Start optagelse"
              >
                <span style={{ width: 18, height: 18, borderRadius: 999, background: 'var(--bg)', display: 'block' }} />
              </button>
            </OnboardingHint>
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
            <OnboardingHint stepId="recording.pause-button">
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
            </OnboardingHint>
            <OnboardingHint stepId="recording.stop-save-continue">
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
            </OnboardingHint>
          </>
        )}

        {isUploading && (
          <WaitingForTranscriptionPanel
            total={nextSeqRef.current}
            waiting={queueState.waiting}
            online={online}
            authRequired={queueState.authRequired}
            persistFailed={queueState.persistFailed}
            onRetry={() => void queue.adoptPersisted()}
          />
        )}
      </div>

      {/* Dialogs */}
      {cancelDialog}

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
