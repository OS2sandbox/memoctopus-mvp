'use client';

import React, { useState, useRef, useEffect } from 'react';
import { TranscriptSegment } from '@/types';
import { formatDuration } from '@/lib/utils';
import { Button } from '@/components/ui/button';

interface SpeakerRowProps {
  segment: TranscriptSegment;
  index: number;
  onUpdate: (index: number, segment: TranscriptSegment) => void;
  onRenameAll: (from: string, to: string) => void;
  speakerSegmentCount: number;
  onSeek?: (time: number) => void;
  hasPii?: boolean;
  isHighlighted?: boolean;
  // Diarization is still running: show an uncertainty placeholder for the speaker
  // instead of the not-yet-meaningful default label, and don't offer rename yet.
  diarizing?: boolean;
}

export const SpeakerRow = React.memo(function SpeakerRow({ segment, index, onUpdate, onRenameAll, speakerSegmentCount, onSeek, hasPii, isHighlighted, diarizing }: SpeakerRowProps) {
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renameOpen) {
      setRenameValue(segment.speaker);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [renameOpen, segment.speaker]);

  function commitRename() {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== segment.speaker) {
      onRenameAll(segment.speaker, trimmed);
    }
    setRenameOpen(false);
  }

  function handleTextChange(text: string) {
    onUpdate(index, { ...segment, text });
  }

  return (
    <div
      className="flex gap-0 py-4 transition-all duration-300"
      style={{
        borderLeft: hasPii ? '3px solid var(--warning, #f59e0b)' : '3px solid transparent',
        paddingLeft: hasPii ? '12px' : '0',
        backgroundColor: isHighlighted ? 'color-mix(in srgb, var(--warning, #f59e0b) 10%, transparent)' : undefined,
        borderRadius: isHighlighted ? 'var(--radius-sm)' : undefined,
      }}
    >
      {/* Left rail: speaker + timestamp */}
      <div className="w-24 shrink-0 pr-4 pt-0.5 relative">
        {onSeek ? (
          <button
            type="button"
            className="block tabular-nums mb-0.5 text-left group"
            style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--t-micro)', color: 'var(--muted)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
            title="Lyt til dette segment"
            onClick={() => onSeek(segment.start)}
          >
            <span className="group-hover:text-[var(--accent)] transition-colors">
              {formatDuration(segment.start)}
            </span>
            {' '}
            <span className="opacity-0 group-hover:opacity-100 transition-opacity" style={{ fontSize: 9 }}>▶</span>
          </button>
        ) : (
          <span
            className="block text-[var(--muted)] tabular-nums mb-0.5"
            style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--t-micro)' }}
          >
            {formatDuration(segment.start)}
          </span>
        )}
        {diarizing ? (
          <span
            className="flex items-center gap-1.5"
            title="Genkender taler…"
            aria-label="Genkender taler"
          >
            <span
              aria-hidden
              style={{
                display: 'block', height: 11, width: 52, borderRadius: 999,
                background: 'linear-gradient(90deg, var(--sunk) 25%, var(--line-2) 50%, var(--sunk) 75%)',
                backgroundSize: '300% 100%',
                animation: 'speakerShimmer 1.4s ease-in-out infinite',
              }}
            />
          </span>
        ) : (
          <button
            className="text-[var(--ink-2)] hover:text-[var(--accent)] transition-colors text-left w-full truncate"
            style={{ fontSize: 'var(--t-small)', fontWeight: 500 }}
            onClick={() => setRenameOpen((v) => !v)}
            title="Klik for at omdøbe taleren"
          >
            {segment.speaker}
          </button>
        )}

        {renameOpen && !diarizing && (
          <div
            className="absolute left-0 z-10 rounded-[var(--radius)] border border-[var(--line-strong)] bg-[var(--surface)] shadow-md"
            style={{ top: '100%', minWidth: 220, padding: '12px 14px' }}
          >
            <p className="font-medium text-[var(--ink)] mb-0.5" style={{ fontSize: 'var(--t-small)' }}>
              Omdøb &quot;{segment.speaker}&quot;
            </p>
            <p className="text-[var(--muted)] mb-3" style={{ fontSize: 'var(--t-micro)' }}>
              Bruges i {speakerSegmentCount} {speakerSegmentCount === 1 ? 'segment' : 'segmenter'}
            </p>
            <input
              ref={inputRef}
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') setRenameOpen(false);
              }}
              className="w-full border border-[var(--line-strong)] rounded-[var(--radius-sm)] px-2 py-1.5 text-sm bg-[var(--surface)] text-[var(--ink)] outline-none focus:border-[var(--accent)]"
              style={{ fontSize: 'var(--t-small)' }}
            />
            <div className="flex gap-2 mt-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setRenameOpen(false)}
                className="flex-1"
              >
                Annullér
              </Button>
              <Button
                size="sm"
                onClick={commitRename}
                disabled={!renameValue.trim()}
                className="flex-1"
              >
                Omdøb alle
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Text block */}
      <div className="flex-1">
        <textarea
          value={segment.text}
          onChange={(e) => handleTextChange(e.target.value)}
          rows={Math.max(2, Math.ceil(segment.text.length / 80))}
          style={{
            width: '100%',
            resize: 'none',
            border: 'none',
            background: 'transparent',
            outline: 'none',
            color: 'var(--ink)',
            fontSize: 'var(--t-body)',
            lineHeight: 1.6,
            padding: 0,
            fontFamily: 'inherit',
          }}
          className="hover:bg-[var(--surface-2)] focus:bg-[var(--surface-2)] rounded-[var(--radius-sm)] px-1 -ml-1 transition-colors placeholder:text-[var(--muted-2)]"
        />
      </div>
    </div>
  );
});
