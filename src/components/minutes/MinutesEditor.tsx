'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MinutesContent } from '@/types';
import { Button } from '@/components/ui/button';
import { SaveStatus, SaveState } from '@/components/layout/SaveStatus';
import { VersionHistory } from './VersionHistory';
import { RichEditor } from './RichEditor';
import { saveMinutes, snapshotMinutes } from '@/lib/storage';
import { minutesToBody } from '@/lib/minutes-format';

interface VersionRecord {
  id: string;
  createdAt: string;
  content: MinutesContent;
}

interface MinutesEditorProps {
  meetingId: string;
  initialContent: MinutesContent;
  version: number;
  versions: VersionRecord[];
  onSaved?: () => void;
}

const AUTOSAVE_DELAY = 1500;

function VersionDropdown({
  version,
  versions,
  onSelect,
}: {
  version: number;
  versions: VersionRecord[];
  onSelect: (content: MinutesContent) => void;
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

  if (versions.length === 0) {
    return (
      <p className="mt-1 text-[var(--muted)]" style={{ fontSize: 'var(--t-small)' }}>
        Version {version}
      </p>
    );
  }

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
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '7px 12px',
              fontSize: 'var(--t-small)',
              color: 'var(--ink)',
              background: 'var(--fill)',
            }}
          >
            <span>Version {version}</span>
            <span style={{ fontSize: 'var(--t-micro)', color: 'var(--muted)' }}>nuværende</span>
          </div>
          {versions.map((v, i) => (
            <button
              key={v.id}
              onClick={() => { onSelect(v.content); setOpen(false); }}
              style={{
                display: 'flex',
                width: '100%',
                textAlign: 'left',
                padding: '7px 12px',
                fontSize: 'var(--t-small)',
                color: 'var(--ink)',
                background: 'none',
                border: 'none',
                borderTop: '1px solid var(--line)',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--fill)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
            >
              Version {versions.length - i}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function MinutesEditor({
  meetingId,
  initialContent,
  version: initialVersion,
  versions: initialVersions,
  onSaved,
}: MinutesEditorProps) {
  const [body, setBody] = useState<string>(() => minutesToBody(initialContent));
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [version, setVersion] = useState(initialVersion);
  const [versions, setVersions] = useState(initialVersions);
  const [showHistory, setShowHistory] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Latest body (kept in a ref so the leave/unmount handlers see the freshest
  // text without re-subscribing), and the body as of the last checkpoint — used
  // to tell whether anything changed worth snapshotting.
  const latestBodyRef = useRef(body);
  const baselineBodyRef = useRef(body);
  useEffect(() => {
    latestBodyRef.current = body;
  }, [body]);

  // Autosave: overwrite the current content in place. Does NOT create a version —
  // continuous editing keeps a single live document instead of spawning versions.
  const save = useCallback(
    async (bodyToSave: string) => {
      setSaveState('saving');
      try {
        await saveMinutes(meetingId, { body: bodyToSave });
        setSaveState('saved');
        setTimeout(() => setSaveState('idle'), 2000);
        onSaved?.();
      } catch {
        setSaveState('error');
      }
    },
    [meetingId, onSaved],
  );

  // Checkpoint the current document as a new version. Flushes any pending autosave
  // first so the latest text is persisted, then archives the previous checkpoint
  // (the baseline) into history. No-op when nothing changed since the last
  // checkpoint. Triggered when leaving the editor and by the "Gem version" button.
  const snapshot = useCallback(async () => {
    const current = latestBodyRef.current;
    const baseline = baselineBodyRef.current;
    if (current === baseline) return;
    baselineBodyRef.current = current;
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    setSaveState('saving');
    try {
      await saveMinutes(meetingId, { body: current });
      const snapped = await snapshotMinutes(meetingId, { body: baseline });
      if (snapped) {
        setVersion(snapped.version);
        setVersions(snapped.versions);
      }
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 2000);
      onSaved?.();
    } catch {
      setSaveState('error');
    }
  }, [meetingId, onSaved]);

  function updateBody(text: string) {
    setBody(text);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => save(text), AUTOSAVE_DELAY);
  }

  // Snapshot when the user leaves: tab hidden / closed (visibilitychange,
  // pagehide) and SPA navigation away (effect cleanup on unmount). Held in a ref
  // so listeners attach once and always call the freshest snapshot closure.
  const snapshotRef = useRef(snapshot);
  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') void snapshotRef.current();
    };
    const onPageHide = () => void snapshotRef.current();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      void snapshotRef.current();
    };
  }, []);

  function loadVersion(restored: MinutesContent) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setBody(minutesToBody(restored));
  }

  // Restore an old version: preserve whatever is currently shown as its own
  // version first (so the restore is itself undoable), then make the restored
  // content the new current document.
  async function handleRestore(restored: MinutesContent) {
    const restoredBody = minutesToBody(restored);
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    setShowHistory(false);
    setSaveState('saving');
    try {
      const snapped = await snapshotMinutes(meetingId, { body: latestBodyRef.current });
      if (snapped) {
        setVersion(snapped.version);
        setVersions(snapped.versions);
      }
      setBody(restoredBody);
      baselineBodyRef.current = restoredBody;
      latestBodyRef.current = restoredBody;
      await saveMinutes(meetingId, { body: restoredBody });
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 2000);
      onSaved?.();
    } catch {
      setSaveState('error');
    }
  }

  return (
    <div className="mx-auto max-w-[720px] px-6 py-12">
      <div className="flex flex-wrap items-start justify-between gap-4 mb-10">
        <div>
          <h1
            style={{ fontSize: 'var(--t-h1)', fontWeight: 300, color: 'var(--ink)', margin: 0 }}
          >
            Referat
          </h1>
          <VersionDropdown version={version} versions={versions} onSelect={loadVersion} />
        </div>
        <div className="flex items-center gap-3 mt-1">
          <SaveStatus state={saveState} />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void snapshot()}
            disabled={body === baselineBodyRef.current}
            title="Gem den nuværende tekst som en version du kan vende tilbage til"
          >
            Gem version
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setShowHistory(true)}>
            Historik
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

      {/* Single, borderless editable referat document */}
      <RichEditor
        value={body}
        onChange={updateBody}
        placeholder="Skriv referatet her…"
        borderless
        minHeight={420}
      />

      {showHistory && (
        <div
          className="fixed inset-y-0 right-0 z-50 w-80 max-w-full bg-[var(--surface)] border-l border-[var(--line)] shadow-lg flex flex-col"
          style={{ animation: 'slide-in-from-right 0.15s ease' }}
        >
          <style>{`
            @keyframes slide-in-from-right {
              from { transform: translateX(100%); }
              to   { transform: translateX(0); }
            }
          `}</style>
          <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--line)]">
            <span className="font-medium text-[var(--ink)]" style={{ fontSize: 'var(--t-body)' }}>
              Versionshistorik
            </span>
            <button
              onClick={() => setShowHistory(false)}
              className="text-[var(--muted)] hover:text-[var(--ink)] transition-colors"
              aria-label="Luk"
            >
              ✕
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            <VersionHistory
              versions={versions}
              currentVersion={version}
              onRestore={handleRestore}
            />
          </div>
        </div>
      )}
    </div>
  );
}
