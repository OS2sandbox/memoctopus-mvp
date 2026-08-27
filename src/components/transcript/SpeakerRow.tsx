'use client';

import React, { useState, useEffect } from 'react';
import { TranscriptSegment } from '@/types';
import { formatDuration } from '@/lib/utils';
import { SpeakerCombobox } from './SpeakerCombobox';

interface SpeakerRowProps {
  segment: TranscriptSegment;
  index: number;
  onUpdate: (index: number, segment: TranscriptSegment) => void;
  // Connect this speaker to a participant. The parent adds `to` to the participant
  // list if it isn't one already, then renames every segment of `from` to `to`.
  onAssign: (from: string, to: string) => void;
  speakerSegmentCount: number;
  // Participants offered in the speaker picker (type-or-select).
  participants: string[];
  onSeek?: (time: number) => void;
  hasPii?: boolean;
  isHighlighted?: boolean;
  // Diarization is still running: show an uncertainty placeholder for the speaker
  // instead of the not-yet-meaningful default label, and don't offer rename yet.
  diarizing?: boolean;
}

export const SpeakerRow = React.memo(function SpeakerRow({
  segment,
  index,
  onUpdate,
  onAssign,
  speakerSegmentCount,
  participants,
  onSeek,
  hasPii,
  isHighlighted,
  diarizing,
}: SpeakerRowProps) {
  const [renameOpen, setRenameOpen] = useState(false);

  // Close the picker if diarization (re)starts under us.
  useEffect(() => {
    if (diarizing) setRenameOpen(false);
  }, [diarizing]);

  function assign(name: string) {
    const trimmed = name.trim();
    if (trimmed && trimmed !== segment.speaker) onAssign(segment.speaker, trimmed);
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
            title="Klik for at vælge eller skrive taler"
          >
            {segment.speaker}
          </button>
        )}

        {renameOpen && !diarizing && (
          <div
            className="absolute left-0 z-10 rounded-[var(--radius)] border border-[var(--line-strong)] bg-[var(--surface)] shadow-md"
            style={{ top: '100%', minWidth: 240, padding: '12px 14px' }}
          >
            <p className="font-medium text-[var(--ink)] mb-0.5" style={{ fontSize: 'var(--t-small)' }}>
              Hvem er {segment.speaker}?
            </p>
            <SpeakerCombobox
              currentSpeaker={segment.speaker}
              participants={participants}
              segmentCount={speakerSegmentCount}
              onAssign={assign}
              onClose={() => setRenameOpen(false)}
            />
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
