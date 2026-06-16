'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { transcribeBatchesOnServer } from '@/lib/audio/transcribe-batches-client';
import { startDiarization, finishDiarization } from '@/lib/audio/diarize-client';
import { createMeeting, saveAudio, saveTranscript, updateMeeting, deleteMeeting } from '@/lib/storage';
import type { TranscriptSegment } from '@/types';
import { isDefaultSpeakerLabel } from '@/lib/audio/speaker-labels';

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

interface Props {
  file: File;
  onCancel: () => void;
}

type Phase = 'init' | 'analyzing' | 'transcribing' | 'saving' | 'done' | 'error';

export function UploadConfirmScreen({ file, onCancel }: Props) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('init');
  const [audioDuration, setAudioDuration] = useState(0);
  const [completedSeconds, setCompletedSeconds] = useState(0);
  const [totalSeconds, setTotalSeconds] = useState(0);
  const [title, setTitle] = useState('');
  const [participants, setParticipants] = useState<string[]>([]);
  const [adding, setAdding] = useState('');
  const [liveSegments, setLiveSegments] = useState<TranscriptSegment[]>([]);
  const [error, setError] = useState<string | null>(null);

  const meetingIdRef = useRef<string | null>(null);
  const archiveFailedRef = useRef(false);

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

  useEffect(() => {
    let cancelled = false;

    void run();

    async function run() {
      try {
        const dateStr = new Intl.DateTimeFormat('da', { day: 'numeric', month: 'long' }).format(new Date());
        // Use the uploaded file's own date as the recording date — uploading an
        // old clip should keep the clip's date, not today's. Falls back to now
        // when the browser reports no usable lastModified (0).
        const recordedAt = file.lastModified
          ? new Date(file.lastModified).toISOString()
          : undefined;
        const meeting = await createMeeting({
          title: `Møde · ${dateStr}`,
          participants: [],
          source: 'local',
          status: 'processing',
          recordedAt,
        });
        if (cancelled) return;
        const id = meeting.id;
        meetingIdRef.current = id;

        // Archive the original audio in IndexedDB so it can be played back during
        // review. Failure is non-fatal but surfaced after completion.
        try {
          await saveAudio(id, file, file.type || 'audio/webm');
          await updateMeeting(id, { audioSizeBytes: file.size });
        } catch {
          archiveFailedRef.current = true;
        }
        if (cancelled) return;

        setPhase('analyzing');

        // Diarize the full recording in parallel with transcription. The original
        // compressed file is posted as-is (the diarization service decodes it), and
        // speaker labels are patched onto the saved transcript when the turns land —
        // the user is NOT kept waiting on diarization.
        const diarizationPromise = startDiarization(id, file);

        // One upload of the original file; the server decodes with ffmpeg, runs VAD,
        // and fans out ALL 27 s batches to hviske simultaneously. Progress and
        // segments stream back per batch for the live preview.
        let completedSecs = 0;
        let result;
        try {
          result = await transcribeBatchesOnServer(id, file, {
            onMeta: (meta) => {
              if (cancelled) return;
              setPhase('transcribing');
              setTotalSeconds(meta.totalSpeechSeconds);
              setCompletedSeconds(0);
            },
            onBatch: (update) => {
              if (cancelled) return;
              completedSecs += update.batchSeconds;
              setCompletedSeconds(completedSecs);
              // Append without sorting; batches arrive out of order, live preview is
              // best-effort. The final 'done' payload is authoritative and sorted.
              if (update.segments.length > 0) {
                setLiveSegments(prev => [...prev, ...update.segments]);
              }
            },
          });
        } catch {
          throw new Error('Lydformatet understøttes ikke, eller serveren svarede ikke. Prøv MP3, WAV eller M4A.');
        }
        if (cancelled) return;
        if (result.totalBatches === 0) {
          throw new Error('Ingen tale fundet i lydfilen. Er filen lydløs?');
        }
        const segments: TranscriptSegment[] = result.segments;

        setPhase('saving');
        const rawText = segments.map((s) => s.text).join(' ');
        // Saved with default labels and diarizationStatus 'pending' — the review
        // screen shows an uncertainty state for speakers until diarization lands.
        await saveTranscript(id, { rawText, segments, chapters: [], piiReplacements: [], diarizationStatus: 'pending' });
        await updateMeeting(id, { status: 'review' });
        if (cancelled) return;

        // Patch in speaker labels (and clear the pending state) once diarization finishes.
        void diarizationPromise.then((turns) => finishDiarization(id, turns));

        setCompletedSeconds(result.totalSpeechSeconds);
        setPhase('done');
      } catch (err) {
        if (cancelled) return;
        console.error('[upload-confirm]', err);
        setError(err instanceof Error ? err.message : 'Transskription fejlede');
        setPhase('error');
      }
    }

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const done = phase === 'done';

  let progress: number;
  switch (phase) {
    case 'saving':
    case 'done':
      progress = 100;
      break;
    case 'transcribing':
      progress = totalSeconds > 0 ? Math.min(99, Math.round((completedSeconds / totalSeconds) * 100)) : 0;
      break;
    default:
      progress = 0;
  }

  const transcribedSecs = (totalSeconds > 0 && audioDuration > 0)
    ? Math.round((completedSeconds / totalSeconds) * audioDuration)
    : 0;

  // Rough remaining-time estimate: hviske processes ~16× real-time.
  const remainSecs = (totalSeconds > 0 && completedSeconds < totalSeconds)
    ? Math.max(0, Math.round((totalSeconds - completedSeconds) / 16))
    : 0;

  const fileExt = file.name.split('.').pop()?.toLowerCase() ?? '';

  const progressLabels: Record<Phase, string> = {
    init: 'forbereder…',
    analyzing: 'analyserer tale…',
    transcribing: 'transskriberer med hviske',
    saving: 'gemmer transskription…',
    done: 'transskription færdig',
    error: '',
  };

  function addParticipant() {
    const v = adding.trim();
    if (v) { setParticipants([...participants, v]); setAdding(''); }
  }

  async function handleCancel() {
    if (meetingIdRef.current) {
      deleteMeeting(meetingIdRef.current).catch(() => {});
    }
    onCancel();
  }

  async function handleContinue() {
    const id = meetingIdRef.current;
    if (!done || !id) return;
    const finalTitle = title.trim() || file.name.replace(/\.[^.]+$/, '');
    try {
      await updateMeeting(id, { title: finalTitle, participants });
    } catch {
      // non-fatal — we still navigate
    }
    router.push(`/meeting/${id}/review`);
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
                {progressLabels[phase]}
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
                      {/* Diarization hasn't run yet here — every segment is the
                          placeholder 'Taler N', so don't show a speaker label
                          before the gennemgang page assigns real speakers. */}
                      {!isDefaultSpeakerLabel(seg.speaker) && (
                        <span style={{ color: 'var(--ink)', fontWeight: 500 }}>{seg.speaker.toLowerCase()}: </span>
                      )}
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
              ? archiveFailedRef.current
                ? 'advarsel: lydfilen kunne ikke arkiveres på serveren — transskriptionen er klar.'
                : 'transskriptionen er klar — gennemgå og ryd op i referatet.'
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
