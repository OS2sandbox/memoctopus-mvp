'use client';

import React from 'react';

interface WaitingForTranscriptionPanelProps {
  // Batches this recording was cut into, and how many of them still have no text.
  total: number;
  waiting: number;
  online: boolean;
  authRequired: boolean;
  persistFailed: boolean;
  onRetry: () => void;
}

// Shown after stop while the batch queue still sends the recording's parts. It only
// reports: the queue does the sending and the screen saves once nothing is waiting.
export function WaitingForTranscriptionPanel({
  total, waiting, online, authRequired, persistFailed, onRetry,
}: WaitingForTranscriptionPanelProps) {
  const done = Math.max(0, total - waiting);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div role="status" style={{ width: '100%' }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 7,
        fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{
            display: 'inline-block', width: 11, height: 11, borderRadius: 999, flexShrink: 0,
            border: '2px solid var(--accent)', borderTopColor: 'transparent',
            animation: 'spin 0.8s linear infinite',
          }} />
          <span>transskriberer {done} / {total} dele…</span>
        </div>
        <span style={{ color: 'var(--accent)', fontWeight: 500 }}>{pct}%</span>
      </div>
      <div style={{ height: 3, borderRadius: 999, background: 'var(--line)', overflow: 'hidden' }}>
        <div style={{
          height: '100%', borderRadius: 999, background: 'var(--accent)',
          width: `${pct}%`, transition: 'width 0.5s ease-out',
        }} />
      </div>

      {!online && (
        <p style={{ marginTop: 12, fontSize: 13.5, color: 'var(--ink-2)', lineHeight: 1.5 }}>
          {waiting} af {total} dele mangler at blive transskriberet. De sendes automatisk, når forbindelsen er tilbage. Lyden slettes, så snart den er transskriberet, og senest efter 24 timer.
          {!persistFailed && ' Indtil da gemmes lyden i browseren i op til 24 timer.'}
        </p>
      )}
      {persistFailed && (
        <p style={{ marginTop: 12, fontSize: 13.5, color: 'var(--kill)', lineHeight: 1.5 }}>
          Lyden kunne ikke gemmes i browseren. Hold fanen åben, indtil transskriptionen er færdig.
        </p>
      )}
      {authRequired && (
        <p style={{ marginTop: 12, fontSize: 13.5, color: 'var(--ink-2)', lineHeight: 1.5 }}>
          Du er blevet logget ud. Log ind i en ny fane, og klik derefter på{' '}
          <button
            type="button"
            onClick={onRetry}
            style={{
              fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--ink)',
              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              textDecoration: 'underline', textUnderlineOffset: 3,
            }}
          >
            prøv igen
          </button>
          .
        </p>
      )}
    </div>
  );
}
