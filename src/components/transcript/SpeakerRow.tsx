'use client';

import React, { useState } from 'react';
import { TranscriptSegment } from '@/types';
import { formatDuration } from '@/lib/utils';

interface SpeakerRowProps {
  segment: TranscriptSegment;
  index: number;
  onUpdate: (index: number, segment: TranscriptSegment) => void;
}

export function SpeakerRow({ segment, index, onUpdate }: SpeakerRowProps) {
  const [editingSpeaker, setEditingSpeaker] = useState(false);
  const [speakerValue, setSpeakerValue] = useState(segment.speaker);

  function commitSpeaker() {
    setEditingSpeaker(false);
    if (speakerValue.trim()) {
      onUpdate(index, { ...segment, speaker: speakerValue.trim() });
    } else {
      setSpeakerValue(segment.speaker);
    }
  }

  function handleTextChange(text: string) {
    onUpdate(index, { ...segment, text });
  }

  return (
    <div className="flex gap-0 py-4">
      {/* Left rail: speaker + timestamp */}
      <div className="w-24 shrink-0 pr-4 pt-0.5">
        <span
          className="block text-[var(--muted)] tabular-nums mb-0.5"
          style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--t-micro)' }}
        >
          {formatDuration(segment.start)}
        </span>
        {editingSpeaker ? (
          <input
            className="w-full bg-transparent outline-none border-b border-[var(--accent)] text-[var(--ink)] pb-0.5"
            style={{ fontSize: 'var(--t-small)', fontWeight: 500 }}
            value={speakerValue}
            onChange={(e) => setSpeakerValue(e.target.value)}
            onBlur={commitSpeaker}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitSpeaker();
              if (e.key === 'Escape') {
                setSpeakerValue(segment.speaker);
                setEditingSpeaker(false);
              }
            }}
            autoFocus
          />
        ) : (
          <button
            className="text-[var(--ink-2)] hover:text-[var(--accent)] transition-colors text-left w-full truncate"
            style={{ fontSize: 'var(--t-small)', fontWeight: 500 }}
            onClick={() => setEditingSpeaker(true)}
            title="Klik for at redigere talerens navn"
          >
            {segment.speaker}
          </button>
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
}
