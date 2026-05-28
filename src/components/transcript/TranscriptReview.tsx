'use client';

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { TranscriptSegment, PiiReplacement } from '@/types';
import { SpeakerRow } from './SpeakerRow';
import { WaveformPlayer } from './WaveformPlayer';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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

  const piiTypeVariant = (type: string) => {
    if (type === 'CPR') return 'destructive' as const;
    if (type === 'NAVN') return 'default' as const;
    return 'secondary' as const;
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
    <div className="mx-auto max-w-[1040px] px-6 py-12">
      {error && (
        <div
          className="mb-6 rounded-[var(--radius)] border px-4 py-3 text-sm text-[var(--danger)]"
          style={{ backgroundColor: 'var(--danger-wash)', borderColor: 'var(--danger)' }}
        >
          {error}
        </div>
      )}

      <div className="flex gap-8 items-start">
        {/* Transcript — main column */}
        <div className="flex-1 min-w-0">
          <h1
            className="mb-6 font-medium text-[var(--ink)]"
            style={{ fontSize: 'var(--t-h2)' }}
          >
            Transskription
          </h1>
          <p className="mb-6 text-[var(--muted)]" style={{ fontSize: 'var(--t-small)' }}>
            Ret eventuelle fejl. Klik på et talernavn for at omdøbe alle segmenter for den taler.
          </p>

          {/* Audio player — only shown once audio is available */}
          {audioUrl && (
            <>
              <audio ref={audioRef} src={audioUrl} preload="metadata" />
              {audioError && (
                <p className="mb-3 text-[var(--danger)]" style={{ fontSize: 'var(--t-micro)' }}>
                  {audioError}
                </p>
              )}
              <WaveformPlayer
                audioUrl={audioUrl}
                currentTime={currentTime}
                duration={duration}
                isPlaying={isPlaying}
                onTogglePlay={togglePlay}
                onSeek={seekTo}
              />
            </>
          )}

          <div className="divide-y divide-[var(--line)]">
            {segments.length === 0 ? (
              <p className="py-8 text-center text-[var(--muted)]" style={{ fontSize: 'var(--t-small)' }}>
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

        {/* Right sticky panel */}
        <div className="w-80 shrink-0 sticky top-20">

          {/* Audio upload progress */}
          {(uploadStatus === 'uploading' || uploadStatus === 'processing') && (
            <div
              className="mb-4 border border-[var(--line)] rounded-[var(--radius)] bg-[var(--surface)] overflow-hidden"
            >
              <div className="px-4 py-3">
                <div className="flex items-center justify-between mb-2">
                  <p className="font-medium text-[var(--ink)]" style={{ fontSize: 'var(--t-small)' }}>
                    {uploadStatus === 'uploading' ? 'Uploader lydoptagelse' : 'Analyserer PII'}
                  </p>
                  <span className="text-[var(--muted)] tabular-nums" style={{ fontSize: 'var(--t-micro)' }}>
                    {uploadStatus === 'uploading' ? `${uploadProgress}%` : ''}
                  </span>
                </div>
                {/* Progress bar */}
                <div
                  className="w-full rounded-full overflow-hidden"
                  style={{ height: 6, backgroundColor: 'var(--line)' }}
                >
                  <div
                    className="h-full rounded-full transition-all duration-300"
                    style={{
                      width: uploadStatus === 'processing' ? '100%' : `${uploadProgress}%`,
                      backgroundColor: 'var(--accent)',
                      transition: uploadStatus === 'processing'
                        ? 'width 0.3s, background-color 0.3s'
                        : 'width 0.3s',
                      animation: uploadStatus === 'processing' ? 'pulse 1.5s ease-in-out infinite' : 'none',
                    }}
                  />
                </div>
                <p className="mt-1.5 text-[var(--muted)]" style={{ fontSize: 'var(--t-micro)' }}>
                  {uploadStatus === 'uploading'
                    ? 'Lydfilen uploades — afspilleren er klar når det er færdigt'
                    : 'Søger efter personhenvisninger…'}
                </p>
              </div>
            </div>
          )}

          {uploadStatus === 'error' && (
            <div
              className="mb-4 border rounded-[var(--radius)] px-4 py-3"
              style={{ borderColor: 'var(--danger)', backgroundColor: 'var(--danger-wash)' }}
            >
              <p className="font-medium" style={{ fontSize: 'var(--t-small)', color: 'var(--danger)' }}>
                Upload fejlede
              </p>
              <p className="mt-0.5" style={{ fontSize: 'var(--t-micro)', color: 'var(--danger)', opacity: 0.8 }}>
                {uploadError}
              </p>
              <p className="mt-1" style={{ fontSize: 'var(--t-micro)', color: 'var(--danger)', opacity: 0.7 }}>
                Du kan stadig generere referat fra transskriptionen.
              </p>
            </div>
          )}

          {/* PII checklist */}
          {piiReplacements.length > 0 && (
            <div className="border border-[var(--line)] rounded-[var(--radius)] bg-[var(--surface)] mb-4 overflow-hidden">
              <div className="px-4 py-3 border-b border-[var(--line)]">
                <p className="font-medium text-[var(--ink)]" style={{ fontSize: 'var(--t-small)' }}>
                  Personhenvisninger fundet
                </p>
                <p className="text-[var(--muted)] mt-0.5" style={{ fontSize: 'var(--t-micro)' }}>
                  Vælg hvad der skal fjernes inden referatet genereres
                </p>
              </div>
              <div className="divide-y divide-[var(--line)] max-h-72 overflow-y-auto">
                {piiReplacements.map((r, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-[var(--surface-2)] transition-colors group"
                    onClick={() => {
                      if (r.segmentIndex !== undefined) jumpToSegment(r.segmentIndex);
                    }}
                    title={r.segmentIndex !== undefined ? 'Gå til segment i transskription' : undefined}
                  >
                    <input
                      type="checkbox"
                      checked={checkedPii.has(i)}
                      onChange={() => togglePiiItem(i)}
                      onClick={(e) => e.stopPropagation()}
                      className="shrink-0 cursor-pointer accent-[var(--accent)]"
                      style={{ width: 15, height: 15 }}
                    />
                    <span
                      className="flex-1 min-w-0 truncate text-[var(--ink)]"
                      style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--t-micro)' }}
                    >
                      {r.original}
                    </span>
                    <Badge variant={piiTypeVariant(r.type)} className="shrink-0 text-[10px]">
                      {typeLabels[r.type] ?? r.type}
                    </Badge>
                    {r.segmentIndex !== undefined && (
                      <span
                        className="shrink-0 opacity-0 group-hover:opacity-60 transition-opacity text-[var(--muted)]"
                        style={{ fontSize: 11 }}
                        aria-hidden
                      >
                        ↗
                      </span>
                    )}
                  </div>
                ))}
              </div>
              <div className="px-4 py-2.5 border-t border-[var(--line)] flex items-center justify-between gap-2">
                <div className="flex gap-2">
                  <button
                    onClick={checkAll}
                    className="text-[var(--accent)] hover:underline"
                    style={{ fontSize: 'var(--t-micro)' }}
                  >
                    Marker alle
                  </button>
                  <span className="text-[var(--muted)]" style={{ fontSize: 'var(--t-micro)' }}>·</span>
                  <button
                    onClick={uncheckAll}
                    className="text-[var(--muted)] hover:text-[var(--ink)] hover:underline"
                    style={{ fontSize: 'var(--t-micro)' }}
                  >
                    Fravælg alle
                  </button>
                </div>
                <span className="text-[var(--muted)]" style={{ fontSize: 'var(--t-micro)' }}>
                  {checkedPii.size}/{piiReplacements.length} markeret
                </span>
              </div>
            </div>
          )}

          {/* Placeholder while upload is in progress and no PII found yet */}
          {piiReplacements.length === 0 && (uploadStatus === 'uploading' || uploadStatus === 'processing') && (
            <div
              className="mb-4 border border-[var(--line)] rounded-[var(--radius)] bg-[var(--surface)] px-4 py-3"
            >
              <p className="text-[var(--muted)]" style={{ fontSize: 'var(--t-micro)' }}>
                PII-analyse klar når lyden er uploadet.
              </p>
            </div>
          )}

          {/* Custom summarisation prompt */}
          <div className="mb-4">
            <p className="font-medium text-[var(--ink)] mb-2" style={{ fontSize: 'var(--t-small)' }}>
              Tilpas referatet
            </p>
            <textarea
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              placeholder="Hvad vil du fokusere på? F.eks. 'kun beslutninger' eller 'kort punktliste'"
              rows={3}
              className="w-full border border-[var(--line)] rounded-[var(--radius)] px-3 py-2 bg-[var(--surface)] text-[var(--ink)] outline-none focus:border-[var(--accent)] resize-none placeholder:text-[var(--muted-2)]"
              style={{ fontSize: 'var(--t-small)' }}
            />
            <div className="flex flex-wrap gap-1.5 mt-2">
              {['Kun beslutninger', 'Kort opsummering', 'Handlingspunkter', 'Fuld detalje'].map((chip) => (
                <button
                  key={chip}
                  onClick={() => setCustomPrompt((p) => p === chip ? '' : chip)}
                  className="rounded-full border px-2.5 py-0.5 transition-colors"
                  style={{
                    fontSize: 'var(--t-micro)',
                    borderColor: customPrompt === chip ? 'var(--accent)' : 'var(--line)',
                    color: customPrompt === chip ? 'var(--accent)' : 'var(--muted)',
                  }}
                >
                  {chip}
                </button>
              ))}
            </div>
          </div>

          {/* Actions */}
          <div className="space-y-2">
            <Button
              className="w-full"
              onClick={proceedToMinutes}
              disabled={isGenerating || segments.length === 0}
            >
              {isGenerating ? 'Genererer…' : 'Generér referat'}
            </Button>
            <div
              className="w-full rounded-[var(--radius)] border px-4 py-3 flex items-center justify-between gap-3 cursor-pointer hover:bg-[var(--danger-wash)] transition-colors"
              style={{ borderColor: 'var(--danger)', backgroundColor: 'var(--danger-wash)' }}
              onClick={() => router.push(`/meeting/${meetingId}/settings`)}
              role="button"
            >
              <div>
                <p className="font-medium" style={{ fontSize: 'var(--t-small)', color: 'var(--danger)' }}>
                  Slet følsomt indhold
                </p>
                <p style={{ fontSize: 'var(--t-micro)', color: 'var(--danger)', opacity: 0.7 }}>
                  Fjern lyd og rå transskription permanent
                </p>
              </div>
              <span style={{ color: 'var(--danger)', fontSize: 'var(--t-small)' }}>→</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
