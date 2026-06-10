'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  newVadBatchState, sealCurrentBatch, splitTextWithIntervals,
  runWithConcurrency, BATCH_DURATION_S, BATCH_CONCURRENCY,
} from '@/lib/audio/vad-batch';
import type { TranscriptSegment } from '@/types';

// Deterministic waveform — doubles as the progress bar fill indicator.
const WAVE = Array.from({ length: 92 }, (_, i) =>
  6 + Math.round(20 * Math.abs(Math.sin(i * 0.7) * Math.cos(i * 0.31) + Math.sin(i * 0.13))));

function fmtMS(s: number) {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Energy-based VAD — identical to the one in ProcessingTranscription.tsx.
function* energyVAD(
  audio: Float32Array,
  sampleRate: number,
): Generator<{ audio: Float32Array; start: number; end: number }> {
  const frameSamples = Math.round(sampleRate * 0.03);
  const threshold    = 0.01;
  const prePad       = Math.round(sampleRate * 0.25);
  const postPad      = Math.round(sampleRate * 0.40);
  const minSpeech    = Math.round(sampleRate * 0.10);
  const minSilFrames = Math.ceil(sampleRate * 0.80 / frameSamples);

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

// Decode, downmix to mono, resample to 16 kHz — identical to ProcessingTranscription.tsx.
async function decodeAndResampleTo16k(arrayBuffer: ArrayBuffer): Promise<Float32Array> {
  const audioCtx = new AudioContext();
  const decoded = await audioCtx.decodeAudioData(arrayBuffer);
  await audioCtx.close();

  if (decoded.sampleRate === 16_000 && decoded.numberOfChannels === 1) {
    return decoded.getChannelData(0).slice();
  }

  const fromRate = decoded.sampleRate;
  const CHUNK_S = 60;
  const chunkInputFrames = Math.round(fromRate * CHUNK_S);
  const totalInputFrames = decoded.length;
  const outputChunks: Float32Array[] = [];

  for (let offset = 0; offset < totalInputFrames; offset += chunkInputFrames) {
    const end = Math.min(offset + chunkInputFrames, totalInputFrames);
    const chunkLength = end - offset;
    const outLength = Math.ceil(chunkLength * 16_000 / fromRate);

    const offCtx = new OfflineAudioContext({ numberOfChannels: 1, length: outLength, sampleRate: 16_000 });
    const srcBuf = offCtx.createBuffer(1, chunkLength, fromRate);
    const srcData = srcBuf.getChannelData(0);

    if (decoded.numberOfChannels === 1) {
      srcData.set(decoded.getChannelData(0).subarray(offset, end));
    } else {
      const scale = 1 / decoded.numberOfChannels;
      for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
        const chData = decoded.getChannelData(ch).subarray(offset, end);
        for (let i = 0; i < chunkLength; i++) srcData[i] += chData[i] * scale;
      }
    }

    const src = offCtx.createBufferSource();
    src.buffer = srcBuf;
    src.connect(offCtx.destination);
    src.start();
    const out = await offCtx.startRendering();
    outputChunks.push(out.getChannelData(0).slice());
  }

  const totalLength = outputChunks.reduce((s, c) => s + c.length, 0);
  const result = new Float32Array(totalLength);
  let off = 0;
  for (const chunk of outputChunks) { result.set(chunk, off); off += chunk.length; }
  return result;
}

interface Props {
  file: File;
  onCancel: () => void;
}

type Phase = 'init' | 'analyzing' | 'transcribing' | 'saving' | 'done' | 'error';

export function UploadConfirmScreen({ file, onCancel }: Props) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('init');
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [audioDuration, setAudioDuration] = useState(0);
  // Real progress tracking: completedSeconds / totalSeconds (speech duration from VAD batches).
  const [completedSeconds, setCompletedSeconds] = useState(0);
  const [totalSeconds, setTotalSeconds] = useState(0);
  const [title, setTitle] = useState('');
  const [participants, setParticipants] = useState<string[]>([]);
  const [adding, setAdding] = useState('');
  // Segments accumulate live as each batch completes during transcription.
  const [liveSegments, setLiveSegments] = useState<TranscriptSegment[]>([]);
  const [error, setError] = useState<string | null>(null);

  const meetingIdRef = useRef<string | null>(null);
  const didStart = useRef(false);

  // Load audio duration from the local File object.
  // Guard against double-revocation: React StrictMode runs effects twice in dev,
  // which can revoke the blob URL before the Audio element loads it → ERR_FILE_NOT_FOUND.
  useEffect(() => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    let revoked = false;
    const revoke = () => { if (!revoked) { revoked = true; URL.revokeObjectURL(url); } };
    audio.src = url;
    audio.onloadedmetadata = () => { setAudioDuration(audio.duration); revoke(); };
    audio.onerror = () => revoke();
    return revoke;
  }, [file]);

  // Main pipeline: create meeting → archive to server → decode → VAD → batch transcribe → save.
  useEffect(() => {
    if (didStart.current) return;
    didStart.current = true;
    void run();

    async function run() {
      try {
        // 1. Create meeting with a placeholder title.
        const dateStr = new Intl.DateTimeFormat('da', { day: 'numeric', month: 'long' }).format(new Date());
        const meetingRes = await fetch('/api/meetings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: `Møde · ${dateStr}`, participants: [] }),
        });
        if (!meetingRes.ok) throw new Error('Kunne ikke oprette møde');
        const { id } = await meetingRes.json();
        setMeetingId(id);
        meetingIdRef.current = id;

        // 2. Archive the file on the server in parallel (storageOnly — client handles transcription).
        //    Fire-and-forget; transcription proceeds even if archiving fails.
        const archiveFormData = new FormData();
        archiveFormData.append('audio', file, file.name);
        archiveFormData.append('meetingId', id);
        archiveFormData.append('storageOnly', 'true');
        fetch('/api/transcribe', { method: 'POST', body: archiveFormData })
          .catch((err) => console.warn('[upload-confirm] server archive failed:', err));

        // 3. Decode + VAD (client-side, from local File — no server download needed).
        setPhase('analyzing');
        let arrayBuffer: ArrayBuffer;
        try {
          arrayBuffer = await file.arrayBuffer();
        } catch {
          throw new Error('Lydfilen kunne ikke læses. Prøv at uploade filen igen.');
        }
        let mono16k: Float32Array;
        try {
          mono16k = await decodeAndResampleTo16k(arrayBuffer);
        } catch {
          throw new Error(
            'Lydformatet understøttes ikke. Prøv MP3, WAV eller M4A.',
          );
        }

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

        // 4. Transcribe all batches in parallel; update progress + live-kig as each completes.
        setPhase('transcribing');
        const batches = batchState.readyBatches;
        if (batches.length === 0) {
          throw new Error('Ingen tale fundet i lydfilen. Er filen lydløs?');
        }
        const total = batches.reduce((s, b) => s + b.totalWavDuration, 0);
        setTotalSeconds(total);
        setCompletedSeconds(0);

        let completedSecs = 0;
        const tasks = batches.map((batch) => async (): Promise<TranscriptSegment[]> => {
          try {
            const fd = new FormData();
            fd.append('audio', batch.wav, 'batch.wav');
            const res = await fetch(`/api/meetings/${id}/utterance`, {
              method: 'POST',
              body: fd,
              signal: AbortSignal.timeout(60_000),
            });
            if (!res.ok) return [];
            const { text } = await res.json() as { text: string };
            const segs = text?.trim()
              ? splitTextWithIntervals(text, batch.intervals, batch.totalWavDuration)
              : [];
            if (segs.length > 0) {
              setLiveSegments(prev => [...prev, ...segs].sort((a, b) => a.start - b.start));
            }
            return segs;
          } catch (err) {
            console.error('[upload-confirm] batch failed:', err);
            return [];
          } finally {
            completedSecs += batch.totalWavDuration;
            setCompletedSeconds(completedSecs);
          }
        });

        const segmentArrays = await runWithConcurrency(tasks, BATCH_CONCURRENCY);
        const segments = segmentArrays.flat().sort((a, b) => a.start - b.start);

        // 5. Save transcript → sets meeting status to 'review'.
        setPhase('saving');
        const saveRes = await fetch(`/api/meetings/${id}/save-transcript`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ segments }),
        });
        if (!saveRes.ok) throw new Error('Gem fejlede');

        setCompletedSeconds(total);
        setPhase('done');
      } catch (err) {
        console.error('[upload-confirm]', err);
        setError(err instanceof Error ? err.message : 'Transskription fejlede');
        setPhase('error');
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const done = phase === 'done';

  // Progress: fraction of speech-audio transcribed. 0 during decode/analyze; 100 when saving/done.
  const progress = (phase === 'saving' || phase === 'done')
    ? 100
    : totalSeconds > 0 && phase === 'transcribing'
      ? Math.min(99, Math.round((completedSeconds / totalSeconds) * 100))
      : 0;

  // Map speech-progress onto real audio duration for the MM:SS display.
  const transcribedSecs = (totalSeconds > 0 && audioDuration > 0)
    ? Math.round((completedSeconds / totalSeconds) * audioDuration)
    : 0;

  // Rough remaining-time estimate: hviske processes ~16× real-time.
  const remainSecs = (totalSeconds > 0 && completedSeconds < totalSeconds)
    ? Math.max(0, Math.round((totalSeconds - completedSeconds) / 16))
    : 0;

  const fileExt = file.name.split('.').pop()?.toLowerCase() ?? '';

  const progressLabel = phase === 'init' || phase === 'analyzing'
    ? (phase === 'analyzing' ? 'analyserer tale…' : 'forbereder…')
    : phase === 'saving' ? 'gemmer transskription…'
    : done ? 'transskription færdig'
    : 'transskriberer med hviske';

  function addParticipant() {
    const v = adding.trim();
    if (v) { setParticipants([...participants, v]); setAdding(''); }
  }

  async function handleCancel() {
    if (meetingIdRef.current) {
      fetch(`/api/meetings/${meetingIdRef.current}`, { method: 'DELETE' }).catch(() => {});
    }
    onCancel();
  }

  async function handleContinue() {
    if (!done || !meetingId) return;
    const finalTitle = title.trim() || file.name.replace(/\.[^.]+$/, '');
    try {
      await fetch(`/api/meetings/${meetingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: finalTitle, participants }),
      });
    } catch {
      // non-fatal — we still navigate
    }
    router.push(`/meeting/${meetingId}/review`);
  }

  if (phase === 'error') {
    return (
      <div style={{ minHeight: 'calc(100vh - 56px)', padding: '48px 48px 96px' }}>
        <div style={{ maxWidth: 1080, margin: '0 auto' }}>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)',
            letterSpacing: 0.4, textTransform: 'uppercase',
          }}>
            transskription fejlede
          </div>
          <div style={{
            marginTop: 16, display: 'flex', alignItems: 'flex-start', gap: 14,
          }}>
            <span style={{
              flexShrink: 0, marginTop: 4, width: 10, height: 10, borderRadius: 999,
              background: 'var(--danger, #e05252)',
            }} />
            <p style={{
              margin: 0, fontSize: 22, fontWeight: 300, color: 'var(--ink)',
              lineHeight: 1.45, maxWidth: 560,
            }}>
              {error ?? 'Der opstod en fejl under transskription.'}
            </p>
          </div>
          <div style={{
            marginTop: 10, marginLeft: 24,
            fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)', lineHeight: 1.7,
          }}>
            Lydfilen er gemt — prøv en anden fil, eller gå tilbage til oversigten.
          </div>

          <div style={{ marginTop: 32, marginLeft: 24, display: 'flex', gap: 12 }}>
            <button
              type="button"
              onClick={handleCancel}
              style={{
                fontFamily: 'var(--mono)', fontSize: 13,
                padding: '10px 18px', borderRadius: 'var(--radius)',
                border: '1px solid var(--line-2)', background: 'var(--surface)',
                color: 'var(--ink-2)', cursor: 'pointer',
              }}
            >
              ← upload en anden fil
            </button>
          </div>

          {/* Show filename so user knows which file failed */}
          <div style={{
            marginTop: 40, paddingTop: 22, borderTop: '1px solid var(--line)',
            fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted)',
          }}>
            fil: {file.name} ({formatBytes(file.size)})
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: 'calc(100vh - 56px)', padding: '48px 48px 96px' }}>
      <style>{`
        @keyframes uploadPulse { 0%,100%{opacity:1} 50%{opacity:.35} }
        @keyframes uploadBlink { 0%,49%{opacity:1} 50%,100%{opacity:0} }
        @media (prefers-reduced-motion: reduce) {
          .upload-pulse { animation: none !important; }
          .upload-blink { display: none !important; }
        }
      `}</style>

      <div style={{ maxWidth: 1080, margin: '0 auto' }}>

        {/* A. Header */}
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 24 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', letterSpacing: 0.4 }}>
              lydfil uploadet · klar til transskription
            </div>
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{
                width: 34, height: 34, borderRadius: 'var(--radius)', flexShrink: 0,
                border: '1px solid var(--line-2)', background: 'var(--bg-2)',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <span style={{ display: 'flex', alignItems: 'flex-end', gap: 1.5, height: 13 }}>
                  {[5, 9, 13, 7, 11].map((h, i) => (
                    <span key={i} style={{ width: 2, height: h, background: 'var(--accent)', borderRadius: 1 }} />
                  ))}
                </span>
              </span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 17, color: 'var(--ink)' }}>{file.name}</span>
            </div>
            <div style={{
              marginTop: 8, fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted)',
              letterSpacing: 0.2, display: 'flex', gap: 14,
            }}>
              <span>{formatBytes(file.size)}</span>
              <span style={{ color: 'var(--muted-2)' }}>·</span>
              <span>{audioDuration > 0 ? fmtMS(audioDuration) : '…'}</span>
              <span style={{ color: 'var(--muted-2)' }}>·</span>
              <span>{fileExt}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={handleCancel}
            style={{
              marginBottom: 2, fontFamily: 'var(--mono)', fontSize: 12,
              padding: '7px 14px', borderRadius: 'var(--radius)',
              border: '1px solid var(--line-2)', background: 'var(--surface)',
              color: 'var(--ink-2)', cursor: 'pointer',
            }}
          >
            annullér · upload anden fil
          </button>
        </div>

        {/* B. Progress card */}
        <div style={{
          marginTop: 30, border: '1px solid var(--line-2)', borderRadius: 'var(--radius)',
          background: 'var(--surface)', padding: '22px 26px',
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
            <div>
              <div style={{
                fontFamily: 'var(--mono)', fontSize: 52, fontWeight: 500, lineHeight: 1,
                letterSpacing: '-0.04em', color: 'var(--ink)', fontVariantNumeric: 'tabular-nums',
              }}>
                {progress}<span style={{ fontSize: 26, color: 'var(--muted)' }}>%</span>
              </div>
              <div style={{ marginTop: 8, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', letterSpacing: 0.4 }}>
                {progressLabel}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-2)' }}>
                <span
                  className="upload-pulse"
                  style={{
                    width: 7, height: 7, borderRadius: 999,
                    background: done ? 'var(--keep)' : 'var(--accent)',
                    animation: done ? 'none' : 'uploadPulse 1.4s ease-in-out infinite',
                  }}
                />
                {audioDuration > 0 ? `${fmtMS(transcribedSecs)} / ${fmtMS(audioDuration)}` : '…'}
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
                {done
                  ? 'klar · gem og gennemgå'
                  : phase === 'transcribing' && remainSecs > 0
                    ? `~${remainSecs} sek. tilbage`
                    : '…'}
              </div>
            </div>
          </div>

          {/* Waveform progress bar — no CSS transition on bar background (oklch/Chromium pitfall) */}
          <div style={{ marginTop: 20, display: 'flex', alignItems: 'center', gap: 2, height: 44 }}>
            {WAVE.map((h, i) => {
              const filled = (i / WAVE.length) * 100 <= progress;
              return (
                <span
                  key={i}
                  style={{
                    flex: 1,
                    height: h * 1.6,
                    background: filled ? 'var(--accent)' : 'var(--sunk)',
                    borderRadius: 1,
                  }}
                />
              );
            })}
          </div>
        </div>

        {/* C. Two-column body */}
        <div style={{
          marginTop: 32,
          display: 'grid',
          gridTemplateColumns: '1fr 380px',
          gap: 48,
          alignItems: 'start',
        }}>

          {/* Left — editable meeting details */}
          <div>
            <div style={{
              display: 'flex', justifyContent: 'space-between',
              fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', letterSpacing: 0.4,
            }}>
              <span>mødedetaljer</span>
              <span style={{ color: 'var(--muted-2)' }}>redigér mens den arbejder</span>
            </div>

            <div style={{ marginTop: 18, paddingBottom: 10, borderBottom: '1px solid var(--line-2)' }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted-2)', marginBottom: 8, letterSpacing: 0.4 }}>
                mødets navn
              </div>
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Navngiv mødet…"
                style={{
                  width: '100%', fontSize: 24, color: 'var(--ink)',
                  fontWeight: 300, padding: '2px 0', letterSpacing: '-0.01em',
                  background: 'transparent', border: 'none', outline: 'none',
                }}
              />
            </div>

            <div style={{ marginTop: 26 }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted-2)', marginBottom: 10, letterSpacing: 0.4 }}>
                deltagere
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                {participants.map((p, i) => (
                  <span key={i} style={{
                    fontFamily: 'var(--mono)', fontSize: 12.5,
                    padding: '5px 12px', borderRadius: 999,
                    border: '1px solid var(--line-2)', background: 'var(--bg-2)',
                    color: 'var(--ink-2)', display: 'inline-flex', alignItems: 'center', gap: 7,
                  }}>
                    {p}
                    <button
                      type="button"
                      aria-label={`Fjern ${p}`}
                      onClick={() => setParticipants(participants.filter((_, j) => j !== i))}
                      style={{ color: 'var(--muted-2)', cursor: 'pointer', background: 'none', border: 'none', padding: 0, font: 'inherit', lineHeight: 1 }}
                    >×</button>
                  </span>
                ))}
                <input
                  value={adding}
                  onChange={(e) => setAdding(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addParticipant(); } }}
                  placeholder="+ tilføj"
                  style={{
                    fontFamily: 'var(--mono)', fontSize: 12.5,
                    padding: '5px 12px', borderRadius: 999,
                    border: '1px dashed var(--line-2)', color: 'var(--ink-2)', width: 96,
                    background: 'transparent', outline: 'none',
                  }}
                />
              </div>
            </div>

            <div style={{ marginTop: 30 }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted-2)', marginBottom: 10, letterSpacing: 0.4 }}>
                § databehandling
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.8, letterSpacing: 0.2 }}>
                filen behandles lokalt på din enhed<br />
                slettes automatisk når du genererer dit referat<br />
                personoplysninger fjernes inden referat
              </div>
            </div>
          </div>

          {/* Right — live-kig: segments appear as each batch completes */}
          <div style={{
            border: '1px solid var(--line-2)', borderRadius: 'var(--radius)',
            background: 'var(--surface)', overflow: 'hidden',
            display: 'flex', flexDirection: 'column', maxHeight: 420,
          }}>
            <div style={{
              padding: '11px 16px', borderBottom: '1px solid var(--line)',
              fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)',
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <span
                className="upload-pulse"
                style={{
                  width: 6, height: 6, borderRadius: 999,
                  background: done ? 'var(--keep)' : 'var(--accent)',
                  animation: done ? 'none' : 'uploadPulse 1.4s ease-in-out infinite',
                }}
              />
              live-kig · ord lander mens den arbejder
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: '12px 0' }}>
              {(phase === 'init' || phase === 'analyzing') && (
                <div style={{ padding: '24px 16px', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
                  {phase === 'analyzing' ? 'analyserer tale…' : 'indlæser lyd…'}
                </div>
              )}
              {phase === 'transcribing' && liveSegments.length === 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: '46px 1fr', gap: 10, padding: '4px 16px', fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.6 }}>
                  <span style={{ color: 'var(--accent)' }}>00:00</span>
                  <span style={{ color: 'var(--ink-2)' }}>
                    transskriberer…
                    <span
                      className="upload-blink"
                      style={{
                        display: 'inline-block', width: 6, height: 13,
                        background: 'var(--accent)', verticalAlign: 'middle', marginLeft: 3,
                        animation: 'uploadBlink 0.9s steps(2) infinite',
                      }}
                    />
                  </span>
                </div>
              )}
              {liveSegments.map((seg, i) => {
                const isLast = i === liveSegments.length - 1 && !done;
                return (
                  <div key={i} style={{
                    display: 'grid', gridTemplateColumns: '46px 1fr', gap: 10,
                    padding: '4px 16px', fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.6,
                  }}>
                    <span style={{ color: 'var(--accent)' }}>{fmtMS(seg.start)}</span>
                    <span style={{ color: 'var(--ink-2)' }}>
                      <span style={{ color: 'var(--ink)', fontWeight: 500 }}>{seg.speaker.toLowerCase()}: </span>
                      {seg.text}
                      {isLast && (
                        <span
                          className="upload-blink"
                          style={{
                            display: 'inline-block', width: 6, height: 13,
                            background: 'var(--accent)', verticalAlign: 'middle', marginLeft: 3,
                            animation: 'uploadBlink 0.9s steps(2) infinite',
                          }}
                        />
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* D. Footer */}
        <div style={{
          marginTop: 36, paddingTop: 22, borderTop: '1px solid var(--line)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted)' }}>
            {done
              ? 'transskriptionen er klar — gennemgå og ryd op i referatet.'
              : 'du kan navngive møde og deltagere nu — vi fortsætter automatisk når den er færdig.'}
          </span>
          <button
            type="button"
            onClick={handleContinue}
            disabled={!done}
            style={{
              fontFamily: 'var(--mono)', fontSize: 13,
              padding: '10px 18px', borderRadius: 'var(--radius)',
              border: done ? 'none' : '1px solid var(--line-2)',
              background: done ? 'var(--accent)' : 'var(--surface)',
              color: done ? '#fff' : 'var(--muted)',
              cursor: done ? 'pointer' : 'not-allowed',
              opacity: done ? 1 : 0.6,
            }}
          >
            {done ? 'fortsæt til gennemgang →' : `afventer transskription · ${progress}%`}
          </button>
        </div>

      </div>
    </div>
  );
}
