'use client';

import { useEffect, useState } from 'react';
import { transcribeBatchesOnServer } from '@/lib/audio/transcribe-batches-client';
import { startDiarization, finishDiarization } from '@/lib/audio/diarize-client';
import { getAudio, saveTranscript, updateMeeting } from '@/lib/storage';
import type { TranscriptSegment } from '@/types';

interface Props {
  meetingId: string;
  onComplete?: () => void;
}

type Phase = 'downloading' | 'analyzing' | 'transcribing' | 'saving' | 'error';

// How long to wait for the server-side bot transcription (started the moment the
// bot uploaded) before falling back to driving transcription from the client.
const SERVER_TRANSCRIPT_DEADLINE_MS = 5 * 60_000;
const SERVER_TRANSCRIPT_POLL_MS = 1_000;

interface ServerTranscript {
  status: 'none' | 'processing' | 'failed' | 'ready';
  segments?: TranscriptSegment[];
  diarized?: boolean;
}

/**
 * What the server-side run amounted to. A bare `null` used to cover four very
 * different situations, and the caller could only turn all of them into "no local
 * audio" — so a Teams meeting the server had already given up on was reported as
 * a missing audio file, which is true but tells the user nothing.
 */
type ServerOutcome =
  /** Segments to save. */
  | { kind: 'ready'; transcript: ServerTranscript }
  /** The run finished and found no speech at all. */
  | { kind: 'empty' }
  /** The run failed server-side; the reason is on the meeting row, not here. */
  | { kind: 'failed' }
  /** No server-side run for this meeting — the client transcribes it itself. */
  | { kind: 'none' };

// Collect the transcript the server began producing when it stashed the recording.
// `none` covers a local recording, an unreachable server, and the deadline passing:
// in all three the client's own transcription is the right next step.
async function collectServerTranscript(
  meetingId: string,
  isCancelled: () => boolean,
): Promise<ServerOutcome> {
  const deadline = Date.now() + SERVER_TRANSCRIPT_DEADLINE_MS;
  while (!isCancelled() && Date.now() < deadline) {
    let data: ServerTranscript;
    try {
      const res = await fetch(`/api/meetings/${meetingId}/pending-transcript`);
      if (!res.ok) return { kind: 'none' };
      data = await res.json() as ServerTranscript;
    } catch {
      return { kind: 'none' };
    }
    if (data.status === 'ready') {
      return data.segments?.length ? { kind: 'ready', transcript: data } : { kind: 'empty' };
    }
    if (data.status === 'failed') return { kind: 'failed' };
    if (data.status !== 'processing') return { kind: 'none' };
    await new Promise((r) => setTimeout(r, SERVER_TRANSCRIPT_POLL_MS));
  }
  return { kind: 'none' };
}

// Tell the server the transcript is safely in IndexedDB, so it can drop its copy.
// The server deletes nothing on read, so this is the only thing that does. Called
// strictly AFTER the save. It is best effort: if it fails the server copy is swept
// after its TTL, which is harmless, whereas failing the hand-off here would not be.
async function acknowledgeServerTranscript(meetingId: string): Promise<void> {
  try {
    await fetch(`/api/meetings/${meetingId}/pending-transcript`, { method: 'DELETE' });
  } catch (err) {
    console.warn('[ProcessingTranscription] kunne ikke kvittere for transskriptionen:', err);
  }
}

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
    let cancelled = false;
    void run();

    async function save(segments: TranscriptSegment[], diarizationStatus: 'pending' | 'done') {
      setPhase('saving');
      const rawText = segments.map((s) => s.text).join(' ');
      await saveTranscript(meetingId, { rawText, segments, chapters: [], piiReplacements: [], diarizationStatus });
      await updateMeeting(meetingId, { status: 'review' });
    }

    async function run() {
      try {
        // 1. Load the archived audio from IndexedDB. It is REQUIRED only for the
        // fallback and for client-side diarization — a Teams meeting recorded in
        // transcript-only mode has no audio at all, and one whose recording the
        // server already transcribed does not need it either. So a missing blob
        // is not an error until we actually need it (step 3).
        setPhase('downloading');
        const audioEntry = await getAudio(meetingId);
        const blob = audioEntry?.blob ?? null;
        if (cancelled) return;

        // 2. Server-side runs (Teams bot, or the Microsoft Graph pipeline) started
        // transcription + diarization before the user got here. Collect it instead
        // of re-doing the work.
        setPhase('analyzing');
        const outcome = await collectServerTranscript(meetingId, () => cancelled);
        if (cancelled) return;

        // A server-side run that produced nothing is not a missing audio file. Say
        // what actually happened, because the remedies differ: an empty meeting is
        // finished, a failed one is worth retrying.
        // With local audio in hand an empty server run is just a failed first
        // attempt — the client transcribes it itself below. Without audio (a Teams
        // meeting) there is nothing to fall back to and this is the final answer.
        if (outcome.kind === 'empty' && !blob) {
          throw new Error(
            'Der blev ikke fundet tale i mødet. Optagelsen fra Teams var tom eller for kort.',
          );
        }
        if (outcome.kind === 'failed' && !blob) {
          throw new Error(
            'Transskriptionen på serveren fejlede. Prøv igen — mødet ligger stadig hos Teams.',
          );
        }

        const serverTranscript = outcome.kind === 'ready' ? outcome.transcript : null;
        if (serverTranscript?.segments?.length) {
          if (serverTranscript.diarized || !blob) {
            // Already diarized server-side — labels are final. With no audio there
            // is nothing to diarize from either, so the labels stand as they are.
            await save(serverTranscript.segments, 'done');
          } else {
            // Server-side diarization failed — save as 'pending' (uncertainty state)
            // and retry diarization from here, patching labels in when it lands.
            await save(serverTranscript.segments, 'pending');
            const turns = startDiarization(meetingId, blob);
            void turns.then((t) => finishDiarization(meetingId, t));
          }
          // Saved: only now may the server drop its copy.
          await acknowledgeServerTranscript(meetingId);
          onComplete?.();
          return;
        }

        // Nothing server-side and nothing local: there is no work left to do here
        // and no way to do it — say so rather than crashing on a null blob. This is
        // now only reachable for a meeting that never had a server-side run, so the
        // message is about the audio the client expected to find.
        if (!blob) throw new Error('Lydfil ikke fundet');

        // 3. Fallback: drive transcription from here. One upload of the original
        // compressed audio; the server decodes, runs VAD, and fans out all batches
        // to hviske simultaneously, streaming progress back. Diarization runs in
        // parallel and does NOT block the transcript — labels are patched in later.
        const diarizationPromise = startDiarization(meetingId, blob);

        const result = await transcribeBatchesOnServer(meetingId, blob, {
          onMeta: (meta) => {
            if (cancelled) return;
            setPhase('transcribing');
            setBatchProgress({
              completed: 0, total: meta.totalBatches,
              completedSeconds: 0, totalSeconds: meta.totalSpeechSeconds,
            });
          },
          onBatch: (update) => {
            if (cancelled) return;
            setBatchProgress((prev) => ({
              completed: update.completedBatches,
              total: update.totalBatches,
              completedSeconds: (prev?.completedSeconds ?? 0) + update.batchSeconds,
              totalSeconds: prev?.totalSeconds ?? 0,
            }));
          },
        });
        if (cancelled) return;

        // Distinguish a transcription FAILURE from a genuinely silent file: the
        // server tallies unreachable/rejected batches into failedSeconds rather
        // than throwing, so an all-failed run returns empty segments. Saving that
        // silently would strand the user on "Ingen transskription fundet" with no
        // hint that the speech service was the problem.
        if (result.segments.length === 0) {
          throw new Error(
            result.failedSeconds > 0
              ? 'Transskriptionen fejlede — taletjenesten kunne ikke nås. Tjek forbindelsen til hviske og prøv igen.'
              : 'Ingen tale fundet i lydfilen. Er filen lydløs?',
          );
        }
        if (result.failedSeconds > 0) {
          // Partial failure: keep the transcript we got, but make the gap traceable.
          console.warn(
            `[ProcessingTranscription] partial transcription for ${meetingId}: ` +
            `${Math.round(result.failedSeconds)}s of audio could not be transcribed`,
          );
        }

        await save(result.segments, 'pending');
        void diarizationPromise.then((turns) => finishDiarization(meetingId, turns));

        onComplete?.();
      } catch (err) {
        if (cancelled) return;
        console.error('[ProcessingTranscription]', err);
        setError(err instanceof Error ? err.message : 'Transskription fejlede');
        setPhase('error');
      }
    }

    return () => { cancelled = true; };
  }, [meetingId, retryCount]);

  const pct = batchProgress && batchProgress.totalSeconds > 0
    ? Math.min(100, Math.round((batchProgress.completedSeconds / batchProgress.totalSeconds) * 100))
    : 0;

  const phaseLabels: Record<Phase, string> = {
    downloading: 'henter lydfil…',
    analyzing: 'henter transskription…',
    transcribing: batchProgress && batchProgress.total > 0
      ? `transskriberer ${batchProgress.completed} / ${batchProgress.total} segmenter…`
      : 'transskriberer…',
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
