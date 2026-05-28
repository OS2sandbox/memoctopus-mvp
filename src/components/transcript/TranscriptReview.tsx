'use client';

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { TranscriptSegment, PiiReplacement } from '@/types';
import { SpeakerRow } from './SpeakerRow';
import { WaveformPlayer } from './WaveformPlayer';
import { pendingUpload } from '@/lib/pending-upload';

interface TranscriptReviewProps {
  meetingId: string;
  transcriptId: string;
  initialSegments: TranscriptSegment[];
  piiReplacements: PiiReplacement[];
  audioUrl?: string;
}

type UploadStatus = 'idle' | 'uploading' | 'processing' | 'done' | 'error';

function applySelectedPiiReplacements(
  segs: TranscriptSegment[],
  replacements: PiiReplacement[],
  selected: Set<number>,
): TranscriptSegment[] {
  return segs.map((seg, segIdx) => {
    const toApply = replacements.filter((r, i) => selected.has(i) && r.segmentIndex === segIdx);
    if (toApply.length === 0) return seg;
    let text = seg.text;
    for (const r of toApply) text = text.replaceAll(r.original, r.replacement);
    return { ...seg, text };
  });
}

export function TranscriptReview({
  meetingId,
  transcriptId,
  initialSegments,
  piiReplacements: initialPiiReplacements,
  audioUrl: initialAudioUrl,
}: TranscriptReviewProps) {
  const router = useRouter();
  const [segments, setSegments] = useState(initialSegments);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customPrompt, setCustomPrompt] = useState('');

  // PII checklist: all items checked by default
  const [piiReplacements, setPiiReplacements] = useState<PiiReplacement[]>(initialPiiReplacements);
  const [checkedPii, setCheckedPii] = useState<Set<number>>(
    () => new Set(initialPiiReplacements.map((_, i) => i)),
  );
  const [highlightedSegment, setHighlightedSegment] = useState<number | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const segmentRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Audio player
  const [audioUrl, setAudioUrl] = useState(initialAudioUrl);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [audioError, setAudioError] = useState<string | null>(null);

  // Background audio upload (from pending upload store)
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>('idle');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Kick off pending audio upload on first render
  useEffect(() => {
    const pending = pendingUpload.get();
    if (!pending || pending.meetingId !== meetingId) return;
    pendingUpload.clear();
    startAudioUpload(pending.blob, pending.elapsed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startAudioUpload(blob: Blob, elapsed: number) {
    setUploadStatus('uploading');
    setUploadProgress(0);
    setUploadError(null);

    const mimeType = blob.type || 'audio/webm';
    const formData = new FormData();
    formData.append('audio', blob, `recording.${mimeType.includes('mp4') ? 'm4a' : 'webm'}`);
    formData.append('meetingId', meetingId);
    formData.append('transcriptId', transcriptId);
    formData.append('duration', String(elapsed));

    const xhr = new XMLHttpRequest();

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        setUploadProgress(Math.round((e.loaded / e.total) * 100));
      }
    };

    xhr.upload.onload = () => {
      // Bytes sent; server is now running PII detection
      setUploadStatus('processing');
      setUploadProgress(100);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText) as { piiReplacements?: PiiReplacement[] };
          const newReplacements = data.piiReplacements ?? [];
          setPiiReplacements(newReplacements);
          setCheckedPii(new Set(newReplacements.map((_, i) => i)));
        } catch {
          // PII data couldn't be parsed — not critical, continue without it
        }
        setAudioUrl(`/api/meetings/${meetingId}/audio`);
        setUploadStatus('done');
      } else {
        let msg = 'Upload fejlede';
        try {
          msg = (JSON.parse(xhr.responseText) as { error?: string }).error ?? msg;
        } catch { /* ignore */ }
        setUploadStatus('error');
        setUploadError(msg);
      }
    };

    xhr.onerror = () => {
      setUploadStatus('error');
      setUploadError('Netværksfejl under upload af lydfil');
    };

    xhr.open('POST', '/api/transcribe');
    xhr.send(formData);
  }

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => setCurrentTime(audio.currentTime);
    const onMeta = () => {
      if (isFinite(audio.duration)) setDuration(audio.duration);
    };
    const onDurationChange = () => {
      if (isFinite(audio.duration)) setDuration(audio.duration);
    };
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => setIsPlaying(false);
    const onError = () => setAudioError('Lydfilen kunne ikke indlæses');
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('durationchange', onDurationChange);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('durationchange', onDurationChange);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
    };
  }, []);

  const seekTo = useCallback((time: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = time;
    setCurrentTime(time);
    audio.play().catch(() => setAudioError('Afspilning fejlede'));
  }, []);

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
    } else {
      audio.play().catch(() => setAudioError('Afspilning fejlede'));
    }
  }

  const speakerCounts = useMemo(
    () => segments.reduce<Record<string, number>>((acc, seg) => {
      acc[seg.speaker] = (acc[seg.speaker] ?? 0) + 1;
      return acc;
    }, {}),
    [segments],
  );

  const handleSegmentUpdate = useCallback((index: number, updated: TranscriptSegment) => {
    setSegments((prev) => prev.map((s, i) => (i === index ? updated : s)));
  }, []);

  const handleRenameAll = useCallback(
    async (from: string, to: string) => {
      setSegments((prev) =>
        prev.map((seg) => (seg.speaker === from ? { ...seg, speaker: to } : seg)),
      );
      try {
        await fetch(`/api/meetings/${meetingId}/transcript/speakers`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, to }),
        });
      } catch {
        // optimistic update already applied; persist failure is non-critical
      }
    },
    [meetingId],
  );

  function jumpToSegment(segmentIndex: number) {
    const el = segmentRefs.current[segmentIndex];
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    setHighlightedSegment(segmentIndex);
    highlightTimerRef.current = setTimeout(() => setHighlightedSegment(null), 2000);
  }

  function togglePiiItem(i: number) {
    setCheckedPii((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  function checkAll() {
    setCheckedPii(new Set(piiReplacements.map((_, i) => i)));
  }

  function uncheckAll() {
    setCheckedPii(new Set());
  }

  async function proceedToMinutes() {
    setIsGenerating(true);
    setError(null);
    try {
      const processedSegments = applySelectedPiiReplacements(segments, piiReplacements, checkedPii);
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), 5 * 60 * 1000);
      let res: Response;
      try {
        res = await fetch('/api/minutes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            meetingId,
            transcriptId,
            segments: processedSegments,
            customPrompt: customPrompt.trim() || undefined,
          }),
          signal: abort.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? 'Kunne ikke generere referat');
      }
      router.push(`/meeting/${meetingId}/minutes`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Noget gik galt');
      setIsGenerating(false);
    }
  }

  const typeLabels: Record<string, string> = {
    NAVN: 'Navn',
    CPR: 'CPR-nummer',
    ADRESSE: 'Adresse',
    TELEFON: 'Telefonnummer',
    EMAIL: 'E-mail',
    OTHER: 'Andet',
    ANDEN_PII: 'Andet',
  };

  const piiSegmentIndices = useMemo(
    () => new Set(
      piiReplacements
        .map((r) => r.segmentIndex)
        .filter((i): i is number => i !== undefined),
    ),
    [piiReplacements],
  );

  return (
    <div style={{ minHeight: 'calc(100vh - 56px - 47px - 56px)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', minHeight: 'calc(100vh - 56px - 47px - 56px)' }}>

        {/* ── Left: Transcript ────────────────────────────────────────── */}
        <div style={{ padding: '32px 40px', overflow: 'visible' }}>

          {/* Header */}
          <div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', letterSpacing: 0.4 }}>02 · gennemgang</div>
            <h1 style={{ fontWeight: 300, fontSize: 36, lineHeight: 1.04, letterSpacing: '-0.025em', margin: '6px 0 0' }}>
              Tjek og <em style={{ fontStyle: 'italic' }}>godkend</em>.
            </h1>
          </div>

          {/* Search */}
          <div style={{
            marginTop: 24, borderTop: '1px solid var(--line)',
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '12px 0 0',
            fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--muted)',
          }}>
            <span>⌕</span>
            <input
              placeholder="søg i transskription"
              style={{ flex: 1, color: 'var(--ink-2)', fontSize: 13, background: 'transparent', border: 'none', outline: 'none' }}
            />
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

          {/* Hidden audio element — controlled by the bottom bar */}
          {audioUrl && <audio ref={audioRef} src={audioUrl} preload="metadata" />}

          {/* Hint */}
          <p style={{ marginTop: 16, fontSize: 13, color: 'var(--muted)' }}>
            Ret eventuelle fejl. Klik på et talernavn for at omdøbe alle segmenter for den taler.
          </p>

          {/* Transcript rows */}
          <div style={{ marginTop: 8, borderTop: '1px solid var(--line)' }}>
            {segments.length === 0 ? (
              <p style={{ padding: '32px 0', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
                Ingen transskription fundet.
              </p>
            ) : (
              segments.map((seg, i) => (
                <div
                  key={i}
                  ref={(el) => { segmentRefs.current[i] = el; }}
                >
                  <SpeakerRow
                    segment={seg}
                    index={i}
                    onUpdate={handleSegmentUpdate}
                    onRenameAll={handleRenameAll}
                    speakerSegmentCount={speakerCounts[seg.speaker] ?? 1}
                    onSeek={audioUrl ? seekTo : undefined}
                    hasPii={piiSegmentIndices.has(i)}
                    isHighlighted={highlightedSegment === i}
                  />
                </div>
              ))
            )}
          </div>
        </div>

        {/* ── Right sidebar ─────────────────────────────────────────── */}
        <div style={{
          borderLeft: '1px solid var(--line)', background: 'var(--bg-2)',
          padding: '32px 24px', position: 'sticky', top: 103,
          height: 'calc(100vh - 56px - 47px - 56px)', overflow: 'auto',
          display: 'flex', flexDirection: 'column', gap: 0,
        }}>

          {/* Upload progress */}
          {(uploadStatus === 'uploading' || uploadStatus === 'processing') && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', letterSpacing: 0.4, marginBottom: 8 }}>
                {uploadStatus === 'uploading' ? 'uploader lydoptagelse' : 'analyserer personoplysninger'}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)' }}>
                  {uploadStatus === 'uploading' ? 'upload' : 'PII-analyse'}
                </span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>
                  {uploadStatus === 'uploading' ? `${uploadProgress}%` : '…'}
                </span>
              </div>
              <div style={{ height: 4, background: 'var(--line-2)', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{
                  height: '100%', borderRadius: 2,
                  width: uploadStatus === 'processing' ? '100%' : `${uploadProgress}%`,
                  background: 'var(--accent)',
                  transition: 'width 0.3s',
                  animation: uploadStatus === 'processing' ? 'protoPulse 1.5s ease-in-out infinite' : 'none',
                }} />
              </div>
            </div>
          )}

          {uploadStatus === 'error' && (
            <div style={{
              marginBottom: 16, padding: '12px 14px', borderRadius: 'var(--radius)',
              background: 'var(--kill-wash)', border: '1px solid color-mix(in oklch, var(--kill) 30%, var(--line-2))',
            }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--kill)', marginBottom: 4 }}>upload fejlede</div>
              <div style={{ fontSize: 12.5, color: 'var(--kill)', opacity: 0.8 }}>{uploadError}</div>
              <div style={{ fontSize: 11, color: 'var(--kill)', opacity: 0.7, marginTop: 4 }}>Du kan stadig generere referat.</div>
            </div>
          )}

          {/* Følsom info (PII checklist) */}
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', letterSpacing: 0.4 }}>følsom info</div>
          <div style={{ fontSize: 13, color: 'var(--ink-2)', marginTop: 6, lineHeight: 1.5 }}>
            {piiReplacements.length === 0
              ? (uploadStatus === 'uploading' || uploadStatus === 'processing')
                ? 'Analyse klar når lyden er uploadet.'
                : 'Ingen personoplysninger fundet.'
              : <>Hviske har fundet <strong style={{ color: 'var(--ink)' }}>{piiReplacements.length} ting</strong>, der kan være personoplysninger.</>
            }
          </div>

          {piiReplacements.length > 0 && (
            <div style={{ marginTop: 18 }}>
              {piiReplacements.map((r, i) => (
                <div
                  key={i}
                  onClick={() => { if (r.segmentIndex !== undefined) jumpToSegment(r.segmentIndex); }}
                  style={{
                    padding: '12px 0',
                    borderTop: i === 0 ? '1px solid var(--line-2)' : '1px solid var(--line)',
                    display: 'grid', gridTemplateColumns: '20px 1fr auto',
                    gap: 12, alignItems: 'flex-start', cursor: 'pointer',
                  }}
                >
                  <span
                    onClick={(e) => { e.stopPropagation(); togglePiiItem(i); }}
                    style={{
                      width: 16, height: 16, borderRadius: 3, marginTop: 3, cursor: 'pointer', flexShrink: 0,
                      border: '1px solid ' + (checkedPii.has(i) ? 'var(--accent)' : 'var(--line-2)'),
                      background: checkedPii.has(i) ? 'var(--accent)' : 'var(--bg)',
                      color: '#fff', fontSize: 11, fontWeight: 600,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                  >{checkedPii.has(i) ? '✓' : ''}</span>
                  <div>
                    <div style={{
                      fontFamily: 'var(--mono)', fontSize: 13.5, color: 'var(--ink)',
                      textDecoration: checkedPii.has(i) ? 'line-through' : 'none',
                      textDecorationColor: 'var(--accent)', textDecorationThickness: 1,
                    }}>{r.original}</div>
                    <div style={{
                      marginTop: 3, fontFamily: 'var(--mono)', fontSize: 10.5,
                      color: 'var(--muted)', letterSpacing: 0.3,
                    }}>
                      {typeLabels[r.type] ?? r.type}
                    </div>
                  </div>
                  {r.segmentIndex !== undefined && (
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted-2)', paddingTop: 3 }}>vis →</span>
                  )}
                </div>
              ))}
              <div style={{
                padding: '8px 0', borderTop: '1px solid var(--line-2)',
                display: 'flex', gap: 10,
                fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)',
              }}>
                <button onClick={checkAll} style={{ color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 11, fontFamily: 'var(--mono)' }}>marker alle</button>
                <span>·</span>
                <button onClick={uncheckAll} style={{ color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 11, fontFamily: 'var(--mono)' }}>fravælg alle</button>
                <span style={{ marginLeft: 'auto' }}>{checkedPii.size}/{piiReplacements.length}</span>
              </div>
            </div>
          )}

          {/* Skabelon / prompt */}
          <div style={{ marginTop: 28 }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', letterSpacing: 0.4, marginBottom: 10 }}>skabelon</div>
            {['Standard', 'Beslutninger', 'Handlepunkter', 'Fuld detalje'].map((s) => (
              <div
                key={s}
                onClick={() => setCustomPrompt((p) => p === s ? '' : s)}
                style={{
                  padding: '8px 10px', marginBottom: 4,
                  border: '1px solid ' + (customPrompt === s ? 'var(--accent)' : 'var(--line)'),
                  background: customPrompt === s ? 'var(--accent-wash)' : 'transparent',
                  borderRadius: 'var(--radius)',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 12,
                  color: customPrompt === s ? 'var(--accent)' : 'var(--ink-2)',
                }}
              >
                <span>{s}</span>
              </div>
            ))}
            <textarea
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              placeholder="Eller beskriv selv referatet…"
              rows={2}
              style={{
                width: '100%', marginTop: 8, minHeight: 60,
                fontFamily: 'var(--mono)', fontSize: 11.5,
                color: 'var(--ink)', lineHeight: 1.6,
                background: 'var(--bg)', border: '1px solid var(--line-2)',
                borderRadius: 'var(--radius)', padding: '8px 10px',
                resize: 'vertical', outline: 'none',
              }}
            />
          </div>

          {/* Compliance */}
          <div style={{
            marginTop: 24, padding: '14px 16px', borderRadius: 'var(--radius)',
            border: '1px solid color-mix(in oklch, var(--kill) 25%, var(--line-2))',
            background: 'var(--kill-wash)',
          }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--kill)', letterSpacing: 0.3, marginBottom: 6 }}>
              § compliance · automatisk
            </div>
            <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.6 }}>
              Lydfilen slettes automatisk når referatet genereres.
            </div>
          </div>

          {/* Generate button */}
          <button
            onClick={proceedToMinutes}
            disabled={isGenerating || segments.length === 0}
            style={{
              marginTop: 12, width: '100%', padding: '12px 16px',
              background: 'var(--accent)', color: '#fff',
              border: '1px solid var(--accent)', borderRadius: 'var(--radius)',
              fontFamily: 'var(--mono)', fontSize: 13.5, fontWeight: 500,
              cursor: isGenerating || segments.length === 0 ? 'not-allowed' : 'pointer',
              opacity: isGenerating || segments.length === 0 ? 0.5 : 1,
            }}
          >
            {isGenerating ? 'genererer…' : 'generér referat →'}
          </button>
          <div style={{ marginTop: 8, fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--muted)', textAlign: 'center' }}>
            kan altid redigeres bagefter
          </div>
        </div>
      </div>

      {/* Sticky bottom player */}
      <div style={{
        position: 'sticky', bottom: 0,
        height: 56, borderTop: '1px solid var(--line)',
        background: 'var(--surface)',
        display: 'flex', alignItems: 'center', gap: 16,
        padding: '0 32px', zIndex: 5,
      }}>
        {audioUrl ? (
          <>
            <button
              onClick={togglePlay}
              style={{
                width: 32, height: 32, borderRadius: 999, background: 'var(--ink)',
                border: 'none', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}
            >
              {isPlaying
                ? <span style={{ width: 10, height: 12, display: 'flex', gap: 3 }}>
                    <span style={{ width: 3, height: '100%', background: 'var(--bg)', display: 'block' }} />
                    <span style={{ width: 3, height: '100%', background: 'var(--bg)', display: 'block' }} />
                  </span>
                : <span style={{ width: 0, height: 0, borderTop: '5px solid transparent', borderBottom: '5px solid transparent', borderLeft: '8px solid var(--bg)', marginLeft: 2 }} />
              }
            </button>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-2)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
              {Math.floor(currentTime / 60).toString().padStart(2, '0')}:{Math.floor(currentTime % 60).toString().padStart(2, '0')}
            </span>
            <div
              style={{ flex: 1, height: 2, background: 'var(--line-2)', position: 'relative', borderRadius: 1, cursor: 'pointer' }}
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const pct = (e.clientX - rect.left) / rect.width;
                seekTo(pct * duration);
              }}
            >
              <div style={{
                position: 'absolute', left: 0, top: 0, height: '100%',
                width: duration > 0 ? `${(currentTime / duration) * 100}%` : '0%',
                background: 'var(--ink-2)', borderRadius: 1,
              }} />
            </div>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
              {Math.floor(duration / 60).toString().padStart(2, '0')}:{Math.floor(duration % 60).toString().padStart(2, '0')}
            </span>
          </>
        ) : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted-2)' }}>
            {(uploadStatus === 'uploading' || uploadStatus === 'processing') && (
              <span style={{
                width: 14, height: 14, borderRadius: 999, flexShrink: 0,
                border: '2px solid var(--line-2)', borderTopColor: 'var(--accent)',
                display: 'inline-block', animation: 'spin 0.8s linear infinite',
              }} />
            )}
            {uploadStatus === 'uploading'
              ? `uploader lydfil… ${uploadProgress}%`
              : uploadStatus === 'processing'
              ? 'analyserer personoplysninger…'
              : 'ingen lydfil'}
          </span>
        )}
      </div>
    </div>
  );
}
