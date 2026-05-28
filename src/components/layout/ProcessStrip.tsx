'use client';

import React from 'react';
import Link from 'next/link';

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
  onTabChange?: (tab: ProcessPhase) => void;
  meetingTitle?: string;
}

export function ProcessStrip({ meetingId, activePhase, completedPhases = [], onTabChange, meetingTitle }: ProcessStripProps) {
  const activeIndex = PHASES.findIndex((p) => p.key === activePhase);

  return (
    <div style={{
      padding: '14px 32px', borderBottom: '1px solid var(--line)',
      display: 'flex', alignItems: 'center', gap: 6,
      background: 'var(--bg)', fontFamily: 'var(--mono)', fontSize: 12,
    }}>
      {PHASES.map((phase, i) => {
        const isActive = phase.key === activePhase;
        const isCompleted = completedPhases.includes(phase.key) || i < activeIndex;
        const isReachable = isCompleted || isActive;

        const stepBadge = (
          <span style={{
            width: 18, height: 18, borderRadius: 999, flexShrink: 0,
            background: isActive ? 'var(--ink)' : 'transparent',
            color: isActive ? 'var(--bg)' : (isCompleted ? 'var(--ink-2)' : 'var(--muted-2)'),
            border: isActive ? 'none' : '1px solid currentColor',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 10.5, fontWeight: 500,
          }}>
            {isCompleted ? '✓' : i + 1}
          </span>
        );

        const inner = (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            color: isActive ? 'var(--ink)' : (isCompleted ? 'var(--ink-2)' : 'var(--muted-2)'),
            fontWeight: isActive ? 500 : 400,
            cursor: isReachable ? 'pointer' : 'default',
            padding: '0 6px',
          }}>
            {stepBadge}
            {phase.label}
          </span>
        );

        return (
          <React.Fragment key={phase.key}>
            {i > 0 && (
              <span style={{ color: 'var(--muted-2)', padding: '0 2px' }}>/</span>
            )}
            {isReachable ? (
              onTabChange ? (
                <button
                  onClick={() => onTabChange(phase.key)}
                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                  aria-current={isActive ? 'step' : undefined}
                >
                  {inner}
                </button>
              ) : (
                <Link
                  href={`/meeting/${meetingId}${phase.path}`}
                  style={{ textDecoration: 'none' }}
                  aria-current={isActive ? 'step' : undefined}
                >
                  {inner}
                </Link>
              )
            ) : (
              <span>{inner}</span>
            )}
          </React.Fragment>
        );
      })}

      {meetingTitle && (
        <span style={{
          marginLeft: 'auto', color: 'var(--muted)',
          fontFamily: 'var(--mono)', fontSize: 12,
        }}>
          {meetingTitle}
        </span>
      )}
    </div>
  );
}
