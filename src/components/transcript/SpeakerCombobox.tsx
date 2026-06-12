'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';

interface SpeakerComboboxProps {
  // The speaker label currently shown for this row (seeds the input).
  currentSpeaker: string;
  // Known participants, offered as a filtered dropdown as the user types.
  participants: string[];
  // Assign the speaker to this name. If the name isn't an existing participant,
  // the parent is responsible for adding it to the participant list.
  onAssign: (name: string) => void;
  onClose: () => void;
  // How many segments carry this speaker — shown so the user knows the blast radius.
  segmentCount?: number;
  autoFocus?: boolean;
}

// A type-or-pick control: free-text input over a live-filtered list of participants.
// Picking a participant connects the speaker to that person; typing a name that
// isn't in the list offers to add it as a new participant. Used both in the
// per-row rename popover and the inline "assign this speaker" prompt, so the
// interaction is identical wherever a speaker gets connected to a participant.
export function SpeakerCombobox({
  currentSpeaker,
  participants,
  onAssign,
  onClose,
  segmentCount,
  autoFocus = true,
}: SpeakerComboboxProps) {
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) setTimeout(() => inputRef.current?.focus(), 0);
  }, [autoFocus]);

  const trimmed = query.trim();
  // One pass over participants: collect matches and note whether the typed name is
  // already an exact entry (which suppresses the "add new" row).
  const { filtered, showAddNew } = useMemo(() => {
    const lower = trimmed.toLowerCase();
    const matches: string[] = [];
    let exact = false;
    for (const p of participants) {
      const pl = p.toLowerCase();
      if (pl === lower) exact = true;
      if (pl.includes(lower) && p !== currentSpeaker) matches.push(p);
    }
    return { filtered: matches, showAddNew: trimmed.length > 0 && !exact };
  }, [participants, trimmed, currentSpeaker]);

  // Flat list of selectable options for keyboard navigation: participants first,
  // then the optional "add new" row.
  const optionCount = filtered.length + (showAddNew ? 1 : 0);

  function choose(index: number) {
    if (showAddNew && index === filtered.length) onAssign(trimmed);
    else onAssign(filtered[index]);
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, Math.max(0, optionCount - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (optionCount > 0) choose(highlight);
      else if (trimmed) { onAssign(trimmed); onClose(); }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  // Keep the highlight in range as the filtered list shrinks/grows.
  useEffect(() => { setHighlight(0); }, [query]);

  return (
    <div onKeyDown={onKeyDown}>
      {segmentCount !== undefined && (
        <p className="text-[var(--muted)] mb-2" style={{ fontSize: 'var(--t-micro)' }}>
          Bruges i {segmentCount} {segmentCount === 1 ? 'segment' : 'segmenter'}
        </p>
      )}
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="søg eller skriv navn…"
        className="w-full border border-[var(--line-strong)] rounded-[var(--radius-sm)] px-2 py-1.5 bg-[var(--surface)] text-[var(--ink)] outline-none focus:border-[var(--accent)]"
        style={{ fontSize: 'var(--t-small)' }}
      />

      {(filtered.length > 0 || showAddNew) && (
        <div
          role="listbox"
          className="mt-2 max-h-44 overflow-y-auto rounded-[var(--radius-sm)] border border-[var(--line)]"
        >
          {filtered.map((name, i) => (
            <button
              key={name}
              role="option"
              aria-selected={highlight === i}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => choose(i)}
              className="block w-full text-left px-2.5 py-1.5 truncate transition-colors"
              style={{
                fontSize: 'var(--t-small)',
                color: 'var(--ink-2)',
                background: highlight === i ? 'var(--accent-wash)' : 'transparent',
              }}
            >
              {name}
            </button>
          ))}
          {showAddNew && (
            <button
              role="option"
              aria-selected={highlight === filtered.length}
              onMouseEnter={() => setHighlight(filtered.length)}
              onClick={() => choose(filtered.length)}
              className="block w-full text-left px-2.5 py-1.5 truncate transition-colors"
              style={{
                fontSize: 'var(--t-small)',
                color: 'var(--accent)',
                background: highlight === filtered.length ? 'var(--accent-wash)' : 'transparent',
                borderTop: filtered.length > 0 ? '1px solid var(--line)' : undefined,
              }}
            >
              + Tilføj &quot;{trimmed}&quot; som deltager
            </button>
          )}
        </div>
      )}
    </div>
  );
}
