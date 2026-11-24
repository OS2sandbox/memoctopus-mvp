'use client';

import React from 'react';
import { formatDuration } from '@/lib/utils';
import { useIsMobile } from '@/lib/use-is-mobile';

interface InterruptedRecordingPanelProps {
  // How far the meeting's timeline reached before the interruption.
  savedSeconds: number;
  onResume: () => void;
  onFinish: () => void;
  onDelete: () => void;
}

// Shown when a recording that was left mid-meeting (closed tab, navigation, crash) is
// opened again. It only offers the choices; RecordingScreen carries them out.
export function InterruptedRecordingPanel({ savedSeconds, onResume, onFinish, onDelete }: InterruptedRecordingPanelProps) {
  const isMobile = useIsMobile();

  return (
    <div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', letterSpacing: 0.4 }}>01 · optagelse</div>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: isMobile ? 44 : 64, fontWeight: 500,
        letterSpacing: '-0.04em', color: 'var(--ink)',
        fontVariantNumeric: 'tabular-nums', lineHeight: 1, marginTop: 8,
      }}>
        {formatDuration(savedSeconds)}
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--ink-2)', marginTop: 6 }}>
        optagelsen blev afbrudt
      </div>
      <p style={{ marginTop: 20, maxWidth: 520, fontSize: 13.5, color: 'var(--ink-2)', lineHeight: 1.5 }}>
        Du kan fortsætte, hvor optagelsen slap, eller afslutte den og gå til gennemgang.
        Teksten er gemt, men lyden kan ikke afspilles bagefter.
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 24, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={onResume}
          style={{
            fontFamily: 'var(--mono)', fontSize: 13.5, fontWeight: 500,
            padding: '8px 14px', borderRadius: 'var(--radius)',
            background: 'var(--ink)', color: 'var(--bg)',
            border: '1px solid var(--ink)', cursor: 'pointer',
          }}
        >
          fortsæt optagelse
        </button>
        <button
          type="button"
          onClick={onFinish}
          style={{
            fontFamily: 'var(--mono)', fontSize: 13.5, fontWeight: 500,
            padding: '8px 14px', borderRadius: 'var(--radius)',
            border: '1px solid var(--line-2)', background: 'transparent',
            color: 'var(--ink)', cursor: 'pointer',
          }}
        >
          afslut og gå til gennemgang →
        </button>
        <button
          type="button"
          onClick={onDelete}
          style={{
            fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted-2)',
            background: 'none', border: 'none', cursor: 'pointer',
            textDecoration: 'underline', textUnderlineOffset: 3,
          }}
        >
          slet
        </button>
      </div>
    </div>
  );
}
