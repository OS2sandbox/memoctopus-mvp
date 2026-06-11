'use client';

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { TranscriptSegment, PiiReplacement } from '@/types';
import { SpeakerRow } from './SpeakerRow';
import { WaveformPlayer } from './WaveformPlayer';
import { saveTranscriptChapters, saveTranscriptSegments, saveMinutes, deleteAudio, updateMeeting } from '@/lib/storage';
import type { MinutesContent } from '@/types';
import { useIsMobile } from '@/lib/use-is-mobile';

interface TranscriptReviewProps {
  meetingId: string;
  initialSegments: TranscriptSegment[];
  piiReplacements: PiiReplacement[];
  audioUrl?: string;
  audioDurationSeconds?: number | null;
  audioDeleted?: boolean;
  initialChapters?: TranscriptChapter[];
  participants?: string[];
  onDataChange?: () => void;
}

interface TranscriptChapter {
  id: string;
  title: string;
  summary: string;
  startTime: number;
  endTime: number;
  segmentIndices: number[];
}

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
  initialSegments,
  piiReplacements: initialPiiReplacements,
  audioUrl: initialAudioUrl,
  audioDurationSeconds,
  audioDeleted = false,
  initialChapters,
  participants,
  onDataChange,
}: TranscriptReviewProps) {
  const isMobile = useIsMobile();
  const [segments, setSegments] = useState(initialSegments);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editableParticipants, setEditableParticipants] = useState<string[]>(() => {
    if (typeof window === 'undefined') return participants ?? [];
    try {
      const saved = sessionStorage.getItem(`participants-${meetingId}`);
      if (saved) return JSON.parse(saved) as string[];
    } catch { /* ignore */ }
    return participants ?? [];
  });
  const [newParticipantInput, setNewParticipantInput] = useState('');

  useEffect(() => {
    try { sessionStorage.setItem(`participants-${meetingId}`, JSON.stringify(editableParticipants)); } catch { /* ignore */ }
  }, [editableParticipants, meetingId]);
  const [activeKeywords, setActiveKeywords] = useState<Set<string>>(new Set());
  const [customText, setCustomText] = useState('');

  // PII checklist: all items checked by default
  const [piiReplacements, setPiiReplacements] = useState<PiiReplacement[]>(initialPiiReplacements);
  const [checkedPii, setCheckedPii] = useState<Set<number>>(
    () => new Set(initialPiiReplacements.map((_, i) => i)),
  );
  const displaySegments = useMemo(
    () => applySelectedPiiReplacements(segments, piiReplacements, checkedPii),
    [segments, piiReplacements, checkedPii],
  );

  const [highlightedSegment, setHighlightedSegment] = useState<number | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const segmentRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Audio player
  const [audioUrl, setAudioUrl] = useState(initialAudioUrl);
  // Sync audioUrl when the prop changes (e.g. after router.refresh() post-deletion)
  useEffect(() => {
    setAudioUrl(initialAudioUrl);
  }, [initialAudioUrl]);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(audioDurationSeconds ?? 0);
  const [audioError, setAudioError] = useState<string | null>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => setCurrentTime(audio.currentTime);
    const onMeta = () => {
      if (isFinite(audio.duration) && audio.duration > 0) setDuration(audio.duration);
    };
    const onDurationChange = () => {
      if (isFinite(audio.duration) && audio.duration > 0) setDuration(audio.duration);
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
    // Metadata may have loaded before listeners were attached (e.g. from cache)
    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA && isFinite(audio.duration) && audio.duration > 0) {
      setDuration(audio.duration);
    }
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('durationchange', onDurationChange);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
    };
  // Re-run when audioUrl changes so listeners attach to any newly created audio element
  }, [audioUrl]);

  // Fallback: decode via AudioContext to get duration when audio element reports Infinity (webm streams)
  useEffect(() => {
    if (!audioUrl || duration > 0) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(audioUrl);
        if (!res.ok || cancelled) return;
        const buf = await res.arrayBuffer();
        if (cancelled) return;
        const actx = new AudioContext();
        const decoded = await actx.decodeAudioData(buf);
        actx.close();
        if (!cancelled && decoded.duration > 0) setDuration(decoded.duration);
      } catch { /* non-critical */ }
    })();
    return () => { cancelled = true; };
  }, [audioUrl, duration]);

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
      const updated = segments.map((seg) => (seg.speaker === from ? { ...seg, speaker: to } : seg));
      setSegments(updated);
      try {
        await saveTranscriptSegments(meetingId, updated);
      } catch (err) {
        console.error('[speakers] rename persist failed:', err);
      }
    },
    [meetingId, segments],
  );

  function jumpToSegment(segmentIndex: number) {
    // Open the chapter containing this segment, close all others
    if (chapters) {
      const target = chapters.find((ch) => ch.segmentIndices.includes(segmentIndex));
      if (target) setOpenChapters(new Set([target.id]));
    }

    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    setHighlightedSegment(segmentIndex);
    highlightTimerRef.current = setTimeout(() => setHighlightedSegment(null), 2000);

    // Delay scroll to let the chapter open and render first
    setTimeout(() => {
      const el = segmentRefs.current[segmentIndex];
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 80);
  }

  function goToMatch(idx: number) {
    if (matches.length === 0) return;
    const clamped = ((idx % matches.length) + matches.length) % matches.length;
    setMatchIndex(clamped);
    jumpToSegment(matches[clamped]);
  }

  function replaceCurrentMatch() {
    if (!search || !replace || matches.length === 0) return;
    const effectiveIdx = matchIndex < 0 ? 0 : matchIndex;
    const segIdx = matches[effectiveIdx];
    const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    setSegments((prev) => prev.map((s, i) => i === segIdx ? { ...s, text: s.text.replace(re, replace) } : s));
    setTimeout(() => {
      if (matches.length > 1) goToMatch(effectiveIdx + 1);
    }, 50);
  }

  function replaceAllMatches() {
    if (!search || !replace || matches.length === 0) return;
    const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const matchSet = new Set(matches);
    setSegments((prev) => prev.map((s, i) => matchSet.has(i) ? { ...s, text: s.text.replace(re, replace) } : s));
    setMatchIndex(-1);
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
      const processedSegments = displaySegments;
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), 5 * 60 * 1000);
      let res: Response;
      try {
        res = await fetch('/api/minutes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            segments: processedSegments,
            participants: editableParticipants.filter(Boolean),
            customPrompt: [...Array.from(activeKeywords), customText.trim()].filter(Boolean).join(', ') || undefined,
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
      const data = await res.json() as { content: MinutesContent; templateId?: string };
      await saveMinutes(meetingId, data.content, data.templateId);
      await deleteAudio(meetingId);
      await updateMeeting(meetingId, { status: 'minutes', audioDeleted: true });
      onDataChange?.();
      window.location.href = `/meeting/${meetingId}/minutes`;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Noget gik galt');
    } finally {
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

  // Chapters
  const [search, setSearch] = useState('');
  const [replace, setReplace] = useState('');
  const [showReplace, setShowReplace] = useState(false);
  const [matchIndex, setMatchIndex] = useState(-1);

  const matches = useMemo(() => {
    if (!search.trim()) return [] as number[];
    const q = search.toLowerCase();
    return displaySegments.reduce<number[]>((acc, seg, idx) => {
      if (seg.text.toLowerCase().includes(q) || seg.speaker.toLowerCase().includes(q)) acc.push(idx);
      return acc;
    }, []);
  }, [search, displaySegments]);

  const [chapters, setChapters] = useState<TranscriptChapter[] | null>(
    initialChapters && initialChapters.length > 0 ? initialChapters : null,
  );
  const [chaptersLoading, setChaptersLoading] = useState(false);
  const [openChapters, setOpenChapters] = useState<Set<string>>(
    () => initialChapters && initialChapters.length > 0 ? new Set([initialChapters[0].id]) : new Set(),
  );

  const saveChapters = useCallback((updated: TranscriptChapter[]) => {
    saveTranscriptChapters(meetingId, updated).catch((err) => console.error('[chapters] save failed:', err));
  }, [meetingId]);

  useEffect(() => {
    if (initialChapters && initialChapters.length > 0) return;
    if (initialSegments.length === 0) return;
    setChaptersLoading(true);
    fetch(`/api/meetings/${meetingId}/chapters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ segments: initialSegments }),
    })
      .then((r) => (r.ok ? r.json() : { chapters: [] }))
      .then((data) => {
        const chs = (data.chapters ?? []) as TranscriptChapter[];
        setChapters(chs.length > 0 ? chs : null);
        if (chs.length > 0) {
          setOpenChapters(new Set([chs[0].id]));
          saveTranscriptChapters(meetingId, chs).catch(() => {});
        }
      })
      .catch((err) => console.error('[chapters] generate failed:', err))
      .finally(() => setChaptersLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const piiSegmentIndices = useMemo(
    () => new Set(
      piiReplacements
        .map((r) => r.segmentIndex)
        .filter((i): i is number => i !== undefined),
    ),
    [piiReplacements],
  );

  function fmtTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  return (
    <div style={{ height: isMobile ? 'auto' : 'calc(100vh - 56px - 47px - 56px)' }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: isMobile ? '1fr' : '1fr 360px',
        height: isMobile ? 'auto' : '100%',
      }}>

        {/* ── Left: Transcript ────────────────────────────────────────── */}
        <div style={{ padding: isMobile ? '24px 20px 0' : '32px 40px 0', display: 'flex', flexDirection: 'column', overflow: isMobile ? 'visible' : 'hidden' }}>

          {/* Header */}
          <div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', letterSpacing: 0.4 }}>02 · gennemgang</div>
            <h1 style={{ fontWeight: 300, fontSize: isMobile ? 28 : 36, lineHeight: 1.04, letterSpacing: '-0.025em', margin: '6px 0 0' }}>
              Tjek og <em style={{ fontStyle: 'italic', color: 'var(--accent)' }}>godkend</em>.
            </h1>
          </div>

          {/* Search + Replace */}
          <div style={{ marginTop: 24, borderTop: '1px solid var(--line)', fontFamily: 'var(--mono)', fontSize: 13 }}>
            {/* Search row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 0 0', color: 'var(--muted)' }}>
              <span style={{ fontSize: 16, color: 'var(--accent)' }}>⌕</span>
              <input
                value={search}
                onChange={(e) => { setSearch(e.target.value); setMatchIndex(-1); }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  if (matches.length === 0) return;
                  goToMatch(e.shiftKey
                    ? (matchIndex <= 0 ? matches.length - 1 : matchIndex - 1)
                    : matchIndex < 0 ? 0 : matchIndex + 1);
                }}
                placeholder="søg i transskription"
                style={{ flex: 1, color: 'var(--ink-2)', fontSize: 13, background: 'transparent', border: 'none', outline: 'none' }}
              />
              {search && matches.length > 0 && (
                <span style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                  {matchIndex >= 0 ? matchIndex + 1 : '?'} / {matches.length}
                </span>
              )}
              {search && matches.length === 0 && (
                <span style={{ fontSize: 11, color: 'var(--danger)' }}>ingen</span>
              )}
              {search && matches.length > 0 && (
                <>
                  <button onClick={() => goToMatch(matchIndex <= 0 ? matches.length - 1 : matchIndex - 1)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-2)', fontSize: 12, padding: '0 2px', fontFamily: 'var(--mono)' }}>↑</button>
                  <button onClick={() => goToMatch(matchIndex < 0 ? 0 : matchIndex + 1)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-2)', fontSize: 12, padding: '0 2px', fontFamily: 'var(--mono)' }}>↓</button>
                </>
              )}
              <button
                onClick={() => setShowReplace((v) => !v)}
                title="Søg og erstat"
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', fontFamily: 'var(--mono)', fontSize: 16, color: 'var(--accent)' }}
              >⇄</button>
              {search && (
                <span onClick={() => { setSearch(''); setMatchIndex(-1); }} style={{ cursor: 'pointer', color: 'var(--muted-2)', fontSize: 13 }}>×</span>
              )}
            </div>
            {/* Replace row */}
            {showReplace && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0 4px', borderTop: '1px solid var(--line-2)', color: 'var(--muted)' }}>
                <span style={{ opacity: 0 }}>⌕</span>
                <input
                  value={replace}
                  onChange={(e) => setReplace(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); replaceCurrentMatch(); } }}
                  placeholder="erstat med"
                  style={{ flex: 1, color: 'var(--ink-2)', fontSize: 13, background: 'transparent', border: 'none', outline: 'none' }}
                />
                <button
                  onClick={replaceCurrentMatch}
                  disabled={!search || !replace || matches.length === 0}
                  style={{ fontSize: 11, color: 'var(--ink-2)', background: 'none', border: '1px solid var(--line-2)', cursor: 'pointer', padding: '3px 8px', borderRadius: 'var(--radius)', fontFamily: 'var(--mono)', opacity: (!search || !replace || matches.length === 0) ? 0.4 : 1 }}
                >erstat</button>
                <button
                  onClick={replaceAllMatches}
                  disabled={!search || !replace || matches.length === 0}
                  style={{ fontSize: 11, color: 'var(--ink-2)', background: 'none', border: '1px solid var(--line-2)', cursor: 'pointer', padding: '3px 8px', borderRadius: 'var(--radius)', fontFamily: 'var(--mono)', opacity: (!search || !replace || matches.length === 0) ? 0.4 : 1 }}
                >erstat alle</button>
              </div>
            )}
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

          {/* Transcript — chapters or flat fallback */}
          <div style={{ marginTop: 8, flex: 1, overflowY: 'auto' }}>
            {chaptersLoading && (
              <div style={{
                padding: '24px 0', display: 'flex', alignItems: 'center', gap: 10,
                fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)',
                borderTop: '1px solid var(--line)',
              }}>
                <span style={{
                  width: 14, height: 14, borderRadius: 999, flexShrink: 0,
                  border: '2px solid var(--line-2)', borderTopColor: 'var(--accent)',
                  display: 'inline-block', animation: 'spin 0.8s linear infinite',
                }} />
                grupperer transskription…
              </div>
            )}

            {!chaptersLoading && chapters && chapters.map((ch) => {
              const isOpen = openChapters.has(ch.id);
              const chSegs = ch.segmentIndices
                .map((idx) => ({ seg: displaySegments[idx], idx }))
                .filter(({ seg }) => !!seg);
              const q = search.toLowerCase();
              const hasMatch = !!q && chSegs.some(
                ({ seg }) => seg.text.toLowerCase().includes(q) || seg.speaker.toLowerCase().includes(q),
              );
              return (
                <div
                  key={ch.id}
                  style={{ borderTop: '1px solid var(--line)' }}
                >
                  <div
                    onClick={() => {
                      const isNowOpen = !openChapters.has(ch.id);
                      setOpenChapters((prev) => prev.has(ch.id) ? new Set() : new Set([ch.id]));
                      // If opening with an active search, jump to first match in this chapter
                      if (isNowOpen && search.trim() && matches.length > 0) {
                        const firstInChapter = ch.segmentIndices.find((si) => matches.includes(si));
                        if (firstInChapter !== undefined) {
                          const globalIdx = matches.indexOf(firstInChapter);
                          setTimeout(() => goToMatch(globalIdx), 80);
                        }
                      }
                    }}
                    style={{
                      padding: '20px 0', cursor: 'pointer',
                      display: 'grid', gridTemplateColumns: '24px 90px 1fr',
                      gap: 16, alignItems: 'baseline',
                    }}
                  >
                    <span style={{
                      fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted-2)',
                      transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                      transition: 'transform 160ms', display: 'inline-block',
                    }}>▸</span>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--accent)' }}>
                      {fmtTime(ch.startTime)} — {fmtTime(ch.endTime)}
                    </span>
                    <div>
                      <div
                        contentEditable
                        suppressContentEditableWarning
                        onClick={(e) => e.stopPropagation()}
                        onBlur={(e) => {
                          const t = e.currentTarget.textContent?.trim() ?? '';
                          if (t && t !== ch.title) {
                            const updated = (chapters ?? []).map((c) => c.id === ch.id ? { ...c, title: t } : c);
                            setChapters(updated);
                            saveChapters(updated);
                          } else if (!t) {
                            e.currentTarget.textContent = ch.title;
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
                          if (e.key === 'Escape') { e.currentTarget.textContent = ch.title; e.currentTarget.blur(); }
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.borderBottomColor = 'var(--line-2)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.borderBottomColor = 'transparent'; }}
                        style={{
                          fontSize: 17, color: 'var(--ink)', fontWeight: 500, letterSpacing: '-0.005em',
                          outline: 'none', cursor: 'text', display: 'inline-block',
                          borderBottom: '1px dashed transparent',
                        }}
                      >
                        {ch.title}
                      </div>
                      {!isOpen && (
                        <div style={{ marginTop: 6, fontSize: 13.5, color: 'var(--ink-2)', lineHeight: 1.55, maxWidth: '60ch' }}>
                          {ch.summary}
                        </div>
                      )}
                    </div>
                  </div>
                  {isOpen && (
                    <div style={{ paddingBottom: 18 }}>
                      {chSegs.map(({ seg, idx }) => {
                        const isCurrentMatch = matchIndex >= 0 && matches[matchIndex] === idx;
                        const isAnyMatch = search.trim() && matches.includes(idx);
                        return (
                        <div key={idx} ref={(el) => { segmentRefs.current[idx] = el; }} style={{
                          borderRadius: 'var(--radius)',
                          background: isCurrentMatch
                            ? 'var(--accent-wash)'
                            : isAnyMatch ? 'color-mix(in srgb, var(--accent) 6%, transparent)' : undefined,
                          transition: 'background 150ms',
                        }}>
                          <SpeakerRow
                            segment={seg}
                            index={idx}
                            onUpdate={handleSegmentUpdate}
                            onRenameAll={handleRenameAll}
                            speakerSegmentCount={speakerCounts[seg.speaker] ?? 1}
                            onSeek={audioUrl ? seekTo : undefined}
                            hasPii={piiSegmentIndices.has(idx)}
                            isHighlighted={highlightedSegment === idx}
                          />
                        </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}

            {!chaptersLoading && !chapters && (
              <div style={{ borderTop: '1px solid var(--line)' }}>
                {segments.length === 0 ? (
                  <p style={{ padding: '32px 0', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
                    Ingen transskription fundet.
                  </p>
                ) : (
                  displaySegments.map((seg, i) => (
                    <div key={i} ref={(el) => { segmentRefs.current[i] = el; }}>
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
            )}
          </div>
        </div>

        {/* ── Right sidebar ─────────────────────────────────────────── */}
        <div style={{
          borderLeft: isMobile ? 'none' : '1px solid var(--line)',
          borderTop: isMobile ? '1px solid var(--line)' : 'none',
          background: 'var(--bg-2)',
          padding: isMobile ? '24px 20px' : '32px 24px',
          position: isMobile ? 'static' : 'sticky', top: isMobile ? undefined : 103,
          height: isMobile ? 'auto' : 'calc(100vh - 56px - 47px - 56px)',
          overflow: isMobile ? 'visible' : 'auto',
          display: 'flex', flexDirection: 'column', gap: 0,
        }}>

          {/* Følsom info (PII checklist) */}
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', letterSpacing: 0.4 }}>følsom info</div>
          <div style={{ fontSize: 13, color: 'var(--ink-2)', marginTop: 6, lineHeight: 1.5 }}>
            {piiReplacements.length === 0
              ? 'Ingen personoplysninger fundet.'
              : <>Hviske har fundet <strong style={{ color: 'var(--ink)' }}>{piiReplacements.length} ting</strong>, der kan være personoplysninger.</>
            }
          </div>

          {piiReplacements.length > 0 && (
            <div style={{ marginTop: 18 }}>
              {piiReplacements.map((r, i) => (
                <div
                  key={i}
                  onClick={() => { if (r.segmentIndex !== undefined) jumpToSegment(r.segmentIndex); }}
                  role={r.segmentIndex !== undefined ? 'button' : undefined}
                  tabIndex={r.segmentIndex !== undefined ? 0 : undefined}
                  onKeyDown={(e) => {
                    if (r.segmentIndex === undefined) return;
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jumpToSegment(r.segmentIndex); }
                  }}
                  style={{
                    padding: '12px 0',
                    borderTop: i === 0 ? '1px solid var(--line-2)' : '1px solid var(--line)',
                    display: 'grid', gridTemplateColumns: '20px 1fr auto',
                    gap: 12, alignItems: 'flex-start', cursor: 'pointer',
                  }}
                >
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={checkedPii.has(i)}
                    aria-label={`Anonymisér "${r.original}"`}
                    onClick={(e) => { e.stopPropagation(); togglePiiItem(i); }}
                    style={{
                      width: 16, height: 16, borderRadius: 3, marginTop: 3, cursor: 'pointer', flexShrink: 0, padding: 0,
                      border: '1px solid ' + (checkedPii.has(i) ? 'var(--accent)' : 'var(--line-2)'),
                      background: checkedPii.has(i) ? 'var(--accent)' : 'var(--bg)',
                      color: '#fff', fontSize: 11, fontWeight: 600,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                  >{checkedPii.has(i) ? '✓' : ''}</button>
                  <div>
                    <div style={{
                      fontFamily: 'var(--mono)', fontSize: 13.5, color: 'var(--ink)',
                      textDecorationLine: checkedPii.has(i) ? 'line-through' : 'none',
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

          {/* Deltagere — editable list included in referat */}
          <div style={{ marginTop: 28 }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', letterSpacing: 0.4, marginBottom: 8 }}>deltagere</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {editableParticipants.map((name, i) => (
                <div key={i} style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-2)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 5, height: 5, borderRadius: 999, background: 'var(--muted-2)', flexShrink: 0, display: 'inline-block' }} />
                  <span style={{ flex: 1 }}>{name}</span>
                  <button
                    onClick={() => setEditableParticipants((prev) => prev.filter((_, j) => j !== i))}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted-2)', fontSize: 14, padding: '0 2px', lineHeight: 1 }}
                    title="Fjern deltager"
                  >×</button>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: editableParticipants.length > 0 ? 8 : 0 }}>
              <input
                value={newParticipantInput}
                onChange={(e) => setNewParticipantInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newParticipantInput.trim()) {
                    e.preventDefault();
                    setEditableParticipants((prev) => [...prev, newParticipantInput.trim()]);
                    setNewParticipantInput('');
                  }
                }}
                placeholder="tilføj deltager"
                style={{
                  flex: 1, fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--ink-2)',
                  background: 'transparent', border: 'none', outline: 'none',
                  borderBottom: '1px solid var(--line-2)', padding: '2px 0',
                }}
              />
              {newParticipantInput.trim() && (
                <button
                  onClick={() => {
                    setEditableParticipants((prev) => [...prev, newParticipantInput.trim()]);
                    setNewParticipantInput('');
                  }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)', fontSize: 11, fontFamily: 'var(--mono)', padding: 0 }}
                >+ tilføj</button>
              )}
            </div>
          </div>

          {/* Keywords / prompt */}
          <div style={{ marginTop: 28 }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', letterSpacing: 0.4, marginBottom: 10 }}>fokus</div>

            {/* Inactive keyword chips — above the textarea */}
            {['Standard', 'Beslutninger', 'Handlepunkter', 'Fuld detalje'].some((k) => !activeKeywords.has(k)) && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                {['Standard', 'Beslutninger', 'Handlepunkter', 'Fuld detalje']
                  .filter((k) => !activeKeywords.has(k))
                  .map((keyword) => (
                    <button
                      key={keyword}
                      onClick={() => setActiveKeywords((prev) => { const n = new Set(prev); n.add(keyword); return n; })}
                      style={{
                        padding: '4px 10px',
                        border: '1px solid var(--line)',
                        borderRadius: 999,
                        background: 'transparent',
                        fontFamily: 'var(--mono)', fontSize: 11.5,
                        color: 'var(--ink-2)',
                        cursor: 'pointer',
                        transition: 'border-color 120ms, color 120ms',
                      }}
                    >
                      {keyword}
                    </button>
                  ))}
              </div>
            )}

            {/* Textarea with active keywords inside */}
            <div style={{
              border: '1px solid var(--line-2)',
              borderRadius: 'var(--radius)',
              background: 'var(--bg)',
            }}>
              {activeKeywords.size > 0 && (
                <div style={{
                  padding: '8px 10px', display: 'flex', flexWrap: 'wrap', gap: 6,
                  borderBottom: '1px solid var(--line)',
                }}>
                  {['Standard', 'Beslutninger', 'Handlepunkter', 'Fuld detalje']
                    .filter((k) => activeKeywords.has(k))
                    .map((keyword) => (
                      <button
                        key={keyword}
                        onClick={() => setActiveKeywords((prev) => { const n = new Set(prev); n.delete(keyword); return n; })}
                        style={{
                          padding: '3px 8px',
                          border: '1px solid var(--accent)',
                          borderRadius: 999,
                          background: 'var(--accent-wash)',
                          fontFamily: 'var(--mono)', fontSize: 11.5,
                          color: 'var(--accent)',
                          cursor: 'pointer',
                          display: 'flex', alignItems: 'center', gap: 5,
                        }}
                      >
                        {keyword}
                        <span style={{ fontSize: 13, lineHeight: 1, opacity: 0.7 }}>×</span>
                      </button>
                    ))}
                </div>
              )}
              <textarea
                value={customText}
                onChange={(e) => setCustomText(e.target.value)}
                placeholder={activeKeywords.size === 0 ? 'Beskriv referatet…' : 'Tilføj instruktioner…'}
                rows={2}
                style={{
                  width: '100%', minHeight: 60,
                  fontFamily: 'var(--mono)', fontSize: 11.5,
                  color: 'var(--ink)', lineHeight: 1.6,
                  background: 'transparent', border: 'none',
                  padding: '8px 10px',
                  resize: 'vertical', outline: 'none',
                  display: 'block',
                }}
              />
            </div>
          </div>

          {/* Compliance */}
          <div style={{
            marginTop: 24, padding: '14px 16px', borderRadius: 'var(--radius)',
            border: audioDeleted
              ? '1px solid color-mix(in oklch, var(--accent) 25%, var(--line-2))'
              : '1px solid color-mix(in oklch, var(--kill) 25%, var(--line-2))',
            background: audioDeleted ? 'var(--accent-wash)' : 'var(--kill-wash)',
          }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: audioDeleted ? 'var(--accent)' : 'var(--kill)', letterSpacing: 0.3, marginBottom: 6 }}>
              § compliance · automatisk
            </div>
            <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.6 }}>
              {audioDeleted
                ? 'Lydfilen er slettet. Referatet genereres fra transkription og dine redigeringer.'
                : 'Lydfilen slettes automatisk når referatet genereres.'}
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
            transkription kan stadig redigeres efter
          </div>
        </div>
      </div>

      {/* Sticky bottom player */}
      <div style={{
        position: 'sticky', bottom: 0,
        height: 56, borderTop: '1px solid var(--line)',
        background: 'var(--surface)',
        display: 'flex', alignItems: 'center', gap: isMobile ? 10 : 16,
        padding: isMobile ? '0 16px' : '0 32px', zIndex: 5,
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
              style={{ flex: 1, height: 20, display: 'flex', alignItems: 'center', cursor: 'pointer', position: 'relative' }}
              onMouseDown={(e) => {
                const bar = e.currentTarget;
                const seek = (clientX: number) => {
                  if (duration <= 0) return;
                  const rect = bar.getBoundingClientRect();
                  const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
                  seekTo(pct * duration);
                };
                seek(e.clientX);
                const onMove = (ev: MouseEvent) => seek(ev.clientX);
                const onUp = () => {
                  window.removeEventListener('mousemove', onMove);
                  window.removeEventListener('mouseup', onUp);
                };
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onUp);
              }}
            >
              <div style={{ position: 'absolute', left: 0, right: 0, height: 3, background: 'var(--line-2)', borderRadius: 2 }}>
                <div style={{
                  position: 'absolute', left: 0, top: 0, height: '100%',
                  width: duration > 0 ? `${(currentTime / duration) * 100}%` : '0%',
                  background: 'var(--ink-2)', borderRadius: 2,
                }} />
                {/* Open chapter highlights — rendered on top of progress fill */}
                {duration > 0 && chapters?.filter((ch) => openChapters.has(ch.id)).map((ch) => (
                  <div key={ch.id} style={{
                    position: 'absolute', top: 0, height: '100%',
                    left: `${(ch.startTime / duration) * 100}%`,
                    width: `${((ch.endTime - ch.startTime) / duration) * 100}%`,
                    background: 'var(--accent)', borderRadius: 2,
                  }}>
                    <div style={{
                      position: 'absolute', left: 0, top: '50%', transform: 'translate(-50%, -50%)',
                      width: 2, height: 10, background: 'var(--accent)', borderRadius: 1,
                    }} />
                    <div style={{
                      position: 'absolute', right: 0, top: '50%', transform: 'translate(50%, -50%)',
                      width: 2, height: 10, background: 'var(--accent)', borderRadius: 1,
                    }} />
                  </div>
                ))}
                {duration > 0 && (
                  <div style={{
                    position: 'absolute', top: '50%', transform: 'translate(-50%, -50%)',
                    left: `${(currentTime / duration) * 100}%`,
                    width: 10, height: 10, borderRadius: 999,
                    background: 'var(--ink)', border: '2px solid var(--surface)',
                    boxShadow: '0 0 0 1px var(--ink-2)',
                  }} />
                )}
              </div>
            </div>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
              {duration > 0
                ? `${Math.floor(duration / 60).toString().padStart(2, '0')}:${Math.floor(duration % 60).toString().padStart(2, '0')}`
                : '--:--'}
            </span>
          </>
        ) : audioDeleted ? (
          <span style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--accent)' }}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
              <path d="M2 4h12M5 4V2.5A.5.5 0 015.5 2h5a.5.5 0 01.5.5V4M6 7v5M10 7v5M3 4l.8 9.1A.5.5 0 004.3 13.6h7.4a.5.5 0 00.5-.5L13 4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            lydfil slettet
          </span>
        ) : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted-2)' }}>
            ingen lydfil
          </span>
        )}
      </div>
    </div>
  );
}
