'use client';

import React from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';

export type ProcessPhase = 'recording' | 'review' | 'minutes' | 'export';

const PHASES: { key: ProcessPhase; label: string; path: string }[] = [
  { key: 'recording', label: 'Optagelse', path: '' },
  { key: 'review', label: 'Gennemgang', path: '/review' },
  { key: 'minutes', label: 'Referat', path: '/minutes' },
  { key: 'export', label: 'Eksport', path: '/export' },
];

interface ProcessStripProps {
  meetingId: string;
  activePhase: ProcessPhase;
  completedPhases?: ProcessPhase[];
}

export function ProcessStrip({ meetingId, activePhase, completedPhases = [] }: ProcessStripProps) {
  const activeIndex = PHASES.findIndex((p) => p.key === activePhase);

  return (
    <div className="border-b border-[var(--line)] bg-[var(--surface)]">
      <div className="mx-auto flex h-10 max-w-[1040px] items-center gap-0 px-6">
        {PHASES.map((phase, i) => {
          const isActive = phase.key === activePhase;
          const isCompleted = completedPhases.includes(phase.key) || i < activeIndex;
          const isReachable = isCompleted || isActive;

          const inner = (
            <span
              className={cn(
                'flex items-center gap-2 px-3 h-full text-sm',
                isActive && 'text-[var(--ink)] font-medium',
                isCompleted && !isActive && 'text-[var(--ink-2)]',
                !isActive && !isCompleted && 'text-[var(--muted-2)]',
              )}
            >
              <span
                className={cn(
                  'flex h-[18px] w-[18px] items-center justify-center rounded-full text-[10px] font-medium shrink-0',
                  isActive && 'bg-[var(--ink)] text-white',
                  isCompleted && !isActive && 'bg-[var(--line-strong)] text-[var(--ink-2)]',
                  !isActive && !isCompleted && 'bg-[var(--line)] text-[var(--muted-2)]',
                )}
              >
                {i + 1}
              </span>
              {phase.label}
            </span>
          );

          return (
            <React.Fragment key={phase.key}>
              {i > 0 && (
                <span className="text-[var(--muted-2)] text-xs px-0.5" aria-hidden>
                  /
                </span>
              )}
              {isReachable ? (
                <Link
                  href={`/meeting/${meetingId}${phase.path}`}
                  className="flex items-center h-full hover:bg-[var(--surface-2)] transition-colors rounded-[var(--radius-sm)]"
                  aria-current={isActive ? 'step' : undefined}
                >
                  {inner}
                </Link>
              ) : (
                <span className="flex items-center h-full">{inner}</span>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
