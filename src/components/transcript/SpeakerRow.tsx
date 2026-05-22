'use client';

import React, { useState } from 'react';
import { TranscriptSegment } from '@/types';
import { formatDuration } from '@/lib/utils';
import { Textarea } from '@/components/ui/textarea';

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
    <div className="flex gap-4 py-4 border-b border-[var(--border)] last:border-0">
      {/* Time + speaker */}
      <div className="w-32 flex-shrink-0 pt-1">
        <span className="block text-xs text-[var(--text-muted)] font-mono tabular-nums mb-1">
          {formatDuration(segment.start)}
        </span>
        {editingSpeaker ? (
          <input
            className="w-full text-xs font-medium border-b border-[var(--accent)] bg-transparent text-[var(--text)] outline-none pb-0.5"
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
            className="text-xs font-medium text-[var(--text-2)] hover:text-[var(--accent)] transition-colors text-left w-full"
            onClick={() => setEditingSpeaker(true)}
            title="Klik for at redigere talerens navn"
          >
            {segment.speaker}
          </button>
        )}
      </div>

      {/* Transcript text */}
      <div className="flex-1">
        <Textarea
          value={segment.text}
          onChange={(e) => handleTextChange(e.target.value)}
          className="min-h-[60px] text-sm leading-relaxed border-transparent bg-transparent hover:bg-[var(--surface-2)] focus:bg-[var(--surface)] resize-none"
          rows={Math.max(2, Math.ceil(segment.text.length / 80))}
        />
      </div>
    </div>
  );
}
