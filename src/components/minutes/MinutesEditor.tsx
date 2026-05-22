'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MinutesContent, MinutesSection } from '@/types';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { SaveStatus, SaveState } from '@/components/layout/SaveStatus';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
      sections: prev.sections.map((s) =>
        s.key === key ? { ...s, content: text } : s,
      ),
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
    <div className="mx-auto max-w-[960px] px-4 py-8">
      <div className="flex items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl font-semibold text-[var(--text)]">Referat</h1>
          <p className="mt-0.5 text-sm text-[var(--text-muted)]">
            Version {version} · Gemmes automatisk
          </p>
        </div>
        <div className="flex items-center gap-3">
          <SaveStatus state={saveState} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowHistory(true)}
          >
            Versionshistorik
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={() => window.location.href = `/meeting/${meetingId}/share`}
          >
            Eksportér
          </Button>
        </div>
      </div>

      <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
        {content.sections.map((section: MinutesSection, i: number) => (
          <div key={section.key} className="px-6 py-5">
            <label
              htmlFor={`section-${section.key}`}
              className="block text-sm font-semibold text-[var(--text)] mb-2"
            >
              {section.label}
            </label>
            <Textarea
              id={`section-${section.key}`}
              value={section.content}
              onChange={(e) => updateSection(section.key, e.target.value)}
              placeholder={`Skriv ${section.label.toLowerCase()} her...`}
              className="min-h-[120px] text-sm leading-relaxed"
              rows={Math.max(4, Math.ceil(section.content.length / 80))}
            />
          </div>
        ))}
      </div>

      {/* Version history dialog */}
      <Dialog open={showHistory} onOpenChange={setShowHistory}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Versionshistorik</DialogTitle>
          </DialogHeader>
          <VersionHistory
            versions={versions}
            currentVersion={version}
            onRestore={handleRestore}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
