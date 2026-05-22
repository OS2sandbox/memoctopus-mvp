'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MinutesContent, MinutesSection } from '@/types';
import { Button } from '@/components/ui/button';
import { SaveStatus, SaveState } from '@/components/layout/SaveStatus';
import { VersionHistory } from './VersionHistory';

interface VersionRecord {
  id: string;
  createdAt: string;
  content: MinutesContent;
}

interface MinutesEditorProps {
  meetingId: string;
  minutesId: string;
  initialContent: MinutesContent;
  version: number;
  versions: VersionRecord[];
}

const AUTOSAVE_DELAY = 1500;

export function MinutesEditor({
  meetingId,
  minutesId,
  initialContent,
  version: initialVersion,
  versions: initialVersions,
}: MinutesEditorProps) {
  const [content, setContent] = useState<MinutesContent>(initialContent);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [version, setVersion] = useState(initialVersion);
  const [versions, setVersions] = useState(initialVersions);
  const [showHistory, setShowHistory] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isDirtyRef = useRef(false);

  const save = useCallback(
    async (contentToSave: MinutesContent) => {
      setSaveState('saving');
      try {
        const res = await fetch(`/api/meetings/${meetingId}/minutes`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ minutesId, content: contentToSave }),
        });
        if (!res.ok) throw new Error('Save failed');
        const data = await res.json();
        setVersion(data.version);
        if (data.newVersion) {
          setVersions((v) => [data.newVersion, ...v]);
        }
        setSaveState('saved');
        setTimeout(() => setSaveState('idle'), 2000);
        isDirtyRef.current = false;
      } catch {
        setSaveState('error');
      }
    },
    [meetingId, minutesId],
  );

  function updateSection(key: string, text: string) {
    setContent((prev) => ({
      sections: prev.sections.map((s) => (s.key === key ? { ...s, content: text } : s)),
    }));
    isDirtyRef.current = true;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      setContent((current) => {
        save(current);
        return current;
      });
    }, AUTOSAVE_DELAY);
  }

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  function handleRestore(restoredContent: MinutesContent) {
    setContent(restoredContent);
    setShowHistory(false);
    save(restoredContent);
  }

  return (
    <div className="mx-auto max-w-[720px] px-6 py-12">
      {/* Page header */}
      <div className="flex items-start justify-between mb-12">
        <div>
          <h1
            style={{ fontSize: 'var(--t-h1)', fontWeight: 300, color: 'var(--ink)', margin: 0 }}
          >
            Referat
          </h1>
          <p className="mt-1 text-[var(--muted)]" style={{ fontSize: 'var(--t-small)' }}>
            Version {version}
          </p>
        </div>
        <div className="flex items-center gap-3 mt-1">
          <SaveStatus state={saveState} />
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

      {/* Sections — borderless textareas, document feel */}
      <div className="space-y-12">
        {content.sections.map((section: MinutesSection) => (
          <div key={section.key}>
            <h2
              className="mb-3 font-medium text-[var(--ink)]"
              style={{ fontSize: 'var(--t-h2)' }}
            >
              {section.label}
            </h2>
            <textarea
              id={`section-${section.key}`}
              value={section.content}
              onChange={(e) => updateSection(section.key, e.target.value)}
              placeholder={`Skriv ${section.label.toLowerCase()} her…`}
              rows={Math.max(4, Math.ceil(section.content.length / 80))}
              style={{
                width: '100%',
                resize: 'vertical',
                border: 'none',
                borderBottom: '1px solid transparent',
                background: 'transparent',
                outline: 'none',
                color: 'var(--ink)',
                fontSize: 'var(--t-body)',
                lineHeight: 1.7,
                padding: '0 0 8px',
                fontFamily: 'inherit',
                transition: 'border-color 0.1s',
              }}
              onFocus={(e) => (e.target.style.borderBottomColor = 'var(--line-strong)')}
              onBlur={(e) => (e.target.style.borderBottomColor = 'transparent')}
              className="placeholder:text-[var(--muted-2)]"
            />
          </div>
        ))}
      </div>

      {/* Version history — rendered as a right-side sheet via CSS */}
      {showHistory && (
        <div
          className="fixed inset-y-0 right-0 z-50 w-80 bg-[var(--surface)] border-l border-[var(--line)] shadow-lg flex flex-col"
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
