'use client';

import React from 'react';
import { formatDateTime } from '@/lib/utils';
import { MinutesContent } from '@/types';
import { Button } from '@/components/ui/button';

interface MinutesVersion {
  id: string;
  createdAt: string;
  content: MinutesContent;
  version?: number;
}

interface VersionHistoryProps {
  versions: MinutesVersion[];
  currentVersion: number;
  onRestore: (content: MinutesContent) => void;
}

export function VersionHistory({ versions, currentVersion, onRestore }: VersionHistoryProps) {
  if (versions.length === 0) {
    return (
      <p className="text-sm text-[var(--text-muted)] py-4 text-center">
        Ingen versionshistorik endnu.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-[var(--text-muted)] mb-2">
        Versioner gemmes i 7 dage. Nuværende version: {currentVersion}
      </p>
      {versions.map((v, i) => (
        <div
          key={v.id}
          className="flex items-center justify-between gap-2 py-2 border-b border-[var(--border)] last:border-0"
        >
          <div>
            <span className="text-sm font-medium text-[var(--text)]">
              Version {versions.length - i}
            </span>
            <span className="ml-2 text-xs text-[var(--text-muted)]">
              {formatDateTime(v.createdAt)}
            </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onRestore(v.content)}
          >
            Gendan
          </Button>
        </div>
      ))}
    </div>
  );
}
