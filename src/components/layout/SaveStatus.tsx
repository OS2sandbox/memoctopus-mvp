'use client';

import React, { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface SaveStatusProps {
  state: SaveState;
  className?: string;
}

export function SaveStatus({ state, className }: SaveStatusProps) {
  const [savedAgo, setSavedAgo] = useState(0);
  const savedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (state === 'saved') {
      savedAtRef.current = Date.now();
      setSavedAgo(0);
    }
  }, [state]);

  useEffect(() => {
    if (state !== 'saved') return;
    const id = setInterval(() => {
      if (savedAtRef.current === null) return;
      setSavedAgo(Math.floor((Date.now() - savedAtRef.current) / 1000));
    }, 5000);
    return () => clearInterval(id);
  }, [state]);

  if (state === 'idle') return null;

  function label() {
    if (state === 'saving') return 'Gemmer…';
    if (state === 'error') return 'Fejl ved gemning';
    if (savedAgo < 10) return 'Gemt';
    const rtf = new Intl.RelativeTimeFormat('da', { numeric: 'auto' });
    if (savedAgo < 60) return `Gemt · for ${savedAgo} sek. siden`;
    return `Gemt · ${rtf.format(-Math.floor(savedAgo / 60), 'minute')}`;
  }

  return (
    <span
      className={cn(
        'text-xs',
        state === 'error' ? 'text-[var(--danger)]' : 'text-[var(--muted)]',
        className,
      )}
    >
      {label()}
    </span>
  );
}
