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
      <p className="px-5 py-6 text-center text-[var(--muted)]" style={{ fontSize: 'var(--t-small)' }}>
        Ingen versionshistorik endnu.
      </p>
    );
  }

  return (
    <div>
      <p
        className="px-5 py-3 text-[var(--muted)] border-b border-[var(--line)]"
        style={{ fontSize: 'var(--t-micro)', fontFamily: 'var(--font-mono)' }}
      >
        Nuværende version: {currentVersion} · Bevares i 7 dage
      </p>
      <div className="divide-y divide-[var(--line)]">
        {versions.map((v, i) => (
          <div
            key={v.id}
            className="flex items-center justify-between gap-2 px-5 py-3"
          >
            <div>
              <span className="font-medium text-[var(--ink)]" style={{ fontSize: 'var(--t-small)' }}>
                Version {versions.length - i}
              </span>
              <span
                className="ml-2 text-[var(--muted)]"
                style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--t-micro)' }}
              >
                {formatDateTime(v.createdAt)}
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onRestore(v.content)}
            >
              Gendan
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
