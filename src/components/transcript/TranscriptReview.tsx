'use client';

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { TranscriptSegment, PiiReplacement } from '@/types';
import { SpeakerRow } from './SpeakerRow';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

interface TranscriptReviewProps {
  meetingId: string;
  transcriptId: string;
  initialSegments: TranscriptSegment[];
  piiReplacements: PiiReplacement[];
  audioUrl?: string;
}

export function TranscriptReview({
  meetingId,
  transcriptId,
  initialSegments,
  piiReplacements,
  audioUrl,
}: TranscriptReviewProps) {
  const router = useRouter();
  const [segments, setSegments] = useState(initialSegments);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customPrompt, setCustomPrompt] = useState('');

  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => setCurrentTime(audio.currentTime);
    const onMeta = () => setDuration(audio.duration);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => setIsPlaying(false);
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
    };
  }, []);

  function seekTo(time: number) {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = time;
    audio.play();
  }

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) audio.pause();
    else audio.play();
  }

  function fmt(secs: number) {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  const speakerCounts = segments.reduce<Record<string, number>>((acc, seg) => {
    acc[seg.speaker] = (acc[seg.speaker] ?? 0) + 1;
    return acc;
  }, {});

  function handleSegmentUpdate(index: number, updated: TranscriptSegment) {
    setSegments((prev) => prev.map((s, i) => (i === index ? updated : s)));
  }

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

  async function proceedToMinutes() {
    setIsGenerating(true);
    setError(null);
    try {
      const res = await fetch('/api/minutes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meetingId, transcriptId, segments, customPrompt: customPrompt.trim() || undefined }),
      });
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

      {/* Two-column layout: transcript left, PII panel + actions right */}
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

          {/* Audio player */}
          {audioUrl && (
            <>
              <audio ref={audioRef} src={audioUrl} preload="metadata" />
              <div
                className="mb-6 flex items-center gap-3 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--surface)] px-4 py-2.5"
              >
                <button
                  type="button"
                  onClick={togglePlay}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: '50%',
                    background: 'var(--ink)',
                    color: 'white',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: 11,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                  title={isPlaying ? 'Pause' : 'Afspil'}
                >
                  {isPlaying ? '⏸' : '▶'}
                </button>
                <span
                  className="tabular-nums text-[var(--muted)] shrink-0"
                  style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--t-micro)' }}
                >
                  {fmt(currentTime)}
                </span>
                <input
                  type="range"
                  min={0}
                  max={duration || 1}
                  step={0.5}
                  value={currentTime}
                  onChange={(e) => {
                    const t = parseFloat(e.target.value);
                    if (audioRef.current) audioRef.current.currentTime = t;
                    setCurrentTime(t);
                  }}
                  className="flex-1"
                  style={{ accentColor: 'var(--accent)' }}
                />
                <span
                  className="tabular-nums text-[var(--muted)] shrink-0"
                  style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--t-micro)' }}
                >
                  {fmt(duration)}
                </span>
              </div>
            </>
          )}

          <div className="divide-y divide-[var(--line)]">
            {segments.length === 0 ? (
              <p className="py-8 text-center text-[var(--muted)]" style={{ fontSize: 'var(--t-small)' }}>
                Ingen transskription fundet.
              </p>
            ) : (
              segments.map((seg, i) => (
                <SpeakerRow
                  key={i}
                  segment={seg}
                  index={i}
                  onUpdate={handleSegmentUpdate}
                  onRenameAll={handleRenameAll}
                  speakerSegmentCount={speakerCounts[seg.speaker] ?? 1}
                  onSeek={audioUrl ? seekTo : undefined}
                />
              ))
            )}
          </div>
        </div>

        {/* Right sticky panel */}
        <div className="w-80 shrink-0 sticky top-20">
          {/* PII replacements */}
          {piiReplacements.length > 0 && (
            <div className="border border-[var(--line)] rounded-[var(--radius)] bg-[var(--surface)] mb-4 overflow-hidden">
              <div className="px-4 py-3 border-b border-[var(--line)]">
                <p className="font-medium text-[var(--ink)]" style={{ fontSize: 'var(--t-small)' }}>
                  {piiReplacements.length} PII fjernet
                </p>
              </div>
              <div className="divide-y divide-[var(--line)] max-h-64 overflow-y-auto">
                {piiReplacements.map((r, i) => (
                  <div key={i} className="flex items-center justify-between gap-2 px-4 py-2.5">
                    <div>
                      <span
                        className="line-through text-[var(--muted)]"
                        style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--t-micro)' }}
                      >
                        {r.original}
                      </span>
                      <span
                        className="ml-1.5 text-[var(--ink-2)]"
                        style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--t-micro)' }}
                      >
                        {r.replacement}
                      </span>
                    </div>
                    <Badge variant={piiTypeVariant(r.type)} className="shrink-0 text-[10px]">
                      {typeLabels[r.type] ?? r.type}
                    </Badge>
                  </div>
                ))}
              </div>
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
