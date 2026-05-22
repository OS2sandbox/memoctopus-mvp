'use client';

import React from 'react';

interface VolumeBarProps {
  level: number; // 0–1
  barCount?: number;
}

export function VolumeBar({ level, barCount = 20 }: VolumeBarProps) {
  const activeBars = Math.round(level * barCount);

  return (
    <div className="flex items-end gap-0.5 h-8" aria-label={`Lydniveau: ${Math.round(level * 100)}%`}>
      {Array.from({ length: barCount }, (_, i) => {
        const isActive = i < activeBars;
        const relativePos = i / barCount;
        // Vary bar height for a natural waveform look
        const heightPct = 20 + relativePos * 60 + Math.sin(i * 0.8) * 20;
        return (
          <span
            key={i}
            className="rounded-sm transition-colors duration-75"
            style={{
              width: '3px',
              height: `${Math.min(100, Math.max(15, heightPct))}%`,
              backgroundColor: isActive
                ? `var(--accent)`
                : `var(--border-strong)`,
              opacity: isActive ? 1 : 0.5,
            }}
          />
        );
      })}
    </div>
  );
}
