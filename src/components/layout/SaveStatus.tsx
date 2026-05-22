'use client';

import React from 'react';
import { cn } from '@/lib/utils';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface SaveStatusProps {
  state: SaveState;
  className?: string;
}

export function SaveStatus({ state, className }: SaveStatusProps) {
  if (state === 'idle') return null;

  const config = {
    saving: { label: 'Gemmer...', color: 'text-[var(--text-muted)]' },
    saved: { label: 'Gemt', color: 'text-[var(--success)]' },
    error: { label: 'Fejl ved gemning', color: 'text-[var(--danger)]' },
  } satisfies Record<Exclude<SaveState, 'idle'>, { label: string; color: string }>;

  const current = config[state];

  return (
    <span className={cn('text-xs flex items-center gap-1', current.color, className)}>
      {state === 'saving' && (
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
      )}
      {state === 'saved' && (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {state === 'error' && (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6 4v3M6 8.5v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )}
      {current.label}
    </span>
  );
}

export type { SaveState };
