'use client';

import React, { useState } from 'react';
import { SpeakerCombobox } from './SpeakerCombobox';

// A diarized voice still labelled "Taler N", with its representative soundbite.
export interface VoiceBite {
  speaker: string;
  start: number;
  end: number;
}

// One participant, classified against the current segments:
//  - 'recognized': their name is a segment speaker (a voice is linked); has a soundbite.
//  - 'pending':    in the roster, no voice yet, not marked silent.
//  - 'silent':     confirmed "talte ikke" (present but never spoke).
export interface ParticipantRow {
  name: string;
  kind: 'recognized' | 'pending' | 'silent';
  start?: number;
  end?: number;
}

interface SpeakerAssignmentProps {
  rows: ParticipantRow[];
  // Voices nobody is linked to yet (the "Taler N" leftovers).
  voices: VoiceBite[];
  // Participants without a voice — the candidates when naming a leftover voice.
  voicelessParticipants: string[];
  recognizedCount: number;
  totalVoices: number;
  // Diarization still running: voices aren't known yet, so the matcher shows a
  // recognising state but still lets the user build the participant roster.
  diarizing?: boolean;
  onLink: (voiceLabel: string, name: string) => void;
  onMarkSilent: (name: string) => void;
  onUnlink: (name: string) => void;
  onRemove: (name: string) => void;
  onRename: (oldName: string, newName: string) => void;
  onAdd: (name: string) => void;
  onPlaySegment?: (start: number, end: number) => void;
  // The soundbite currently playing, so its button shows a pause icon instead.
  playingSegment?: { start: number; end: number } | null;
}

// Play triangle, or pause bars when this soundbite is the one currently playing.
// The colour comes from the parent (.sa-play vs .sa-play2).
function BiteIcon({ playing }: { playing: boolean }) {
  return playing ? <span className="bars"><i /><i /></span> : <span className="tri" />;
}

// A participant name that becomes editable on click (rename in place), mirroring
// the chapter-title editing pattern. Commits on blur/Enter; Escape reverts.
function EditableName({ name, onRename }: { name: string; onRename: (oldName: string, newName: string) => void }) {
  return (
    <span
      className="sa-name sa-name-edit"
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      title="Klik for at omdøbe"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
        else if (e.key === 'Escape') { e.currentTarget.textContent = name; e.currentTarget.blur(); }
      }}
      onBlur={(e) => {
        const t = e.currentTarget.textContent?.trim() ?? '';
        if (t && t !== name) onRename(name, t);
        else e.currentTarget.textContent = name;
      }}
    >
      {name}
    </span>
  );
}

// The participant-first speaker matcher: one row per person, each pending person
// carries an inline "tildel stemme" dropdown of unmatched voices (with soundbite
// preview). Linking a voice relabels its segments to that person — keeping the
// diarization output and the referat roster in one connected list. Leftover voices
// nobody claimed surface in a small secondary section only once everyone is placed.
export function SpeakerAssignment({
  rows,
  voices,
  voicelessParticipants,
  recognizedCount,
  totalVoices,
  diarizing,
  onLink,
  onMarkSilent,
  onUnlink,
  onRemove,
  onRename,
  onAdd,
  onPlaySegment,
  playingSegment,
}: SpeakerAssignmentProps) {
  // Only one dropdown / naming box open at a time.
  const [openName, setOpenName] = useState<string | null>(null);
  const [leftoverVoice, setLeftoverVoice] = useState<string | null>(null);
  const [addInput, setAddInput] = useState('');
  // Leftover unknown voices are collapsed by default — they're a rare edge.
  const [showLeftover, setShowLeftover] = useState(false);

  const pct = totalVoices > 0 ? (recognizedCount / totalVoices) * 100 : 0;
  const hasPending = rows.some((r) => r.kind === 'pending');
  // No audio (e.g. it was deleted after the referat was generated) → speaker
  // assignment is transcript-based only: hide the soundbite play affordances
  // rather than show clips that can't play.
  const hasAudio = onPlaySegment != null;

  // Is this exact soundbite the one currently playing? (Drives the pause icon.)
  const bitePlaying = (start?: number, end?: number) =>
    playingSegment != null && start === playingSegment.start && end === playingSegment.end;

  function play(e: React.MouseEvent, start?: number, end?: number) {
    e.stopPropagation();
    if (onPlaySegment && start !== undefined && end !== undefined) onPlaySegment(start, end);
  }

  function commitAdd() {
    const t = addInput.trim();
    if (!t) return;
    onAdd(t);
    setAddInput('');
  }

  // Add-a-participant footer — shared between the loading and ready states.
  const addFooter = (
    <div className="sa-foot">
      <input
        value={addInput}
        onChange={(e) => setAddInput(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitAdd(); } }}
        placeholder="tilføj deltager…"
      />
      {addInput.trim() && (
        <button type="button" onClick={commitAdd}>+ tilføj</button>
      )}
    </div>
  );

  // While diarization is still running the voices aren't known, so show a recognising
  // state — but keep the roster editable so the user can add participants meanwhile.
  if (diarizing) {
    return (
      <div>
        <div className="sa-head">
          <div className="sa-eyebrow">deltagere</div>
          <div className="sa-prog sa-loading"><span className="sa-spin" /> genkender stemmer…</div>
        </div>
        <div className="sa-progbar indet"><i /></div>
        {rows.length > 0 && (
          <div className="sa-list">
            {rows.map((row) => (
              <div className="sa-row unnamed" key={row.name}>
                <span className="sa-dot" />
                <EditableName name={row.name} onRename={onRename} />
                <button type="button" className="sa-x" title="Fjern deltager" onClick={() => onRemove(row.name)}>×</button>
              </div>
            ))}
          </div>
        )}
        {addFooter}
        <div className="sa-hint">Du kan tilføje deltagere nu — stemmer kan tildeles, så snart de er genkendt.</div>
      </div>
    );
  }

  // The voice picker shown under a pending/silent row.
  function voiceDropdown(name: string, isSilent: boolean) {
    return (
      <div className="sa-drop">
        <div className="sa-drop-h">{hasAudio ? `afspil og vælg ${name}s stemme` : `vælg ${name}s stemme`}</div>
        {voices.length > 0 ? (
          voices.map((v) => (
            <button
              key={v.speaker}
              type="button"
              className="sa-opt"
              onClick={() => { onLink(v.speaker, name); setOpenName(null); }}
            >
              {hasAudio && (
                <span
                  className="sa-play2"
                  role="button"
                  aria-label={bitePlaying(v.start, v.end) ? `Pause ${v.speaker}` : `Afspil ${v.speaker}`}
                  title={bitePlaying(v.start, v.end) ? 'Pause' : 'Afspil'}
                  onClick={(e) => play(e, v.start, v.end)}
                >
                  <BiteIcon playing={bitePlaying(v.start, v.end)} />
                </span>
              )}
              <span>{v.speaker}</span>
              <span className="pick">vælg</span>
            </button>
          ))
        ) : (
          <div className="sa-drop-empty">ingen ukendte stemmer tilbage</div>
        )}
        <button
          type="button"
          className="sa-opt none"
          onClick={() => { onMarkSilent(name); setOpenName(null); }}
        >
          {isSilent ? 'forbliv “talte ikke”' : 'talte ikke'}
        </button>
      </div>
    );
  }

  function participantRow(row: ParticipantRow) {
    const open = openName === row.name;

    if (row.kind === 'recognized') {
      const playing = bitePlaying(row.start, row.end);
      return (
        <div key={row.name} className="sa-row named">
          <span className="sa-dot" />
          <EditableName name={row.name} onRename={onRename} />
          {onPlaySegment && row.start !== undefined && (
            <button
              type="button"
              className="sa-play"
              title={playing ? 'Pause' : `Afspil ${row.name}s stemme`}
              onClick={(e) => play(e, row.start, row.end)}
            >
              <BiteIcon playing={playing} />
            </button>
          )}
          <button
            type="button"
            className="sa-trigger sa-hover"
            title="Frakobl stemmen (behold deltager)"
            onClick={() => onUnlink(row.name)}
          >frakobl</button>
          <button
            type="button"
            className="sa-x"
            title="Fjern deltager"
            onClick={() => onRemove(row.name)}
          >×</button>
        </div>
      );
    }

    if (row.kind === 'silent') {
      return (
        <React.Fragment key={row.name}>
          <div className="sa-row unnamed">
            <span className="sa-dot" />
            <EditableName name={row.name} onRename={onRename} />
            <span className="sa-tag">talte ikke</span>
            <button
              type="button"
              className="sa-trigger"
              onClick={() => setOpenName(open ? null : row.name)}
            >knyt stemme {open ? '▴' : '▾'}</button>
            <button
              type="button"
              className="sa-x"
              title="Fjern deltager"
              onClick={() => onRemove(row.name)}
            >×</button>
          </div>
          {open && voiceDropdown(row.name, true)}
        </React.Fragment>
      );
    }

    // pending
    return (
      <React.Fragment key={row.name}>
        <div className="sa-row pending unnamed">
          <span className="sa-dot" />
          <EditableName name={row.name} onRename={onRename} />
          <button
            type="button"
            className="sa-trigger primary"
            onClick={() => setOpenName(open ? null : row.name)}
          >tildel stemme {open ? '▴' : '▾'}</button>
          <button
            type="button"
            className="sa-x"
            title="Fjern deltager"
            onClick={() => onRemove(row.name)}
          >×</button>
        </div>
        {open && voiceDropdown(row.name, false)}
      </React.Fragment>
    );
  }

  return (
    <div>
      <div className="sa-head">
        <div className="sa-eyebrow">deltagere</div>
        <div className="sa-prog">{recognizedCount} / {totalVoices} stemmer genkendt</div>
      </div>
      <div className="sa-progbar"><i style={{ width: `${pct}%` }} /></div>

      {voices.length === 0 && totalVoices > 0 && (
        <div className="sa-status"><span className="ck">✓</span> alle stemmer er genkendt</div>
      )}

      <div className="sa-list">
        {rows.map(participantRow)}
      </div>

      {/* Leftover unknown voices — only once every participant is placed, so the
          machine's "Taler N" labels never lead the view. Collapsed by default. */}
      {!hasPending && voices.length > 0 && (
        <div>
          <button
            type="button"
            className="sa-sub"
            aria-expanded={showLeftover}
            onClick={() => setShowLeftover((v) => !v)}
          >
            ukendte stemmer · {voices.length} <span aria-hidden>{showLeftover ? '▾' : '▸'}</span>
          </button>
          {showLeftover && voices.map((v) => {
            const naming = leftoverVoice === v.speaker;
            return (
              <React.Fragment key={v.speaker}>
                <div className="sa-row unnamed">
                  <span className="sa-dot" />
                  {onPlaySegment && (
                    <button type="button" className="sa-play" title={bitePlaying(v.start, v.end) ? 'Pause' : 'Afspil'} onClick={(e) => play(e, v.start, v.end)}>
                      <BiteIcon playing={bitePlaying(v.start, v.end)} />
                    </button>
                  )}
                  <span className="sa-name">{v.speaker}</span>
                  <button
                    type="button"
                    className="sa-act"
                    onClick={() => setLeftoverVoice(naming ? null : v.speaker)}
                  >{naming ? 'luk' : 'navngiv →'}</button>
                </div>
                {naming && (
                  <div className="sa-namebox">
                    <SpeakerCombobox
                      currentSpeaker={v.speaker}
                      participants={voicelessParticipants}
                      onAssign={(name) => { onLink(v.speaker, name); setLeftoverVoice(null); }}
                      onClose={() => setLeftoverVoice(null)}
                    />
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>
      )}

      {/* Add a participant (joins the roster as "talte ikke" until linked). */}
      {addFooter}
    </div>
  );
}
