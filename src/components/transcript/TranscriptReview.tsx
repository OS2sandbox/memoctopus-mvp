'use client';

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { TranscriptSegment, PiiReplacement } from '@/types';
import { SpeakerRow } from './SpeakerRow';
import { SpeakerAssignment, type ParticipantRow } from './SpeakerAssignment';
import { WaveformPlayer } from './WaveformPlayer';
import { getTranscript, getAudio, saveTranscriptChapters, saveTranscriptSegments, saveMinutes, deleteAudio, updateMeeting, getMeeting } from '@/lib/storage';
import { onTranscriptUpdated } from '@/lib/transcript-events';
import { isDiarizationInFlight, ensureDiarization, finishDiarization } from '@/lib/audio/diarize-client';
import { isDefaultSpeakerLabel, nextAvailableSpeakerLabel } from '@/lib/audio/speaker-labels';
import type { MinutesContent, Skabelon } from '@/types';
import { useIsMobile } from '@/lib/use-is-mobile';
import { formatDate } from '@/lib/utils';

interface TranscriptReviewProps {
  meetingId: string;
  initialSegments: TranscriptSegment[];
  piiReplacements: PiiReplacement[];
  audioUrl?: string;
  audioDurationSeconds?: number | null;
  audioDeleted?: boolean;
  initialChapters?: TranscriptChapter[];
  participants?: string[];
  initialDiarizing?: boolean;
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

// Participant names are matched case-insensitively. Returns the existing roster
// entry (in its canonical casing) that matches `name`, or undefined.
function findExistingName(names: string[], name: string): string | undefined {
  const lower = name.toLowerCase();
  return names.find((p) => p.toLowerCase() === lower);
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

// The category toggles seeded from a Skabelon's include* flags. No skabelon
// (undefined) is a blank template with every category off.
function skabelonToCats(s?: Skabelon | null) {
  return {
    deltagere: s?.includeDeltagere ?? false,
    beslutningspunkter: s?.includeBeslutningspunkter ?? false,
    dagsorden: s?.includeDagsorden ?? false,
    dato: s?.includeDato ?? false,
  };
}

// Styled skabelon picker — a native <select> can't be themed or show the
// favorite heart, so this mirrors the app's surface/line/accent tokens, marks
// the current choice, and flags the user's default with a small blue heart.
function SkabelonSelect({
  skabeloner,
  value,
  onChange,
}: {
  skabeloner: Skabelon[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selectedName = skabeloner.find((s) => s.id === value)?.name ?? 'Ingen skabelon';
  const options = [{ id: '', name: 'Ingen skabelon', isDefault: false }, ...skabeloner];

  return (
    <div ref={ref} style={{ position: 'relative', marginBottom: 14 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          width: '100%', padding: '8px 10px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          border: '1px solid ' + (open ? 'var(--accent)' : 'var(--line-2)'),
          borderRadius: 'var(--radius)', background: 'var(--bg)', color: 'var(--ink)',
          fontSize: 13, cursor: 'pointer', textAlign: 'left', transition: 'border-color 120ms',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selectedName}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" style={{ flexShrink: 0, color: 'var(--muted)', transition: 'transform 0.15s', transform: open ? 'rotate(180deg)' : undefined }}>
          <path d="M1 3l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          role="listbox"
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0,
            background: 'var(--surface)', border: '1px solid var(--line)',
            borderRadius: 'var(--radius)', boxShadow: '0 8px 28px rgba(0,0,0,0.10)',
            zIndex: 50, overflow: 'hidden', padding: 4,
          }}
        >
          {options.map((opt) => {
            const isSel = opt.id === value;
            return (
              <button
                key={opt.id || '__none__'}
                type="button"
                role="option"
                aria-selected={isSel}
                onClick={() => { onChange(opt.id); setOpen(false); }}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                  padding: '7px 9px', borderRadius: 'calc(var(--radius) - 2px)',
                  border: 'none', cursor: 'pointer', textAlign: 'left', fontSize: 13,
                  background: isSel ? 'var(--accent-wash)' : 'transparent',
                  color: isSel ? 'var(--accent)' : 'var(--ink)',
                }}
                onMouseEnter={(e) => { if (!isSel) e.currentTarget.style.background = 'var(--bg-2)'; }}
                onMouseLeave={(e) => { if (!isSel) e.currentTarget.style.background = 'transparent'; }}
              >
                <span style={{ width: 14, flexShrink: 0, display: 'inline-flex', justifyContent: 'center', color: 'var(--accent)' }}>
                  {isSel && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                  )}
                </span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{opt.name}</span>
                {opt.isDefault && (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="var(--accent)" stroke="none" style={{ flexShrink: 0 }} aria-label="standard">
                    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
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
  initialDiarizing = false,
  onDataChange,
}: TranscriptReviewProps) {
  const isMobile = useIsMobile();
  const [segments, setSegments] = useState(initialSegments);
  // Latest segments + a debounce timer for autosaving transcript text edits.
  // Held in refs so the debounced save and the leave handler see the freshest text.
  const segmentsRef = useRef(segments);
  const segSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { segmentsRef.current = segments; }, [segments]);
  // Speaker diarization is still running when true: the review screen shows an
  // uncertainty state for speaker labels instead of the placeholder 'Taler 1'.
  const [diarizing, setDiarizing] = useState(initialDiarizing);
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
  // Latest roster, readable from callbacks without making them depend on it — so
  // assignSpeaker stays stable across participant edits and doesn't re-render every
  // memoized SpeakerRow when a participant is added.
  const participantsRef = useRef(editableParticipants);
  participantsRef.current = editableParticipants;
  // Participants confirmed to have *not* spoken ("talte ikke"). UI-only — these
  // people stay in editableParticipants and flow to the referat unchanged; the set
  // just distinguishes a deliberate "silent" person from one still awaiting a voice.
  const [silent, setSilent] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set();
    try {
      const saved = sessionStorage.getItem(`silent-${meetingId}`);
      if (saved) return new Set(JSON.parse(saved) as string[]);
    } catch { /* ignore */ }
    return new Set();
  });

  useEffect(() => {
    try { sessionStorage.setItem(`participants-${meetingId}`, JSON.stringify(editableParticipants)); } catch { /* ignore */ }
    // Persist to IndexedDB too so participants added while assigning speakers
    // survive a reload (sessionStorage alone is cleared with the tab).
    updateMeeting(meetingId, { participants: editableParticipants }).catch(() => {});
  }, [editableParticipants, meetingId]);

  useEffect(() => {
    try { sessionStorage.setItem(`silent-${meetingId}`, JSON.stringify([...silent])); } catch { /* ignore */ }
  }, [silent, meetingId]);

  // Refresh segments when a background task patches the transcript — e.g. speaker
  // diarization landing after the recording already navigated here. Pulls the fresh
  // segments from storage so the speaker labels update in place. The mount re-read
  // also catches a patch that landed in the brief gap before this subscribed.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const fresh = await getTranscript(meetingId);
      if (cancelled || !fresh) return;
      // Don't overwrite local text edits that haven't been autosaved yet — the
      // user's in-progress edit wins over a background diarization patch.
      if (fresh.segments?.length && !segSaveTimer.current) setSegments(fresh.segments);
      setDiarizing(fresh.diarizationStatus === 'pending');
    };
    const init = async () => {
      const fresh = await getTranscript(meetingId);
      if (cancelled || !fresh) return;
      if (fresh.segments?.length) setSegments(fresh.segments);
      setDiarizing(fresh.diarizationStatus === 'pending');
      // Safety net: the transcript is still 'pending' but nothing is diarizing it
      // in this session — the tab was reloaded mid-pass, so the original background
      // request died. Re-run it from the stored audio so labels don't hang in the
      // uncertainty state. If the audio is gone, just clear the pending state.
      if (fresh.diarizationStatus === 'pending' && !isDiarizationInFlight(meetingId)) {
        const audio = await getAudio(meetingId);
        if (cancelled) return;
        if (audio?.blob) void ensureDiarization(meetingId, audio.blob);
        else void finishDiarization(meetingId, []);
      }
    };
    void init();
    const off = onTranscriptUpdated(meetingId, () => { void refresh(); });
    return () => { cancelled = true; off(); };
  }, [meetingId]);
  // Skabelon-driven generation: the chosen prompt + the three optional category
  // injections (Deltagere / Beslutningspunkter / Dagsorden), seeded from the
  // selected Skabelon but overridable here in gennemgang.
  const [skabeloner, setSkabeloner] = useState<Skabelon[]>([]);
  const [selectedSkabelonId, setSelectedSkabelonId] = useState<string>('');
  // The skabelon list loads async (and can arrive late while transcription
  // saturates the connection pool). Once the user picks a skabelon themselves,
  // don't let that late default-selection overwrite their choice.
  const skabelonTouchedRef = useRef(false);
  const [cats, setCats] = useState(() => skabelonToCats());
  const [customText, setCustomText] = useState('');

  // "Gem prompt som skabelon": persist the current prompt + category selection as
  // a reusable Skabelon — either folding it into the selected one (Opdater) or
  // forking a brand-new one.
  const [savingTemplate, setSavingTemplate] = useState(false);
  // Which step the cycleable save form is on: fold into the selected skabelon, or
  // fork a brand-new one. Only the 'new' step exists when no skabelon is selected.
  const [templateMode, setTemplateMode] = useState<'update' | 'new'>('new');
  const [templateName, setTemplateName] = useState('');
  const [templateSaving, setTemplateSaving] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  // After a save/update the instruction box is cleared (its text moved into the
  // skabelon); this becomes the box's placeholder to explain where it went.
  const [savedHint, setSavedHint] = useState<string | null>(null);

  const selectedSkabelon = skabeloner.find((s) => s.id === selectedSkabelonId) ?? null;
  // The actual step to render: 'update' is only valid while a skabelon is
  // selected, so deselecting it mid-form falls back to 'new'.
  const templateStep = selectedSkabelon ? templateMode : 'new';

  // The effective prompt = the selected skabelon's saved prompt plus the ad-hoc
  // instructions typed below it, mirroring how generation combines the two.
  function effectivePrompt(): string {
    return [selectedSkabelon?.prompt.trim() ?? '', customText.trim()].filter(Boolean).join('\n\n');
  }

  const templatePayload = () => ({
    prompt: effectivePrompt(),
    includeDeltagere: cats.deltagere,
    includeBeslutningspunkter: cats.beslutningspunkter,
    includeDagsorden: cats.dagsorden,
    includeDato: cats.dato,
  });

  function openTemplateForm() {
    setSavingTemplate(true);
    setTemplateError(null);
    // Default to updating the selected skabelon; with none selected only the
    // 'new' step is reachable.
    setTemplateMode(selectedSkabelon ? 'update' : 'new');
  }

  function closeTemplateForm() {
    setSavingTemplate(false);
    setTemplateName('');
    setTemplateError(null);
  }

  // Persist the current prompt + categories — either folding them into the
  // selected skabelon ('update') or forking a brand-new one ('new').
  async function saveTemplate(mode: 'update' | 'new') {
    setTemplateError(null);
    let req: { url: string; method: string; body: Record<string, unknown> };
    if (mode === 'update') {
      if (!selectedSkabelon) return;
      req = {
        url: `/api/skabeloner/${selectedSkabelon.id}`,
        method: 'PUT',
        body: { name: selectedSkabelon.name, description: selectedSkabelon.description, ...templatePayload() },
      };
    } else {
      const name = templateName.trim();
      if (!name) { setTemplateError('Navn er påkrævet'); return; }
      req = { url: '/api/skabeloner', method: 'POST', body: { name, ...templatePayload() } };
    }

    setTemplateSaving(true);
    try {
      const res = await fetch(req.url, {
        method: req.method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? (mode === 'update' ? 'Kunne ikke opdatere skabelon' : 'Kunne ikke gemme skabelon'));
      }
      const { skabelon } = (await res.json()) as { skabelon: Skabelon };
      if (mode === 'update') {
        setSkabeloner((prev) => prev.map((s) => (s.id === skabelon.id ? skabelon : s)));
      } else {
        setSkabeloner((prev) => [...prev, skabelon]);
        setSelectedSkabelonId(skabelon.id);
      }
      // The extra text is now baked into the skabelon's prompt — clear it so
      // generation doesn't apply it twice, and explain the disappearance.
      setCustomText('');
      setSavedHint(mode === 'update'
        ? 'Skabelon opdateret, er der andet du vil tilføje?'
        : 'Skabelon gemt, er der andet du vil tilføje?');
      closeTemplateForm();
    } catch (err) {
      setTemplateError(err instanceof Error ? err.message : 'Noget gik galt');
    } finally {
      setTemplateSaving(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    fetch('/api/skabeloner')
      .then((r) => (r.ok ? r.json() : { skabeloner: [] }))
      .then((data: { skabeloner: Skabelon[] }) => {
        if (cancelled) return;
        const list = data.skabeloner ?? [];
        setSkabeloner(list);
        const def = list.find((s) => s.isDefault) ?? list[0];
        if (def && !skabelonTouchedRef.current) {
          setSelectedSkabelonId(def.id);
          setCats(skabelonToCats(def));
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  function selectSkabelon(id: string) {
    skabelonTouchedRef.current = true;
    setSelectedSkabelonId(id);
    setSavedHint(null);
    const s = skabeloner.find((x) => x.id === id);
    // "Ingen skabelon" (empty id) is a blank template: clear every category.
    setCats(skabelonToCats(s));
  }

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
  // When set, playback auto-pauses at this time — used to play a single speaker
  // soundbite (the inline assign prompt) rather than running to the end.
  const stopAtRef = useRef<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  // The soundbite (start/end) currently playing as a bounded preview, or null.
  // Lets the matcher render a pause icon on the active soundbite button, so the
  // same control that starts a preview can also stop it.
  const [playingBite, setPlayingBite] = useState<{ start: number; end: number } | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(audioDurationSeconds ?? 0);
  const [audioError, setAudioError] = useState<string | null>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => {
      setCurrentTime(audio.currentTime);
      if (stopAtRef.current !== null && audio.currentTime >= stopAtRef.current) {
        audio.pause();
        stopAtRef.current = null;
      }
    };
    const onMeta = () => {
      if (isFinite(audio.duration) && audio.duration > 0) setDuration(audio.duration);
    };
    const onDurationChange = () => {
      if (isFinite(audio.duration) && audio.duration > 0) setDuration(audio.duration);
    };
    const onPlay = () => setIsPlaying(true);
    const onPause = () => { setIsPlaying(false); setPlayingBite(null); };
    const onEnded = () => { setIsPlaying(false); setPlayingBite(null); };
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
    stopAtRef.current = null; // a manual seek isn't a bounded soundbite
    setPlayingBite(null);
    audio.currentTime = time;
    setCurrentTime(time);
    audio.play().catch(() => setAudioError('Afspilning fejlede'));
  }, []);

  // Play just one speaker's soundbite, auto-pausing at its end.
  const playSegment = useCallback((start: number, end: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    stopAtRef.current = end;
    audio.currentTime = start;
    setCurrentTime(start);
    setPlayingBite({ start, end });
    audio.play().catch(() => setAudioError('Afspilning fejlede'));
  }, []);

  // Play a soundbite, or pause it if it's the one already playing — so the same
  // button both starts and stops the preview.
  const togglePlaySegment = useCallback((start: number, end: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying && playingBite && playingBite.start === start && playingBite.end === end) {
      audio.pause();
    } else {
      playSegment(start, end);
    }
  }, [isPlaying, playingBite, playSegment]);

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio) return;
    stopAtRef.current = null; // manual play/pause clears any soundbite bound
    setPlayingBite(null);
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

  // Persist the current (edited) transcript to storage. Used by the debounced
  // autosave below and flushed on leave so text edits survive reloads/navigation.
  const persistSegments = useCallback(async () => {
    if (segSaveTimer.current) { clearTimeout(segSaveTimer.current); segSaveTimer.current = null; }
    try { await saveTranscriptSegments(meetingId, segmentsRef.current); } catch { /* ignore */ }
  }, [meetingId]);

  const handleSegmentUpdate = useCallback((index: number, updated: TranscriptSegment) => {
    setSegments((prev) => prev.map((s, i) => (i === index ? updated : s)));
    // Autosave the text edit (debounced — the textarea fires per keystroke).
    if (segSaveTimer.current) clearTimeout(segSaveTimer.current);
    segSaveTimer.current = setTimeout(() => void persistSegments(), 800);
  }, [persistSegments]);

  // Flush any pending transcript edit when leaving so nothing is lost.
  useEffect(() => () => { void persistSegments(); }, [persistSegments]);

  // Drop a name from the "talte ikke" set (no-op if absent). Stable — shared by the
  // assign/unlink/remove handlers.
  const deleteFromSilent = useCallback((name: string) => {
    setSilent((prev) => {
      if (!prev.has(name)) return prev;
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
  }, []);

  // Connect a diarized voice to a participant — the single write path behind the
  // matcher panel and the transcript-row picker (the prototype's `linkVoice`). The
  // name is added to the roster if new (reusing an existing participant's canonical
  // casing so the label and the roster stay byte-identical), un-silenced, and every
  // segment of `from` is relabelled to that name and persisted.
  const assignSpeaker = useCallback(
    async (from: string, to: string) => {
      const trimmed = to.trim();
      if (!trimmed || trimmed === from) return;
      const existing = findExistingName(participantsRef.current, trimmed);
      const finalName = existing ?? trimmed;
      if (!existing && !isDefaultSpeakerLabel(finalName)) {
        setEditableParticipants((prev) => [...prev, finalName]);
      }
      deleteFromSilent(finalName);
      const updated = segments.map((seg) => (seg.speaker === from ? { ...seg, speaker: finalName } : seg));
      setSegments(updated);
      try {
        await saveTranscriptSegments(meetingId, updated);
      } catch (err) {
        console.error('[speakers] assign persist failed:', err);
      }
    },
    [meetingId, segments, deleteFromSilent],
  );

  // Unlink a recognized person: relabel all their segments back to a fresh, unused
  // 'Taler N' so the voice returns to the unmatched pool. The person stays in the
  // roster as pending.
  const unlinkSpeaker = useCallback(
    async (name: string) => {
      const fresh = nextAvailableSpeakerLabel(new Set(segments.map((s) => s.speaker)));
      const updated = segments.map((seg) => (seg.speaker === name ? { ...seg, speaker: fresh } : seg));
      setSegments(updated);
      deleteFromSilent(name);
      try {
        await saveTranscriptSegments(meetingId, updated);
      } catch (err) {
        console.error('[speakers] unlink persist failed:', err);
      }
    },
    [meetingId, segments, deleteFromSilent],
  );

  const markSilent = useCallback((name: string) => {
    setSilent((prev) => new Set(prev).add(name));
  }, []);

  // Rename a participant in place — works whether they're pending, silent, or
  // already linked to a voice. If they have a voice, the relabel carries through
  // to every segment so the transcript stays in sync. A rename onto a name that
  // already exists (case-insensitively, different person) merges by dropping the
  // old entry.
  const renameParticipant = useCallback(
    async (oldName: string, newName: string) => {
      const trimmed = newName.trim();
      if (!trimmed || trimmed === oldName) return;
      setEditableParticipants((prev) => {
        const existing = findExistingName(prev, trimmed);
        if (existing && existing !== oldName) return prev.filter((p) => p !== oldName);
        return prev.map((p) => (p === oldName ? trimmed : p));
      });
      setSilent((prev) => {
        if (!prev.has(oldName)) return prev;
        const next = new Set(prev);
        next.delete(oldName);
        next.add(trimmed);
        return next;
      });
      if (segments.some((s) => s.speaker === oldName)) {
        const updated = segments.map((seg) => (seg.speaker === oldName ? { ...seg, speaker: trimmed } : seg));
        setSegments(updated);
        try {
          await saveTranscriptSegments(meetingId, updated);
        } catch (err) {
          console.error('[speakers] rename persist failed:', err);
        }
      }
    },
    [meetingId, segments],
  );

  // Remove a participant entirely. If a voice was linked to them, return it to the
  // unmatched pool (a fresh 'Taler N') rather than leaving segments tagged with a
  // person who's no longer in the roster.
  const removeParticipant = useCallback(
    async (name: string) => {
      if (segments.some((s) => s.speaker === name)) {
        const fresh = nextAvailableSpeakerLabel(new Set(segments.map((s) => s.speaker)));
        const updated = segments.map((seg) => (seg.speaker === name ? { ...seg, speaker: fresh } : seg));
        setSegments(updated);
        try {
          await saveTranscriptSegments(meetingId, updated);
        } catch (err) {
          console.error('[speakers] remove persist failed:', err);
        }
      }
      setEditableParticipants((prev) => prev.filter((p) => p !== name));
      deleteFromSilent(name);
    },
    [meetingId, segments, deleteFromSilent],
  );

  // A freshly added participant joins the roster as "talte ikke" (silent) until a
  // voice is linked — mirrors the prototype's add-as-noVoice behaviour.
  const addParticipant = useCallback((name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setEditableParticipants((prev) =>
      findExistingName(prev, trimmed) ? prev : [...prev, trimmed],
    );
    setSilent((prev) => new Set(prev).add(trimmed));
  }, []);

  // Still-unassigned speakers ("Taler N"), ordered by first appearance, each with
  // its longest ("most representative") segment for the soundbite. Feeds the guided
  // assignment tool docked next to the participant list.
  const unassignedSpeakers = useMemo(() => {
    const firstIndex = new Map<string, number>();
    const rep = new Map<string, { start: number; end: number; dur: number }>();
    segments.forEach((seg, i) => {
      if (!isDefaultSpeakerLabel(seg.speaker)) return;
      if (!firstIndex.has(seg.speaker)) firstIndex.set(seg.speaker, i);
      const dur = seg.end - seg.start;
      const cur = rep.get(seg.speaker);
      if (!cur || dur > cur.dur) rep.set(seg.speaker, { start: seg.start, end: seg.end, dur });
    });
    return [...firstIndex.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([speaker]) => ({ speaker, start: rep.get(speaker)!.start, end: rep.get(speaker)!.end }));
  }, [segments]);

  // Distinct speaker labels currently in the transcript, and each label's longest
  // segment (for the recognized-row replay button).
  const speakerStats = useMemo(() => {
    const distinct = new Set<string>();
    const longest = new Map<string, { start: number; end: number; dur: number }>();
    segments.forEach((seg) => {
      distinct.add(seg.speaker);
      const dur = seg.end - seg.start;
      const cur = longest.get(seg.speaker);
      if (!cur || dur > cur.dur) longest.set(seg.speaker, { start: seg.start, end: seg.end, dur });
    });
    return { distinct, longest };
  }, [segments]);

  // One row per participant, classified for the matcher panel: a name that is a
  // segment speaker is "recognized" (a voice is linked); otherwise it's "silent" if
  // the user marked it so, else "pending".
  const participantRows = useMemo<ParticipantRow[]>(
    () => editableParticipants.map((name) => {
      if (speakerStats.distinct.has(name)) {
        const rep = speakerStats.longest.get(name);
        return { name, kind: 'recognized', start: rep?.start, end: rep?.end };
      }
      return { name, kind: silent.has(name) ? 'silent' : 'pending' };
    }),
    [editableParticipants, speakerStats, silent],
  );

  // Participants with no voice yet — the candidates offered when naming a leftover
  // voice and in the transcript-row picker (so a name never appears in two places).
  const voicelessParticipants = useMemo(
    () => editableParticipants.filter((p) => !speakerStats.distinct.has(p)),
    [editableParticipants, speakerStats],
  );

  // Header counter: recognized = distinct non-placeholder labels; total = those plus
  // the still-unmatched voices.
  const recognizedVoiceCount = useMemo(
    () => [...speakerStats.distinct].filter((s) => !isDefaultSpeakerLabel(s)).length,
    [speakerStats],
  );
  const totalVoices = recognizedVoiceCount + unassignedSpeakers.length;

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
      // The recording date — used when the "Dato" category is enabled. Prefer the
      // audio's own date (recordedAt); fall back to createdAt for legacy meetings.
      const meeting = await getMeeting(meetingId);
      const meetingDate = meeting?.recordedAt ?? meeting?.createdAt;
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
            // Send the literal selection — '' ("Ingen skabelon") must reach the
            // server as an explicit "no skabelon", not collapse to the default.
            skabelonId: selectedSkabelonId,
            includeDeltagere: cats.deltagere,
            includeBeslutningspunkter: cats.beslutningspunkter,
            includeDagsorden: cats.dagsorden,
            includeDato: cats.dato,
            meetingDate: meetingDate ?? undefined,
            customPrompt: customText.trim() || undefined,
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
      const data = await res.json() as { content: MinutesContent; skabelonId?: string | null };
      // Build the editable document header: the title always, the date only when
      // the "Dato" tag is on (otherwise it would appear both here and in the body).
      const content: MinutesContent = {
        ...data.content,
        header: {
          title: meeting?.title ?? 'Referat',
          date: cats.dato && meetingDate ? formatDate(meetingDate) : null,
        },
      };
      await saveMinutes(meetingId, content, data.skabelonId ?? null);
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
                            onAssign={assignSpeaker}
                            speakerSegmentCount={speakerCounts[seg.speaker] ?? 1}
                            participants={voicelessParticipants}
                            onSeek={audioUrl ? seekTo : undefined}
                            hasPii={piiSegmentIndices.has(idx)}
                            isHighlighted={highlightedSegment === idx}
                            diarizing={diarizing}
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
                        onAssign={assignSpeaker}
                        speakerSegmentCount={speakerCounts[seg.speaker] ?? 1}
                        participants={voicelessParticipants}
                        onSeek={audioUrl ? seekTo : undefined}
                        hasPii={piiSegmentIndices.has(i)}
                        isHighlighted={highlightedSegment === i}
                        diarizing={diarizing}
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

          {/* Talere & deltagere — one participant-first list that connects each
              diarized voice to a person. While diarization is still running the
              matcher shows a recognising state but keeps the roster editable. */}
          <div style={{ marginTop: 28 }}>
            <SpeakerAssignment
              rows={participantRows}
              voices={unassignedSpeakers}
              voicelessParticipants={voicelessParticipants}
              recognizedCount={recognizedVoiceCount}
              totalVoices={totalVoices}
              diarizing={diarizing}
              onLink={assignSpeaker}
              onMarkSilent={markSilent}
              onUnlink={unlinkSpeaker}
              onRemove={removeParticipant}
              onRename={renameParticipant}
              onAdd={addParticipant}
              onPlaySegment={audioUrl ? togglePlaySegment : undefined}
              playingSegment={playingBite}
            />
          </div>

          {/* Skabelon, kategorier & ekstra instruktioner */}
          <div style={{ marginTop: 28 }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', letterSpacing: 0.4, marginBottom: 10 }}>skabelon</div>

            {/* Skabelon selector */}
            <SkabelonSelect
              skabeloner={skabeloner}
              value={selectedSkabelonId}
              onChange={selectSkabelon}
            />

            {/* Optional category injections */}
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', letterSpacing: 0.4, marginBottom: 8 }}>kategorier</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
              {([
                ['deltagere', 'Deltagere'],
                ['beslutningspunkter', 'Beslutningspunkter'],
                ['dagsorden', 'Dagsorden'],
                ['dato', 'Dato'],
              ] as const).map(([key, label]) => {
                const active = cats[key];
                return (
                  <button
                    key={key}
                    onClick={() => {
                      // Mark as touched so a late-arriving default skabelon fetch
                      // doesn't overwrite the user's manual category choices.
                      skabelonTouchedRef.current = true;
                      setCats((prev) => ({ ...prev, [key]: !prev[key] }));
                    }}
                    style={{
                      padding: '4px 10px',
                      border: '1px solid ' + (active ? 'var(--accent)' : 'var(--line)'),
                      borderRadius: 999,
                      background: active ? 'var(--accent-wash)' : 'transparent',
                      fontFamily: 'var(--mono)', fontSize: 11.5,
                      color: active ? 'var(--accent)' : 'var(--ink-2)',
                      cursor: 'pointer',
                      display: 'flex', alignItems: 'center', gap: 5,
                      transition: 'border-color 120ms, color 120ms',
                    }}
                  >
                    {label}
                    {active && <span style={{ fontSize: 13, lineHeight: 1, opacity: 0.7 }}>×</span>}
                  </button>
                );
              })}
            </div>

            {/* Extra ad-hoc instructions */}
            <div style={{
              border: '1px solid var(--line-2)',
              borderRadius: 'var(--radius)',
              background: 'var(--bg)',
            }}>
              <textarea
                value={customText}
                onChange={(e) => { setCustomText(e.target.value); if (savedHint) setSavedHint(null); }}
                placeholder={savedHint ?? 'Tilføj instruktioner…'}
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

            {/* Gem prompt som skabelon — one cycleable step (opdater / ny) */}
            <div style={{ marginTop: 10 }}>
              {!savingTemplate ? (
                <button
                  onClick={openTemplateForm}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5,
                    background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                    fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--accent)',
                  }}
                >
                  Gem som skabelon →
                </button>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {/* Mode selector — make it explicit whether you're adding to the
                      selected skabelon or creating a new one */}
                  {selectedSkabelon ? (
                    <>
                      {/* Common track pill makes the two options read as one
                          either/or toggle, spanning the full width. A sliding thumb
                          (exactly one half-slot wide) glides between the two slots. */}
                      <div style={{
                        position: 'relative', display: 'flex', padding: 3,
                        border: '1px solid var(--line)', borderRadius: 999, background: 'var(--surface)',
                      }}>
                        <div
                          aria-hidden
                          style={{
                            position: 'absolute', top: 3, bottom: 3, left: 3,
                            width: 'calc((100% - 6px) / 2)', borderRadius: 999,
                            background: 'var(--accent-wash)', border: '1px solid var(--accent)',
                            transform: templateStep === 'new' ? 'translateX(100%)' : 'translateX(0)',
                            transition: 'transform 200ms cubic-bezier(.4,.7,.2,1)',
                            pointerEvents: 'none',
                          }}
                        />
                        {([
                          ['update', 'Føj til skabelon'],
                          ['new', 'Ny skabelon'],
                        ] as const).map(([mode, label]) => {
                          const on = templateStep === mode;
                          return (
                            <button
                              key={mode}
                              onClick={() => { setTemplateMode(mode); setTemplateError(null); }}
                              disabled={templateSaving}
                              style={{
                                position: 'relative', zIndex: 1,
                                flex: 1, padding: '5px 12px', textAlign: 'center',
                                border: 'none', background: 'transparent', borderRadius: 999,
                                cursor: templateSaving ? 'not-allowed' : 'pointer',
                                fontFamily: 'var(--mono)', fontSize: 11.5,
                                color: on ? 'var(--accent)' : 'var(--ink-2)',
                                transition: 'color 160ms',
                              }}
                            >
                              {label}
                            </button>
                          );
                        })}
                      </div>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                        {templateStep === 'update'
                          ? `Forlæng skabelonen ${selectedSkabelon.name} med dine instruktioner`
                          : 'Opret en ny skabelon ud fra instruktionerne.'}
                      </span>
                    </>
                  ) : (
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                      Opret en ny skabelon ud fra instruktionerne.
                    </span>
                  )}

                  {/* New skabelon needs a name */}
                  {templateStep === 'new' && (
                    <input
                      value={templateName}
                      onChange={(e) => setTemplateName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') void saveTemplate('new'); }}
                      placeholder="Navn på skabelon"
                      autoFocus
                      style={{
                        width: '100%', padding: '8px 10px',
                        border: '1px solid var(--line-2)', borderRadius: 'var(--radius)',
                        background: 'var(--bg)', color: 'var(--ink)',
                        fontSize: 13, outline: 'none',
                      }}
                    />
                  )}

                  {/* Confirm + cancel */}
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <button
                      onClick={() => void saveTemplate(templateStep)}
                      disabled={templateSaving}
                      style={{
                        flex: 1, padding: '8px 14px',
                        background: 'var(--accent)', color: '#fff',
                        border: '1px solid var(--accent)', borderRadius: 'var(--radius)',
                        fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 500,
                        cursor: templateSaving ? 'not-allowed' : 'pointer',
                        opacity: templateSaving ? 0.6 : 1,
                      }}
                    >
                      {templateSaving ? 'gemmer…' : templateStep === 'update' ? 'Føj til skabelonen' : 'Gem skabelon'}
                    </button>
                    <button
                      onClick={closeTemplateForm}
                      disabled={templateSaving}
                      style={{
                        background: 'none', border: 'none', padding: '8px 12px', flexShrink: 0,
                        fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted)',
                        cursor: 'pointer',
                      }}
                    >
                      annullér
                    </button>
                  </div>
                  {templateError && (
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--kill)' }}>
                      {templateError}
                    </div>
                  )}
                </div>
              )}
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
