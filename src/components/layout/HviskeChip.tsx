'use client';

import React from 'react';
import { cn } from '@/lib/utils';

interface HviskeChipProps {
  label?: string;
  className?: string;
}

export function HviskeChip({ label = 'Hviske', className }: HviskeChipProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--surface-2)] px-2 py-0.5',
        className,
      )}
      style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', letterSpacing: '-0.02em' }}
    >
      <span
        className="h-1.5 w-1.5 rounded-full bg-[var(--ok)]"
        style={{ animation: 'mo-pulse 1.6s ease-in-out infinite' }}
        aria-hidden
      />
      <style>{`
        @keyframes mo-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%       { opacity: 0.4; transform: scale(0.8); }
        }
      `}</style>
      <span className="text-[var(--ink-2)]">{label}</span>
    </span>
  );
}
