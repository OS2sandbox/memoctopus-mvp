'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MinutesContent } from '@/types';
import { Button } from '@/components/ui/button';
import { SaveStatus, SaveState } from '@/components/layout/SaveStatus';
import { RichEditor } from './RichEditor';
import { saveMinutes, snapshotMinutes, setActiveMinutesVersion, updateMeeting } from '@/lib/storage';
import { minutesToBody } from '@/lib/minutes-format';

interface VersionRecord {
  id: string;
  label: number;
  content: MinutesContent;
}

interface MinutesEditorProps {
  meetingId: string;
  meetingTitle: string;
  initialContent: MinutesContent;
  version: number;
  activeVersionId: string | null;
  versions: VersionRecord[];
  onSaved?: () => void;
}

const AUTOSAVE_DELAY = 1500;

// Stable identity of an edited document — used to tell whether anything changed
// since the last checkpoint (so "Gem version" doesn't fork an identical copy).
function fingerprint(content: MinutesContent): string {
  return JSON.stringify({
    body: content.body ?? '',
    title: content.header?.title ?? '',
    date: content.header?.date ?? null,
  });
}

function VersionDropdown({
  version,
  activeVersionId,
  versions,
  onSelect,
}: {
  version: number;
  activeVersionId: string | null;
  versions: VersionRecord[];
  onSelect: (v: VersionRecord) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (versions.length <= 1) {
    return (
      <p className="mt-1 text-[var(--muted)]" style={{ fontSize: 'var(--t-small)' }}>
        Version {version}
      </p>
    );
  }

  // Newest version number first; labels are stable so the order never reshuffles.
  const ordered = [...versions].sort((a, b) => b.label - a.label);

  return (
    <div ref={ref} className="relative mt-1">
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 'var(--t-small)',
          color: 'var(--muted)',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: 0,
        }}
      >
        Version {version}
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="currentColor"
          style={{ flexShrink: 0, transition: 'transform 0.15s', transform: open ? 'rotate(180deg)' : undefined }}
        >
          <path d="M1 3l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            background: 'var(--surface)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius)',
            boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
            zIndex: 50,
            minWidth: 170,
            overflow: 'hidden',
          }}
        >
          {ordered.map((v, i) => {
            const active = v.id === activeVersionId;
            return (
              <button
                key={v.id}
                onClick={() => { onSelect(v); setOpen(false); }}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 12,
                  width: '100%',
                  textAlign: 'left',
                  padding: '7px 12px',
                  fontSize: 'var(--t-small)',
                  color: 'var(--ink)',
                  background: active ? 'var(--fill)' : 'none',
                  border: 'none',
                  borderTop: i === 0 ? 'none' : '1px solid var(--line)',
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--fill)'; }}
                onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'none'; }}
              >
                <span>Version {v.label}</span>
                {active && <span style={{ fontSize: 'var(--t-micro)', color: 'var(--muted)' }}>nuværende</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function MinutesEditor({
  meetingId,
  meetingTitle,
  initialContent,
  version: initialVersion,
  activeVersionId: initialActiveId,
  versions: initialVersions,
  onSaved,
}: MinutesEditorProps) {
  const [body, setBody] = useState<string>(() => minutesToBody(initialContent));
  const [title, setTitle] = useState<string>(() => initialContent.header?.title ?? meetingTitle);
  // null means the document has no date line (the "Dato" tag wasn't selected); a
  // string (possibly empty) means the date field is shown and editable.
  const [date, setDate] = useState<string | null>(() => initialContent.header?.date ?? null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [version, setVersion] = useState(initialVersion);
  const [activeId, setActiveId] = useState(initialActiveId);
  const [versions, setVersions] = useState<VersionRecord[]>(initialVersions);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Latest field values held in refs so the debounced save and the leave/unmount
  // handlers always see the freshest text without re-subscribing.
  const bodyRef = useRef(body);
  const titleRef = useRef(title);
  const dateRef = useRef(date);
  useEffect(() => { bodyRef.current = body; }, [body]);
  useEffect(() => { titleRef.current = title; }, [title]);
  useEffect(() => { dateRef.current = date; }, [date]);

  const currentContent = useCallback((): MinutesContent => {
    return { body: bodyRef.current, header: { title: titleRef.current, date: dateRef.current } };
  }, []);

  // Document fingerprint as of the last checkpoint / version load — used to tell
  // whether there's anything new worth snapshotting.
  const baselineRef = useRef(fingerprint(currentContent()));
  // Meeting title last pushed to the meeting record, so pure body edits don't
  // trigger redundant renames.
  const savedTitleRef = useRef(title);

  // Autosave / persist: overwrite the ACTIVE version's content in place — never
  // changes labels, order, or which version is active — and mirror the title onto
  // the meeting so it's renamed everywhere.
  const persist = useCallback(
    async (content: MinutesContent) => {
      setSaveState('saving');
      try {
        const saved = await saveMinutes(meetingId, content);
        setVersions(saved.versions.map((v) => ({ id: v.id, label: v.label, content: v.content })));
        const nextTitle = content.header?.title ?? meetingTitle;
        if (nextTitle !== savedTitleRef.current) {
          await updateMeeting(meetingId, { title: nextTitle });
          savedTitleRef.current = nextTitle;
        }
        setSaveState('saved');
        setTimeout(() => setSaveState('idle'), 2000);
        onSaved?.();
      } catch {
        setSaveState('error');
      }
    },
    [meetingId, meetingTitle, onSaved],
  );

  const flushSave = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    await persist(currentContent());
  }, [persist, currentContent]);

  function scheduleSave() {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void persist(currentContent()), AUTOSAVE_DELAY);
  }

  function updateBody(text: string) { setBody(text); scheduleSave(); }
  function updateTitle(text: string) { setTitle(text); scheduleSave(); }
  function updateDate(text: string) { setDate(text); scheduleSave(); }

  // Checkpoint the current document as a NEW version ("Gem version"). Flushes the
  // active version first, then forks a fresh version (next stable label) that
  // becomes active — prior versions keep their numbers and content. No-op when
  // nothing changed since the last checkpoint.
  const snapshot = useCallback(async () => {
    const content = currentContent();
    if (fingerprint(content) === baselineRef.current) return;
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    setSaveState('saving');
    try {
      await saveMinutes(meetingId, content);
      const snapped = await snapshotMinutes(meetingId, content);
      if (snapped) {
        setVersion(snapped.version);
        setActiveId(snapped.activeVersionId);
        setVersions(snapped.versions.map((v) => ({ id: v.id, label: v.label, content: v.content })));
      }
      baselineRef.current = fingerprint(content);
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 2000);
      onSaved?.();
    } catch {
      setSaveState('error');
    }
  }, [meetingId, onSaved, currentContent]);

  // Flush the open editing session when the user leaves (tab hidden/closed or SPA
  // navigation away). This persists in place — it does NOT create a version — so
  // navigating around no longer spawns versions; only "Gem version" does.
  const flushRef = useRef(flushSave);
  useEffect(() => { flushRef.current = flushSave; }, [flushSave]);
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') void flushRef.current();
    };
    const onPageHide = () => void flushRef.current();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      void flushRef.current();
    };
  }, []);

  async function loadVersion(v: VersionRecord) {
    if (v.id === activeId) return;
    // Persist any pending edits to the currently-active version before switching.
    await flushSave();
    const switched = await setActiveMinutesVersion(meetingId, v.id);
    const nextBody = minutesToBody(v.content);
    const nextTitle = v.content.header?.title ?? meetingTitle;
    const nextDate = v.content.header?.date ?? null;
    setBody(nextBody); bodyRef.current = nextBody;
    setTitle(nextTitle); titleRef.current = nextTitle;
    setDate(nextDate); dateRef.current = nextDate;
    setActiveId(v.id);
    setVersion(v.label);
    if (switched) {
      setVersions(switched.versions.map((sv) => ({ id: sv.id, label: sv.label, content: sv.content })));
    }
    baselineRef.current = fingerprint(currentContent());
  }

  const dirty = fingerprint({ body, header: { title, date } }) !== baselineRef.current;

  return (
    <div style={{ background: 'var(--bg-2)', minHeight: 'calc(100vh - 56px)' }}>
      <div className="mx-auto max-w-[820px] px-6 py-10">
        <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
          <div>
            <h1
              style={{ fontSize: 'var(--t-h1)', fontWeight: 300, color: 'var(--ink)', margin: 0 }}
            >
              Referat
            </h1>
            <VersionDropdown version={version} activeVersionId={activeId} versions={versions} onSelect={loadVersion} />
          </div>
          <div className="flex items-center gap-3 mt-1">
            <SaveStatus state={saveState} />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void snapshot()}
              disabled={!dirty}
              title="Gem den nuværende tekst som en version du kan vende tilbage til"
            >
              Gem version
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => (window.location.href = `/meeting/${meetingId}/export`)}
            >
              Eksportér
            </Button>
          </div>
        </div>

        {/* Editability hint — the sheet below mirrors the exported document, so
            it isn't obvious it can be edited without a nudge. */}
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)',
            letterSpacing: 0.4, marginBottom: 10,
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
          klik for at redigere · gemmes automatisk
        </div>

        {/* Paper sheet — the document exactly as it exports: an editable header
            (title + optional date) above the body. */}
        <div
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius)',
            boxShadow: '0 1px 2px rgba(0,0,0,0.04), 0 8px 28px rgba(0,0,0,0.06)',
            padding: 'clamp(28px, 6vw, 64px)',
          }}
        >
          <input
            value={title}
            onChange={(e) => updateTitle(e.target.value)}
            placeholder="Mødetitel"
            aria-label="Titel"
            style={{
              width: '100%', border: 'none', outline: 'none', background: 'transparent',
              fontSize: 'var(--t-h2, 24px)', fontWeight: 700, color: 'var(--ink)',
              padding: 0, lineHeight: 1.2,
            }}
          />
          {date !== null && (
            <input
              value={date}
              onChange={(e) => updateDate(e.target.value)}
              placeholder="Dato"
              aria-label="Dato"
              style={{
                width: '100%', border: 'none', outline: 'none', background: 'transparent',
                fontSize: 'var(--t-small)', color: 'var(--muted)',
                padding: 0, marginTop: 6,
              }}
            />
          )}
          <div style={{ height: 1, background: 'var(--line)', margin: '16px 0 20px' }} />

          <RichEditor
            value={body}
            onChange={updateBody}
            placeholder="Skriv referatet her…"
            borderless
            minHeight={520}
          />
        </div>
      </div>
    </div>
  );
}
