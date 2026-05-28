'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MinutesContent, MinutesSection } from '@/types';
import { Button } from '@/components/ui/button';
import { SaveStatus, SaveState } from '@/components/layout/SaveStatus';
import { VersionHistory } from './VersionHistory';
import { RichEditor } from './RichEditor';

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
  const [addingSection, setAddingSection] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const newLabelRef = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      } catch {
        setSaveState('error');
      }
    },
    [meetingId, minutesId],
  );

  function updateSection(key: string, text: string) {
    setContent((prev) => {
      const next = {
        sections: prev.sections.map((s) => (s.key === key ? { ...s, content: text } : s)),
      };
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => save(next), AUTOSAVE_DELAY);
      return next;
    });
  }

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  function openAddSection() {
    setNewLabel('');
    setAddingSection(true);
    setTimeout(() => newLabelRef.current?.focus(), 0);
  }

  function commitAddSection() {
    const label = newLabel.trim();
    if (!label) { setAddingSection(false); return; }
    const key = `custom_${Date.now()}`;
    setContent((prev) => {
      const next = { sections: [...prev.sections, { key, label, content: '' }] };
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => save(next), AUTOSAVE_DELAY);
      return next;
    });
    setAddingSection(false);
    setNewLabel('');
  }

  function handleRestore(restoredContent: MinutesContent) {
    setContent(restoredContent);
    setShowHistory(false);
    save(restoredContent);
  }

  return (
    <div className="mx-auto max-w-[720px] px-6 py-12">
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

      <div className="space-y-10">
        {content.sections.map((section: MinutesSection) => (
          <div key={section.key}>
            <h2
              className="mb-3 font-medium text-[var(--ink)]"
              style={{ fontSize: 'var(--t-h2)' }}
            >
              {section.label}
            </h2>
            <RichEditor
              value={section.content}
              onChange={(md) => updateSection(section.key, md)}
              placeholder={`Skriv ${section.label.toLowerCase()} her…`}
            />
          </div>
        ))}
      </div>

      {/* Add section */}
      <div className="mt-10">
        {addingSection ? (
          <div className="flex items-center gap-2">
            <input
              ref={newLabelRef}
              type="text"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitAddSection();
                if (e.key === 'Escape') setAddingSection(false);
              }}
              placeholder="Navn på afsnit…"
              style={{
                flex: 1,
                border: '1px solid var(--accent)',
                borderRadius: 'var(--radius)',
                background: 'var(--surface)',
                outline: 'none',
                padding: '6px 10px',
                fontSize: 'var(--t-body)',
                color: 'var(--ink)',
              }}
            />
            <button
              onClick={commitAddSection}
              style={{
                padding: '6px 14px',
                borderRadius: 'var(--radius)',
                background: 'var(--ink)',
                color: 'white',
                fontSize: 'var(--t-small)',
                fontWeight: 500,
                border: 'none',
                cursor: 'pointer',
              }}
            >
              Tilføj
            </button>
            <button
              onClick={() => setAddingSection(false)}
              style={{
                padding: '6px 10px',
                borderRadius: 'var(--radius)',
                background: 'transparent',
                color: 'var(--muted)',
                fontSize: 'var(--t-small)',
                border: '1px solid var(--line)',
                cursor: 'pointer',
              }}
            >
              Annullér
            </button>
          </div>
        ) : (
          <button
            onClick={openAddSection}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 12px',
              borderRadius: 'var(--radius)',
              border: '1px dashed var(--line-strong)',
              background: 'transparent',
              color: 'var(--muted)',
              fontSize: 'var(--t-small)',
              cursor: 'pointer',
              transition: 'color 0.15s, border-color 0.15s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = 'var(--ink)';
              e.currentTarget.style.borderColor = 'var(--ink-3)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = 'var(--muted)';
              e.currentTarget.style.borderColor = 'var(--line-strong)';
            }}
          >
            <span style={{ fontSize: 16, lineHeight: 1 }}>+</span>
            Tilføj afsnit
          </button>
        )}
      </div>

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
